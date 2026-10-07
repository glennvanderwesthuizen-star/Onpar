import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  BARRED_KIND_LABELS,
  BARRED_KINDS,
  barredValue,
  CATEGORY_KINDS,
  VISITOR_CHECK_INFO,
  VISITOR_CHECKS,
  VISITOR_LIMITS,
  visitorCategoryErrors,
  visitorSettingsErrors,
} from '@onpar/rules';
import { assertSiteAccess, CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody, throwIfErrors } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { VisitorSetupService } from './visitor-setup.service';

const GateBody = z.object({ name: z.string().trim().min(1, 'Enter the name of the gate.').max(60) });
const GateUpdate = GateBody.extend({ active: z.boolean() });
const SettingsBody = z.object({
  checks: z.object(Object.fromEntries(VISITOR_CHECKS.map((c) => [c, z.boolean()])) as Record<(typeof VISITOR_CHECKS)[number], z.ZodBoolean>).strict(),
  noResponseSeconds: z.number(),
  secondContact: z.boolean(),
  overstayEscalationMinutes: z.number(),
  retentionMonths: z.number(),
});
const CategoryBody = z.object({
  name: z.string().trim().max(60),
  kind: z.enum(CATEGORY_KINDS, { message: 'Choose how long the approval lasts.' }),
  contractor: z.boolean().default(false),
  limitMinutes: z.number().nullable().default(null),
  limitUntil: z.string().trim().nullable().default(null),
});
const CategoryUpdate = CategoryBody.extend({ active: z.boolean() });
const BarredBody = z.object({
  kind: z.enum(BARRED_KINDS, { message: 'Choose what to bar.' }),
  value: z.string().trim().max(40),
  unitId: z.string().uuid().nullable().default(null),
  reason: z.string().trim().min(3, 'Say why this is barred.').max(300),
});
const RemoveBody = z.object({ reason: z.string().trim().min(3, 'Say why this is being taken off the list.').max(300) });

/**
 * Visitor management, step 1 (plan approved 7 Oct 2026): a site's gates, visitor checks, time
 * limits, categories and barred list. Only the administrator changes them; company managers
 * may look. Every change is in the audit trail with the values before and after.
 */
