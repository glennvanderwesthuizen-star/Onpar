import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { bobWireMonthsTo, INSIGNIA_LABELS, mergeWire, sastDate, WIRE_RULES, WireRule, wireSettingsErrors } from '@onpar/rules';
import { z } from 'zod';
import { CurrentGuard, CurrentUser, GuardOrSelfAuthGuard, GuardPrincipal, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody, throwIfErrors } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { monthsFrom, WireService } from './wire.service';

const ProfileBody = z.object({
  joinedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the date he joined.'),
  recruitmentScore: z.number().int().min(0).max(100).nullable().default(null),
  showName: z.boolean().default(false),
});
const SimBody = z.object({ settings: z.unknown(), from: z.string().regex(/^\d{4}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}$/) });

const MONTH = /^\d{4}-\d{2}$/;
const rulesList = Object.entries(WIRE_RULES).map(([key, label]) => ({ key, label }));

/** The Wire for managers: the owner's calibration page (owner, 8 Oct 2026). */
@Controller('wire')
@UseGuards(UserAuthGuard)
export class WireController {
  constructor(
    private readonly db: DbService,
    private readonly wire: WireService,
    private readonly audit: AuditService,
  ) {}

  /** Every guard's Wire with his pace and forecast, the barbs by source per month, and the values in force. */
  @Get()
  @RequirePermission('wire.view')
  overview(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const { settings, startedOn } = await this.wire.settings(tx);
      const ids = (
        await tx.query(
          `SELECT e.id FROM employees e WHERE ($1::uuid[] IS NULL OR e.home_site_id = ANY($1::uuid[]))
              AND (e.status = 'active' OR EXISTS (SELECT 1 FROM wire_entries w WHERE w.employee_id = e.id))`,
          [user.siteIds],
        )
      ).rows.map((r) => r.id as string);
      const sites = new Map((await tx.query(`SELECT e.id, e.employee_number, e.status, s.name FROM employees e JOIN sites s ON s.id = e.home_site_id WHERE e.id = ANY($1::uuid[])`, [ids])).rows.map((r) => [r.id, r]));
      const guards = [];
      for (const id of ids) {
        const g = (await this.wire.guard(tx, id))!;
        const { entries: _e, ...rest } = g;
        guards.push({ ...rest, employeeNumber: sites.get(id)?.employee_number, site: sites.get(id)?.name, active: sites.get(id)?.status === 'active' });
      }
      guards.sort((a, b) => a.name.localeCompare(b.name));
      const bySource = (
        await tx.query(
          `SELECT to_char(w.entry_date, 'YYYY-MM') AS month, w.rule, sum(w.barbs)::int AS barbs
             FROM wire_entries w JOIN employees e ON e.id = w.employee_id
            WHERE w.kind = 'earned' AND ($1::uuid[] IS NULL OR e.home_site_id = ANY($1::uuid[]))
            GROUP BY 1, 2 ORDER BY 1`,
          [user.siteIds],
        )
      ).rows as { month: string; rule: WireRule; barbs: number }[];
      const months = [...new Set(bySource.map((r) => r.month))];
      // Bob Wire, on the shifts guards really work: the fastest anyone can reach silver and gold.
      const shifts = (
        await tx.query(
          `SELECT coalesce(round(avg(worked)), 20)::int AS n FROM (SELECT (facts->>'rostered')::int AS worked FROM wire_months WHERE (facts->>'rostered')::int > 0) x`,
        )
      ).rows[0].n as number;
      return {
        startedOn,
        today: sastDate(new Date()),
        settings,
        canManage: user.role === 'system_admin',
        rules: rulesList,
        insignia: INSIGNIA_LABELS,
        guards,
        months: months.map((m) => ({ month: m, bySource: Object.fromEntries(bySource.filter((r) => r.month === m).map((r) => [r.rule, r.barbs])), total: bySource.filter((r) => r.month === m).reduce((a, r) => a + r.barbs, 0) })),
        bob: { shifts, monthsToSilver: bobWireMonthsTo(settings.silver, shifts, settings), monthsToGold: bobWireMonthsTo(settings.gold, shifts, settings) },
      };
    });
  }

  @Get('guards/:id')
  @RequirePermission('wire.view')
  guard(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.assertGuard(tx, user, id);
      return this.wire.guard(tx, id);
    });
  }

  /** Changes the values. They apply from the next shift and month-end run; barbs already earned stay as they are. */
  @Put('settings')
  @RequirePermission('wire.manage')
  saveSettings(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const { startedOn, ...values } = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const next = mergeWire(values);
    throwIfErrors(wireSettingsErrors(next));
    if (startedOn !== undefined && (typeof startedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startedOn) || startedOn > sastDate(new Date()))) {
      throw new BadRequestException({ message: 'Choose the day The Wire started, today or earlier.', errors: { startedOn: 'Today or earlier.' } });
    }
    return this.db.withTenant(user.companyId, async (tx) => {
      const before = await this.wire.settings(tx);
      await tx.query('UPDATE wire_settings SET config = $1, started_on = coalesce($3::date, started_on), updated_by = $2, updated_at = now()', [JSON.stringify(next), user.userId, startedOn ?? null]);
      await this.audit.byUser(tx, user, { action: 'wire.settings_update', entityType: 'wire_settings', entityId: user.companyId, before: { ...before.settings, startedOn: before.startedOn }, after: { ...next, startedOn: startedOn ?? before.startedOn } });
      return (await this.wire.settings(tx)).settings;
    });
  }

  /** When he joined, his recruitment score and whether his name may be shown. Entry barbs are paid once, the first time a score is given. */
  @Put('guards/:id/profile')
  @RequirePermission('wire.manage')
  saveProfile(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(ProfileBody, body);
    if (b.joinedOn > sastDate(new Date())) throw new BadRequestException({ message: 'The date he joined cannot be in the future.', errors: { joinedOn: 'In the future.' } });
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.assertGuard(tx, user, id);
      const before = (await tx.query('SELECT joined_on, recruitment_score, show_name FROM wire_profiles WHERE employee_id = $1', [id])).rows[0] ?? null;
      await tx.query(
        `INSERT INTO wire_profiles (employee_id, company_id, joined_on, recruitment_score, show_name, updated_by) VALUES ($1, app_company_id(), $2, $3, $4, $5)
         ON CONFLICT (employee_id) DO UPDATE SET joined_on = excluded.joined_on, recruitment_score = excluded.recruitment_score, show_name = excluded.show_name,
                                                 updated_by = excluded.updated_by, updated_at = now()`,
        [id, b.joinedOn, b.recruitmentScore, b.showName, user.userId],
      );
      await this.wire.entry(tx, id, user.userId);
      await this.audit.byUser(tx, user, { action: 'wire.profile_update', entityType: 'employee', entityId: id, before, after: b });
      return this.wire.guard(tx, id);
    });
  }

  /** "What if": the real months replayed under other values. Writes nothing. */
  @Post('simulate')
  @RequirePermission('wire.view')
  @HttpCode(200)
  simulate(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const b = parseBody(SimBody, body);
    if (b.to < b.from) throw new BadRequestException('The last month must not be before the first.');
    const proposed = mergeWire(b.settings);
    throwIfErrors(wireSettingsErrors(proposed));
    return this.db.withTenant(user.companyId, (tx) => this.wire.simulate(tx, proposed, b.from, b.to, user.siteIds));
  }

  /** Runs the engine now instead of waiting for the next quarter hour. */
  @Post('run')
  @RequirePermission('wire.manage')
  @HttpCode(200)
  run(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, (tx) => this.wire.sweep(tx));
  }

  @Get('months')
  @RequirePermission('wire.view')
  months(@CurrentUser() user: UserPrincipal, @Query('from') from?: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const { startedOn } = await this.wire.settings(tx);
      const start = from && MONTH.test(from) ? from : startedOn.slice(0, 7);
      return monthsFrom(start, sastDate(new Date()).slice(0, 7));
    });
  }

  private async assertGuard(tx: Tx, user: UserPrincipal, id: string) {
    const e = (await tx.query('SELECT home_site_id FROM employees WHERE id = $1', [id])).rows[0];
    if (!e || (user.siteIds && !user.siteIds.includes(e.home_site_id))) throw new NotFoundException('Guard not found.');
  }
}

