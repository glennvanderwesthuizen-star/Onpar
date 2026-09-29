import { Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { describePattern, parsePattern, patternErrors, sastDate, saPublicHolidays, weekStart } from '@onpar/rules';
import { z } from 'zod';
import { assertSiteAccess, CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody, throwIfErrors, uuid } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { RosterService } from './roster.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date.');

const PatternBody = z.object({ name: z.string().trim(), sequence: z.string(), active: z.boolean().default(true) });

const AllocateBody = z.object({
  employeeId: uuid,
  siteId: uuid,
  patternId: uuid,
  startDate: isoDate,
  position: z.number().int().min(1),
  dayShiftId: uuid.nullish(),
  nightShiftId: uuid.nullish(),
  reason: z.string().trim().max(500).optional(),
});

const ChangeBody = z
  .object({
    employeeId: uuid,
    date: isoDate.nullish(),
    weekday: z.number().int().min(0).max(6).nullish(),
    fromDate: isoDate.nullish(),
    untilDate: isoDate.nullish(),
    shiftId: uuid.nullable(),
    note: z.string().trim().max(500).default(''),
  })
  .refine((c) => (c.date ? c.weekday == null : c.weekday != null && !!c.fromDate), {
    message: 'Choose either a single date, or a day of the week with a start date.',
    path: ['date'],
  })
  .refine((c) => !c.untilDate || !c.fromDate || c.untilDate >= c.fromDate, { message: 'The end date must be after the start date.', path: ['untilDate'] });

const RequirementBody = z.object({
  shiftId: uuid,
  date: isoDate,
  guards: z.number().int().min(0).max(999).nullable(),
  note: z.string().trim().max(500).default(''),
});

const HolidayBody = z.object({ date: isoDate, name: z.string().trim().min(1, 'Give the holiday a name.').max(100) });