@Controller('sites/:siteId')
@UseGuards(UserAuthGuard)
export class VisitorSetupController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly setup: VisitorSetupService,
  ) {}

  @Get('visitor-setup')
  @RequirePermission('visitors.setup.view')
  get(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      const gates = (await tx.query('SELECT id, name, active FROM site_gates WHERE site_id = $1 ORDER BY active DESC, created_at, lower(name)', [siteId])).rows;
      const settings = await this.setup.settings(tx, siteId);
      const barred = (
        await tx.query(
          `SELECT b.id, b.kind, b.value, b.unit_id AS "unitId", u.name AS "unitName", b.reason, a.full_name AS "addedBy", b.added_at AS "addedAt",
                  to_char(b.review_due, 'YYYY-MM-DD') AS "reviewDue", b.review_due <= current_date AS "reviewNow"
             FROM barred_entries b JOIN users a ON a.id = b.added_by LEFT JOIN site_units u ON u.id = b.unit_id
            WHERE b.site_id = $1 AND b.removed_at IS NULL ORDER BY b.added_at DESC`,
          [siteId],
        )
      ).rows.map((b) => ({ ...b, kindLabel: BARRED_KIND_LABELS[b.kind as keyof typeof BARRED_KIND_LABELS] }));
      const units = (await tx.query('SELECT id, name FROM site_units WHERE site_id = $1 AND active ORDER BY length(name), lower(name)', [siteId])).rows;
      return {
        gates,
        settings,
        checks: VISITOR_CHECKS.map((key) => ({ key, ...VISITOR_CHECK_INFO[key], notYet: VISITOR_CHECK_INFO[key].notYet ?? null })),
        limits: VISITOR_LIMITS,
        categories: await this.setup.categories(tx, siteId),
        barred,
        units,
      };
    });
  }

  @Post('gates')
  @RequirePermission('visitors.setup.manage')
  addGate(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Body() body: unknown) {
    const b = parseBody(GateBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      await this.nameFree(tx, 'site_gates', siteId, b.name, null, 'This site already has a gate with that name.');
      const id = (await tx.query('INSERT INTO site_gates (company_id, site_id, name) VALUES (app_company_id(), $1, $2) RETURNING id', [siteId, b.name])).rows[0].id as string;
      await this.audit.byUser(tx, user, { action: 'gate.create', entityType: 'site_gate', entityId: id, after: { siteId, ...b } });
      return { id };
    });
  }

  @Put('gates/:id')
  @RequirePermission('visitors.setup.manage')
  updateGate(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(GateUpdate, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      const before = (await tx.query('SELECT name, active FROM site_gates WHERE id = $1 AND site_id = $2 FOR UPDATE', [id, siteId])).rows[0];
      if (!before) throw new NotFoundException('Gate not found.');
      await this.nameFree(tx, 'site_gates', siteId, b.name, id, 'This site already has a gate with that name.');
      await tx.query('UPDATE site_gates SET name = $2, active = $3 WHERE id = $1', [id, b.name, b.active]);
      await this.audit.byUser(tx, user, { action: 'gate.update', entityType: 'site_gate', entityId: id, before, after: b });
      return { ok: true };
    });
  }

  /** Saves the site's checks and time limits. They apply from the next visit. */
  @Put('visitor-settings')
  @RequirePermission('visitors.setup.manage')
  saveSettings(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Body() body: unknown) {
    const b = parseBody(SettingsBody, body);
    throwIfErrors(visitorSettingsErrors(b));
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      const { saved, ...before } = await this.setup.settings(tx, siteId);
      await tx.query(
        `INSERT INTO site_visitor_settings (site_id, company_id, checks, no_response_seconds, second_contact, overstay_escalation_minutes, retention_months, updated_by)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7)
         ON CONFLICT (site_id) DO UPDATE SET checks = excluded.checks, no_response_seconds = excluded.no_response_seconds, second_contact = excluded.second_contact,
           overstay_escalation_minutes = excluded.overstay_escalation_minutes, retention_months = excluded.retention_months, updated_by = excluded.updated_by, updated_at = now()`,
        [siteId, JSON.stringify(b.checks), b.noResponseSeconds, b.secondContact, b.overstayEscalationMinutes, b.retentionMonths, user.userId],
      );
      await this.audit.byUser(tx, user, { action: 'visitor_settings.update', entityType: 'site', entityId: siteId, before: { ...before, usingDefaults: !saved }, after: b });
      return { ok: true };
    });
  }

  @Post('visitor-categories')
  @RequirePermission('visitors.setup.manage')
  addCategory(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Body() body: unknown) {
    const b = parseBody(CategoryBody, body);
    throwIfErrors(visitorCategoryErrors(b));
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      await this.setup.categories(tx, siteId);
      await this.nameFree(tx, 'visitor_categories', siteId, b.name, null, 'This site already has a category with that name.');
      const id = (
        await tx.query(
          `INSERT INTO visitor_categories (company_id, site_id, name, kind, contractor, limit_minutes, limit_until) VALUES (app_company_id(), $1, $2, $3, $4, $5, $6::time) RETURNING id`,
          [siteId, b.name, b.kind, b.contractor, b.limitMinutes, b.limitUntil],
        )
      ).rows[0].id as string;
      await this.audit.byUser(tx, user, { action: 'visitor_category.create', entityType: 'visitor_category', entityId: id, after: { siteId, ...b } });
      return { id };
    });
  }

  @Put('visitor-categories/:id')
  @RequirePermission('visitors.setup.manage')
  updateCategory(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(CategoryUpdate, body);
    throwIfErrors(visitorCategoryErrors(b));
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      const before = (await this.setup.categories(tx, siteId)).find((c) => c.id === id);
      if (!before) throw new NotFoundException('Category not found.');
      await this.nameFree(tx, 'visitor_categories', siteId, b.name, id, 'This site already has a category with that name.');
      if (!b.active && before.active && (await tx.query('SELECT count(*)::int AS n FROM visitor_categories WHERE site_id = $1 AND active', [siteId])).rows[0].n <= 1) {
        throw new ConflictException('A site needs at least one visitor category.');
      }
      await tx.query('UPDATE visitor_categories SET name = $2, kind = $3, contractor = $4, limit_minutes = $5, limit_until = $6::time, active = $7 WHERE id = $1', [
        id,
        b.name,
        b.kind,
        b.contractor,
        b.limitMinutes,
        b.limitUntil,
        b.active,
      ]);
      const { id: _id, ...was } = before;
      await this.audit.byUser(tx, user, { action: 'visitor_category.update', entityType: 'visitor_category', entityId: id, before: was, after: b });
      return { ok: true };
    });
  }

  /** Bars an ID number, cell number or number plate from the site, or from one unit. */
  @Post('barred')
  @RequirePermission('visitors.setup.manage')
  bar(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Body() body: unknown) {
    const b = parseBody(BarredBody, body);
    const v = barredValue(b.kind, b.value);
    if ('error' in v) throw new BadRequestException({ message: 'Please fix the highlighted fields.', errors: { value: v.error } });
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      if (b.unitId && !(await tx.query('SELECT 1 FROM site_units WHERE id = $1 AND site_id = $2', [b.unitId, siteId])).rowCount) {
        throw new BadRequestException({ message: 'Choose a unit from this site.', errors: { unitId: 'Unknown unit.' } });
      }
      const dup = await tx.query('SELECT 1 FROM barred_entries WHERE site_id = $1 AND unit_id IS NOT DISTINCT FROM $2 AND kind = $3 AND value = $4 AND removed_at IS NULL', [siteId, b.unitId, b.kind, v.value]);
      if (dup.rowCount) throw new ConflictException({ message: 'That is already on the barred list.', errors: { value: 'Already barred.' } });
      const id = (
        await tx.query('INSERT INTO barred_entries (company_id, site_id, unit_id, kind, value, reason, added_by) VALUES (app_company_id(), $1, $2, $3, $4, $5, $6) RETURNING id', [
          siteId,
          b.unitId,
          b.kind,
          v.value,
          b.reason,
          user.userId,
        ])
      ).rows[0].id as string;
      await this.audit.byUser(tx, user, { action: 'barred.add', entityType: 'barred_entry', entityId: id, after: { siteId, unitId: b.unitId, kind: b.kind, value: v.value, reason: b.reason } });
      return { id, value: v.value };
    });
  }

  /** Takes an entry off the barred list. The entry is kept, with who took it off and why. */
  @Post('barred/:id/remove')
  @RequirePermission('visitors.setup.manage')
  @HttpCode(200)
  unbar(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(RemoveBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      const r = await tx.query('UPDATE barred_entries SET removed_at = now(), removed_by = $3, removal_reason = $4 WHERE id = $1 AND site_id = $2 AND removed_at IS NULL RETURNING kind, value', [id, siteId, user.userId, b.reason]);
      if (!r.rowCount) throw new NotFoundException('Barred entry not found.');
      await this.audit.byUser(tx, user, { action: 'barred.remove', entityType: 'barred_entry', entityId: id, before: r.rows[0], after: { reason: b.reason } });
      return { ok: true };
    });
  }

  private async site(tx: Tx, user: UserPrincipal, siteId: string) {
    assertSiteAccess(user, siteId);
    if (!(await tx.query('SELECT 1 FROM sites WHERE id = $1', [siteId])).rowCount) throw new NotFoundException('Site not found.');
  }

  private async nameFree(tx: Tx, table: 'site_gates' | 'visitor_categories', siteId: string, name: string, exceptId: string | null, message: string) {
    const clash = await tx.query(`SELECT 1 FROM ${table} WHERE site_id = $1 AND lower(name) = lower($2) AND ($3::uuid IS NULL OR id <> $3::uuid)`, [siteId, name, exceptId]);
    if (clash.rowCount) throw new ConflictException({ message, errors: { name: 'Already in use.' } });
  }
}