/** My Wire on the guard's phone: only what he has earned and what is still open to him. */
@Controller('device/wire')
@UseGuards(GuardOrSelfAuthGuard)
export class GuardWireController {
  constructor(
    private readonly db: DbService,
    private readonly wire: WireService,
  ) {}

  @Get()
  mine(@CurrentGuard() guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      const g = await this.wire.guard(tx, guard.employeeId);
      if (!g) throw new NotFoundException('Not found.');
      const { settings } = await this.wire.settings(tx);
      // No rand values, no scores of others, nothing negative.
      return {
        insignia: g.insignia,
        insigniaLabel: INSIGNIA_LABELS[g.insignia],
        wireTotal: g.wireTotal,
        available: g.available,
        barbsDrawn: Math.floor(g.wireTotal / 100),
        thisMonth: { total: g.thisMonth.total, bySource: Object.entries(g.thisMonth.bySource).map(([rule, barbs]) => ({ rule, label: WIRE_RULES[rule as WireRule], barbs })) },
        streak: g.streak,
        next: { name: g.next.name, toGo: g.next.toGo, months: g.next.months },
        months: g.months.slice(0, 6).map((m) => ({ month: m.month, barbs: m.barbs, award: m.award })),
        perShift: settings.barbs.readyForDuty + settings.barbs.dutiesComplete + settings.barbs.cleanHandover,
        readyLeadMinutes: settings.readyLeadMinutes,
        recent: g.entries.slice(0, 15).filter((e) => e.kind === 'earned').map((e) => ({ date: e.date, label: WIRE_RULES[e.rule] ?? e.rule, barbs: e.barbs, note: ['thuthuka_adopted', 'customer_praise', 'discretionary'].includes(e.rule) ? e.note : '' })),
      };
    });
  }
}