/** Shift patterns and rostering (sections 31, 36 to 40; D-19, D-20, D-25). */
@Controller('roster')
@UseGuards(UserAuthGuard)
export class RosterController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly roster: RosterService,
  ) {}

  // Patterns ---------------------------------------------------------------------

  @Get('patterns')
  @RequirePermission('roster.view')
  patterns(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, (tx) => this.listPatterns(tx));
  }

  @Post('patterns')
  @RequirePermission('roster.patterns')
  createPattern(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const p = this.validPattern(body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.assertPatternName(tx, p.name, null);
      const number = (await tx.query('SELECT coalesce(max(number), 0) + 1 AS n FROM shift_patterns')).rows[0].n;
      if (number > 99) throw new ConflictException('A company can have at most 99 patterns.');
      const id = (
        await tx.query(`INSERT INTO shift_patterns (company_id, number, name, sequence, active) VALUES (app_company_id(), $1, $2, $3, $4) RETURNING id`, [
          number,
          p.name,
          p.sequence,
          p.active,
        ])
      ).rows[0].id;
      await this.audit.byUser(tx, user, { action: 'roster.pattern_create', entityType: 'shift_pattern', entityId: id, after: p });
      return (await this.listPatterns(tx)).find((x) => x.id === id);
    });
  }

  /** Editing a pattern changes the computed shifts of everyone on it from now on, so it is checked for rest clashes. */
  @Put('patterns/:id')
  @RequirePermission('roster.patterns')
  updatePattern(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const p = this.validPattern(body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const before = (await tx.query('SELECT name, sequence, active FROM shift_patterns WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw new NotFoundException('Pattern not found.');
      await this.assertPatternName(tx, p.name, id);
      const users = (await tx.query('SELECT count(*)::int AS n, max(position) AS "maxPosition" FROM roster_allocations WHERE pattern_id = $1 AND end_date IS NULL', [id])).rows[0];
      if (users.maxPosition > p.sequence.length) {
        throw new ConflictException(`Someone starts at position ${users.maxPosition} on this pattern, so it cannot be shorter than ${users.maxPosition} days.`);
      }
      await tx.query('UPDATE shift_patterns SET name = $2, sequence = $3, active = $4 WHERE id = $1', [id, p.name, p.sequence, p.active]);
      await this.audit.byUser(tx, user, { action: 'roster.pattern_update', entityType: 'shift_pattern', entityId: id, before, after: p });
      return (await this.listPatterns(tx)).find((x) => x.id === id);
    });
  }

  private validPattern(body: unknown) {
    const b = parseBody(PatternBody, body);
    const sequence = parsePattern(b.sequence);
    throwIfErrors(patternErrors({ name: b.name, sequence }));
    return { name: b.name, sequence, active: b.active };
  }

  private async assertPatternName(tx: Tx, name: string, exceptId: string | null) {
    const clash = await tx.query('SELECT 1 FROM shift_patterns WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2', [name, exceptId]);
    if (clash.rowCount) throw new ConflictException({ message: 'A pattern with this name already exists.', errors: { name: 'A pattern with this name already exists.' } });
  }

  private async listPatterns(tx: Tx) {
    return (
      await tx.query(
        `SELECT p.id, p.number, p.name, p.sequence, p.active,
                (SELECT count(*)::int FROM roster_allocations a WHERE a.pattern_id = p.id AND a.end_date IS NULL) AS "inUse"
           FROM shift_patterns p ORDER BY p.number`,
      )
    ).rows.map((p) => ({ ...p, code: String(p.number).padStart(2, '0'), description: describePattern(p.sequence) }));
  }

  // The site table ---------------------------------------------------------------

  /** The week (Monday to Sunday) containing `from`, for one site. */
  @Get('sites/:siteId/week')
  @RequirePermission('roster.view')
  week(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Query('from') from?: string) {
    const start = weekStart(from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : sastDate(new Date()));
    return this.db.withTenant(user.companyId, (tx) => this.roster.siteWeek(tx, user, siteId, start));
  }

  /** Every shift at the sites the user may roster, for choosing where a guard works on a changed day. */
  @Get('shifts')
  @RequirePermission('roster.view')
  shifts(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) =>
      (
        await tx.query(
          `SELECT sh.id, sh.name, sh.kind, to_char(sh.start_time, 'HH24:MI') AS "startTime", to_char(sh.end_time, 'HH24:MI') AS "endTime",
                  s.id AS "siteId", s.name AS "siteName"
             FROM site_shifts sh JOIN sites s ON s.id = sh.site_id
            WHERE ($1::uuid[] IS NULL OR s.id = ANY($1::uuid[])) ORDER BY lower(s.name), sh.sort_order`,
          [user.siteIds],
        )
      ).rows,
    );
  }

  /** Everyone who can be rostered, with where they are rostered on a date, for the allocate and change pickers. */
  @Get('people')
  @RequirePermission('roster.manage')
  people(@CurrentUser() user: UserPrincipal, @Query('date') date?: string) {
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : sastDate(new Date());
    return this.db.withTenant(user.companyId, async (tx) => {
      const people = (
        await tx.query(
          `SELECT e.id, e.full_name AS name, e.employee_number AS "employeeNumber", e.psira_grade AS grade,
                  e.home_site_id AS "homeSiteId", hs.name AS "homeSiteName", a.site_id AS "allocatedSiteId", s.name AS "allocatedSiteName"
             FROM employees e JOIN sites hs ON hs.id = e.home_site_id
             LEFT JOIN roster_allocations a ON a.employee_id = e.id AND a.end_date IS NULL
             LEFT JOIN sites s ON s.id = a.site_id
            WHERE e.status = 'active' ORDER BY lower(e.full_name)`,
        )
      ).rows;
      const days = await this.roster.days(tx, people.map((p) => p.id), day, day);
      const names = new Map((await tx.query('SELECT id, name FROM sites')).rows.map((s) => [s.id, s.name]));
      return people.map((p) => {
        const d = days.get(p.id)![0];
        return { ...p, on: { status: d.status, siteName: d.siteId ? names.get(d.siteId) : null, shiftName: d.status === 'working' ? d.shiftName : null } };
      });
    });
  }

  /** Warnings before allocating: moving them off another site, grade and firearm (sections 38 and 39). */
  @Get('allocation-check')
  @RequirePermission('roster.manage')
  check(@CurrentUser() user: UserPrincipal, @Query('employeeId', ParseUUIDPipe) employeeId: string, @Query('siteId', ParseUUIDPipe) siteId: string) {
    assertSiteAccess(user, siteId);
    return this.db.withTenant(user.companyId, (tx) => this.roster.allocationCheck(tx, employeeId, siteId));
  }

  @Post('allocations')
  @RequirePermission('roster.manage')
  allocate(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const b = parseBody(AllocateBody, body);
    return this.db.withTenant(user.companyId, (tx) => this.roster.allocate(tx, user, b));
  }

  @Post('allocations/:id/end')
  @RequirePermission('roster.manage')
  endAllocation(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(z.object({ endDate: isoDate }), body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.roster.endAllocation(tx, user, id, b.endDate);
      return { ok: true };
    });
  }

  @Post('changes')
  @RequirePermission('roster.manage')
  addChange(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const b = parseBody(ChangeBody, body);
    return this.db.withTenant(user.companyId, (tx) => this.roster.addChange(tx, user, b));
  }

  @Delete('changes/:id')
  @RequirePermission('roster.manage')
  removeChange(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.roster.removeChange(tx, user, id);
      return { ok: true };
    });
  }

  /** A different number of guards for one shift on one date; `guards: null` goes back to the normal figure. */
  @Put('requirements')
  @RequirePermission('roster.manage')
  requirement(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const b = parseBody(RequirementBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const s = (await tx.query('SELECT site_id FROM site_shifts WHERE id = $1', [b.shiftId])).rows[0];
      if (!s) throw new NotFoundException('Shift not found.');
      assertSiteAccess(user, s.site_id);
      const before = (await tx.query('DELETE FROM site_requirement_changes WHERE shift_id = $1 AND date = $2 RETURNING guards, note', [b.shiftId, b.date])).rows[0];
      if (b.guards !== null) {
        await tx.query(
          `INSERT INTO site_requirement_changes (company_id, shift_id, date, guards, note, created_by) VALUES (app_company_id(), $1, $2, $3, $4, $5)`,
          [b.shiftId, b.date, b.guards, b.note, user.userId],
        );
      }
      await this.audit.byUser(tx, user, { action: 'roster.requirement', entityType: 'site_shift', entityId: b.shiftId, before: before ?? undefined, after: b, reason: b.note || null });
      return { ok: true };
    });
  }

  /** Clash warnings across the company (the second safety net of section 38). */
  @Get('clashes')
  @RequirePermission('roster.view')
  clashes(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const all = await this.roster.allocationClashes(tx);
      return user.siteIds ? all.filter((c) => c.siteIds.some((s: string) => user.siteIds!.includes(s))) : all;
    });
  }

  // Public holidays --------------------------------------------------------------

  @Get('holidays')
  @RequirePermission('roster.view')
  holidays(@CurrentUser() user: UserPrincipal, @Query('year') year?: string) {
    const y = Number(year) || Number(sastDate(new Date()).slice(0, 4));
    return this.db.withTenant(user.companyId, async (tx) => {
      const extra = (await tx.query(`SELECT date, name FROM company_holidays WHERE extract(year FROM date) = $1 ORDER BY date`, [y])).rows;
      return {
        year: y,
        statutory: [...saPublicHolidays(y)].sort(),
        added: extra,
      };
    });
  }

  @Post('holidays')
  @RequirePermission('roster.patterns')
  addHoliday(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const b = parseBody(HolidayBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await tx.query(
        `INSERT INTO company_holidays (company_id, date, name) VALUES (app_company_id(), $1, $2) ON CONFLICT (company_id, date) DO UPDATE SET name = $2`,
        [b.date, b.name],
      );
      await this.audit.byUser(tx, user, { action: 'roster.holiday_add', entityType: 'company', after: b });
      return { ok: true };
    });
  }

  @Delete('holidays/:date')
  @RequirePermission('roster.patterns')
  removeHoliday(@CurrentUser() user: UserPrincipal, @Param('date') date: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const r = (await tx.query('DELETE FROM company_holidays WHERE date = $1 RETURNING date, name', [date])).rows[0];
      if (!r) throw new NotFoundException('Holiday not found.');
      await this.audit.byUser(tx, user, { action: 'roster.holiday_remove', entityType: 'company', before: r });
      return { ok: true };
    });
  }
}

