import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { siteErrors, guardsNeededPerDay, DEFAULT_PAYROLL_START_DAY } from '@onpar/rules';
import { z } from 'zod';
import { assertSiteAccess, CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody, throwIfErrors } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';

const Shift = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim(),
  kind: z.enum(['day', 'night']),
  startTime: z.string(),
  endTime: z.string(),
  guardsRequired: z.number().int(),
  equipment: z.record(z.string(), z.number().int()).default({}),
});

const Contact = z.object({ name: z.string().trim().default(''), phone: z.string().trim() });

const SiteBody = z.object({
  name: z.string().trim(),
  address: z.string().trim(),
  client: z.string().trim(),
  minimumGrade: z.string(),
  armed: z.boolean(),
  payrollStartDay: z.number().int().default(DEFAULT_PAYROLL_START_DAY),
  shifts: z.array(Shift),
  contacts: z
    .object({ supervisor: Contact.optional(), site_manager: Contact.optional(), control_room: Contact.optional() })
    .default({}),
});
type SiteBody = z.infer<typeof SiteBody>;

@Controller('sites')
@UseGuards(UserAuthGuard)
export class SitesController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('sites.view')
  list(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const sites = (
        await tx.query(
          `SELECT s.id, s.name, s.address, s.client, s.minimum_grade, s.armed, s.payroll_start_day,
                  (SELECT count(*)::int FROM employees e WHERE e.home_site_id = s.id AND e.status = 'active') AS officers,
                  (SELECT coalesce(sum(guards_required), 0)::int FROM site_shifts sh WHERE sh.site_id = s.id) AS guards_per_day
             FROM sites s
            WHERE ($1::uuid[] IS NULL OR s.id = ANY($1::uuid[]))
            ORDER BY lower(s.name)`,
          [user.siteIds],
        )
      ).rows;
      return sites;
    });
  }

  @Get(':id')
  @RequirePermission('sites.view')
  get(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    assertSiteAccess(user, id);
    return this.db.withTenant(user.companyId, (tx) => this.load(tx, id));
  }

  @Post()
  @RequirePermission('sites.edit')
  create(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const site = this.validate(body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.assertUniqueName(tx, site.name, null);
      const { id } = (
        await tx.query(
          `INSERT INTO sites (company_id, name, address, client, minimum_grade, armed, payroll_start_day)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6) RETURNING id`,
          [site.name, site.address, site.client, site.minimumGrade, site.armed, site.payrollStartDay],
        )
      ).rows[0];
      await this.writeChildren(tx, id, site);
      const after = await this.load(tx, id);
      await this.audit.byUser(tx, user, { action: 'site.create', entityType: 'site', entityId: id, after });
      return after;
    });
  }

  /** Edits every field of a site in place (section 30). Shifts not in the list are removed. */
  @Put(':id')
  @RequirePermission('sites.edit')
  update(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const site = this.validate(body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const before = await this.load(tx, id);
      await this.assertUniqueName(tx, site.name, id);
      await tx.query(
        `UPDATE sites SET name = $2, address = $3, client = $4, minimum_grade = $5, armed = $6,
                payroll_start_day = $7, updated_at = now() WHERE id = $1`,
        [id, site.name, site.address, site.client, site.minimumGrade, site.armed, site.payrollStartDay],
      );
      await this.writeChildren(tx, id, site);
      const after = await this.load(tx, id);
      await this.audit.byUser(tx, user, { action: 'site.update', entityType: 'site', entityId: id, before, after });
      return after;
    });
  }

  private validate(body: unknown): SiteBody {
    const site = parseBody(SiteBody, body);
    throwIfErrors(siteErrors(site));
    return site;
  }

  private async assertUniqueName(tx: Tx, name: string, exceptId: string | null) {
    const clash = await tx.query('SELECT 1 FROM sites WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2', [
      name,
      exceptId,
    ]);
    if (clash.rowCount) {
      throw new ConflictException({
        message: 'A site with this name already exists.',
        errors: { name: 'A site with this name already exists.' },
      });
    }
  }

  private async writeChildren(tx: Tx, siteId: string, site: SiteBody) {
    // Shifts keep their IDs when edited, so later records (rosters, attendance) stay linked.
    const keep = site.shifts.filter((s) => s.id).map((s) => s.id);
    await tx.query('DELETE FROM site_shifts WHERE site_id = $1 AND NOT (id = ANY($2::uuid[]))', [siteId, keep]);
    for (const [i, s] of site.shifts.entries()) {
      const values = [s.name, s.kind, s.startTime, s.endTime, s.guardsRequired, JSON.stringify(s.equipment), i];
      if (s.id) {
        const r = await tx.query(
          `UPDATE site_shifts SET name = $3, kind = $4, start_time = $5, end_time = $6, guards_required = $7,
                  equipment = $8, sort_order = $9 WHERE id = $1 AND site_id = $2`,
          [s.id, siteId, ...values],
        );
        if (!r.rowCount) throw new NotFoundException('One of the shifts no longer exists. Please reload.');
      } else {
        await tx.query(
          `INSERT INTO site_shifts (company_id, site_id, name, kind, start_time, end_time, guards_required, equipment, sort_order)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
          [siteId, ...values],
        );
      }
    }
    await tx.query('DELETE FROM site_contacts WHERE site_id = $1', [siteId]);
    for (const [kind, c] of Object.entries(site.contacts)) {
      if (!c?.phone) continue;
      await tx.query(
        `INSERT INTO site_contacts (company_id, site_id, kind, name, phone) VALUES (app_company_id(), $1, $2, $3, $4)`,
        [siteId, kind, c.name, c.phone],
      );
    }
  }

  private async load(tx: Tx, id: string) {
    const site = (
      await tx.query(
        `SELECT id, name, address, client, minimum_grade AS "minimumGrade", armed,
                payroll_start_day AS "payrollStartDay", updated_at AS "updatedAt"
           FROM sites WHERE id = $1`,
        [id],
      )
    ).rows[0];
    if (!site) throw new NotFoundException('Site not found.');
    const shifts = (
      await tx.query(
        `SELECT id, name, kind, to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime",
                guards_required AS "guardsRequired", equipment
           FROM site_shifts WHERE site_id = $1 ORDER BY sort_order`,
        [id],
      )
    ).rows;
    const contacts = Object.fromEntries(
      (await tx.query('SELECT kind, name, phone FROM site_contacts WHERE site_id = $1', [id])).rows.map((c) => [
        c.kind,
        { name: c.name, phone: c.phone },
      ]),
    );
    const officers = (
      await tx.query(`SELECT count(*)::int AS n FROM employees WHERE home_site_id = $1 AND status = 'active'`, [id])
    ).rows[0].n;
    return { ...site, shifts, contacts, coverage: { officers, neededPerDay: guardsNeededPerDay(shifts) } };
  }
}
