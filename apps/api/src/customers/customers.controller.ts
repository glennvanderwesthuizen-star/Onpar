import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { assertSiteAccess, CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { hashSecret } from '../common/crypto';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { temporaryPassword } from '../db/company';

const phone = z.string().trim().max(30).default('');
const UnitBody = z.object({ name: z.string().trim().min(1, 'Enter the unit number or name.').max(60) });
const UnitUpdate = UnitBody.extend({ active: z.boolean() });
const CustomerBody = z.object({
  kind: z.enum(['client', 'tenant'], { message: 'Choose client or tenant.' }),
  fullName: z.string().trim().min(2, 'Enter their full name.').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  unitId: z.string().uuid().nullable().default(null),
  phone,
  secondContactName: z.string().trim().max(120).default(''),
  secondContactPhone: phone,
});
const CustomerUpdate = CustomerBody.omit({ email: true }).extend({ active: z.boolean() });
/** A list pasted or loaded from a spreadsheet: one tenant per row, new units made as needed. */
const ImportBody = z.object({
  rows: z
    .array(z.object({ unit: z.string().trim().min(1).max(60), fullName: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email(), phone, secondContactName: z.string().trim().max(120).default(''), secondContactPhone: phone }))
    .min(1, 'There are no rows to import.')
    .max(500, 'Import at most 500 tenants at a time.'),
});

const CUSTOMER_COLUMNS = `c.id, c.kind, c.full_name AS "fullName", c.email, c.unit_id AS "unitId", u.name AS "unitName", c.phone,
  c.second_contact_name AS "secondContactName", c.second_contact_phone AS "secondContactPhone", c.active,
  c.must_change_password AS "mustChangePassword", c.created_at AS "createdAt",
  (SELECT max(a.at) FROM audit_log a WHERE a.entity_type = 'customer' AND a.entity_id = c.id AND a.action = 'auth.login') AS "lastSignIn",
  EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.customer_id = c.id) AS "alertsOn"`;

/**
 * The units, client and tenants of a site (phase 3 of the plan of 6 Oct 2026, D-39). Only the
 * administrator creates and changes them; managers may look. Each customer gets a temporary
 * password, shown once, and chooses their own at first sign-in.
 */
@Controller('sites/:siteId')
@UseGuards(UserAuthGuard)
export class CustomersController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get('customers')
  @RequirePermission('customers.view')
  list(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      const units = (
        await tx.query(
          `SELECT u.id, u.name, u.active, (SELECT count(*)::int FROM customers c WHERE c.unit_id = u.id AND c.active) AS people
             FROM site_units u WHERE u.site_id = $1 ORDER BY u.active DESC, length(u.name), lower(u.name)`,
          [siteId],
        )
      ).rows;
      return { units, customers: await this.rows(tx, siteId) };
    });
  }

  @Post('units')
  @RequirePermission('customers.manage')
  addUnit(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Body() body: unknown) {
    const b = parseBody(UnitBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      const id = await this.unit(tx, siteId, b.name, true);
      await this.audit.byUser(tx, user, { action: 'unit.create', entityType: 'site_unit', entityId: id, after: { siteId, ...b } });
      return { id };
    });
  }

  @Put('units/:id')
  @RequirePermission('customers.manage')
  updateUnit(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(UnitUpdate, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      const before = (await tx.query('SELECT name, active FROM site_units WHERE id = $1 AND site_id = $2 FOR UPDATE', [id, siteId])).rows[0];
      if (!before) throw new NotFoundException('Unit not found.');
      const clash = (await tx.query('SELECT 1 FROM site_units WHERE site_id = $1 AND lower(name) = lower($2) AND id <> $3', [siteId, b.name, id])).rowCount;
      if (clash) throw new ConflictException({ message: 'This site already has a unit with that name.', errors: { name: 'Already in use.' } });
      if (!b.active) {
        const people = (await tx.query('SELECT count(*)::int AS n FROM customers WHERE unit_id = $1 AND active', [id])).rows[0].n;
        if (people) throw new ConflictException(`${people} active tenant${people === 1 ? '' : 's'} still belong to this unit. Deactivate or move them first.`);
      }
      await tx.query('UPDATE site_units SET name = $2, active = $3 WHERE id = $1', [id, b.name, b.active]);
      await this.audit.byUser(tx, user, { action: 'unit.update', entityType: 'site_unit', entityId: id, before, after: b });
      return { ok: true };
    });
  }

  /** Adds the client or a tenant. Returns a temporary password, shown once. */
  @Post('customers')
  @RequirePermission('customers.manage')
  add(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Body() body: unknown) {
    const b = parseBody(CustomerBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      const made = await this.create(tx, user, siteId, { ...b, unitId: await this.checkUnit(tx, siteId, b.kind, b.unitId) });
      return made;
    });
  }

  @Put('customers/:id')
  @RequirePermission('customers.manage')
  update(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(CustomerUpdate, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      const before = (await this.rows(tx, siteId, id))[0];
      if (!before) throw new NotFoundException('Customer not found.');
      const unitId = await this.checkUnit(tx, siteId, b.kind, b.unitId);
      await tx.query(
        `UPDATE customers SET kind = $2, full_name = $3, unit_id = $4, phone = $5, second_contact_name = $6, second_contact_phone = $7, active = $8 WHERE id = $1`,
        [id, b.kind, b.fullName, unitId, b.phone, b.secondContactName, b.secondContactPhone, b.active],
      );
      // A deactivated customer's devices stop receiving alerts at once.
      if (!b.active) await tx.query('DELETE FROM push_subscriptions WHERE customer_id = $1', [id]);
      await this.audit.byUser(tx, user, { action: 'customer.update', entityType: 'customer', entityId: id, before, after: { ...b, unitId } });
      return (await this.rows(tx, siteId, id))[0];
    });
  }

  /** A new temporary password, shown once (for example the customer forgot theirs). */
  @Post('customers/:id/reset-password')
  @RequirePermission('customers.manage')
  @HttpCode(200)
  reset(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      const password = temporaryPassword();
      const r = await tx.query('UPDATE customers SET password_hash = $3, must_change_password = true WHERE id = $1 AND site_id = $2', [id, siteId, await hashSecret(password)]);
      if (!r.rowCount) throw new NotFoundException('Customer not found.');
      await this.audit.byUser(tx, user, { action: 'customer.password_reset', entityType: 'customer', entityId: id });
      return { temporaryPassword: password };
    });
  }

  /**
   * Many tenants at once, from a spreadsheet. All or nothing: if any row has a problem, nothing
   * is saved and every problem is listed with its row. Units that do not exist yet are created.
   */
  @Post('customers/import')
  @RequirePermission('customers.manage')
  @HttpCode(200)
  import(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Body() body: unknown) {
    const { rows } = parseBody(ImportBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      const problems: string[] = [];
      const seen = new Set<string>();
      for (const [i, r] of rows.entries()) {
        if (seen.has(r.email)) problems.push(`Row ${i + 1}: ${r.email} appears more than once in the list.`);
        else if ((await tx.query('SELECT auth_email_taken($1) AS taken', [r.email])).rows[0].taken) problems.push(`Row ${i + 1}: ${r.email} already has an On Par sign-in.`);
        seen.add(r.email);
      }
      if (problems.length) throw new BadRequestException({ message: 'Nothing was imported. Fix these rows and try again.', errors: Object.fromEntries(problems.map((p, i) => [`row${i}`, p])) });
      const created: { fullName: string; email: string; unit: string; temporaryPassword: string }[] = [];
      for (const r of rows) {
        const unitId = await this.unit(tx, siteId, r.unit, false);
        const made = await this.create(tx, user, siteId, { kind: 'tenant', fullName: r.fullName, email: r.email, unitId, phone: r.phone, secondContactName: r.secondContactName, secondContactPhone: r.secondContactPhone });
        created.push({ fullName: r.fullName, email: r.email, unit: r.unit, temporaryPassword: made.temporaryPassword });
      }
      return { created };
    });
  }

  private async site(tx: Tx, user: UserPrincipal, siteId: string) {
    assertSiteAccess(user, siteId);
    if (!(await tx.query('SELECT 1 FROM sites WHERE id = $1', [siteId])).rowCount) throw new NotFoundException('Site not found.');
  }

  /** The unit with this name at the site, created if it does not exist. `strict`: an existing name is an error. */
  private async unit(tx: Tx, siteId: string, name: string, strict: boolean): Promise<string> {
    const existing = (await tx.query('SELECT id, active FROM site_units WHERE site_id = $1 AND lower(name) = lower($2)', [siteId, name])).rows[0];
    if (existing) {
      if (strict) throw new ConflictException({ message: 'This site already has a unit with that name.', errors: { name: 'Already in use.' } });
      if (!existing.active) await tx.query('UPDATE site_units SET active = true WHERE id = $1', [existing.id]);
      return existing.id;
    }
    return (await tx.query('INSERT INTO site_units (company_id, site_id, name) VALUES (app_company_id(), $1, $2) RETURNING id', [siteId, name])).rows[0].id;
  }

  /** A tenant needs an active unit of this site; the client may have one or none. */
  private async checkUnit(tx: Tx, siteId: string, kind: 'client' | 'tenant', unitId: string | null): Promise<string | null> {
    if (!unitId) {
      if (kind === 'tenant') throw new BadRequestException({ message: 'Choose the unit this tenant belongs to.', errors: { unitId: 'Choose a unit.' } });
      return null;
    }
    const u = (await tx.query('SELECT active FROM site_units WHERE id = $1 AND site_id = $2', [unitId, siteId])).rows[0];
    if (!u) throw new BadRequestException({ message: 'Choose a unit from this site.', errors: { unitId: 'Unknown unit.' } });
    if (!u.active) throw new BadRequestException({ message: 'That unit is not active.', errors: { unitId: 'Not active.' } });
    return unitId;
  }

  private async create(tx: Tx, user: UserPrincipal, siteId: string, c: z.infer<typeof CustomerBody>) {
    // One email, one sign-in, across staff and customers and every company.
    if ((await tx.query('SELECT auth_email_taken($1) AS taken', [c.email])).rows[0].taken) {
      throw new ConflictException({ message: 'That email address already has an On Par sign-in.', errors: { email: 'Already in use.' } });
    }
    const password = temporaryPassword();
    const id = (
      await tx.query(
        `INSERT INTO customers (company_id, site_id, unit_id, kind, full_name, email, phone, second_contact_name, second_contact_phone, password_hash, created_by)
         VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [siteId, c.unitId, c.kind, c.fullName, c.email, c.phone, c.secondContactName, c.secondContactPhone, await hashSecret(password), user.userId],
      )
    ).rows[0].id as string;
    await this.audit.byUser(tx, user, { action: 'customer.create', entityType: 'customer', entityId: id, after: { siteId, ...c } });
    return { id, temporaryPassword: password };
  }

  private async rows(tx: Tx, siteId: string, id: string | null = null) {
    return (
      await tx.query(
        `SELECT ${CUSTOMER_COLUMNS} FROM customers c LEFT JOIN site_units u ON u.id = c.unit_id
          WHERE c.site_id = $1 AND ($2::uuid IS NULL OR c.id = $2::uuid)
          ORDER BY c.active DESC, (c.kind = 'client') DESC, length(coalesce(u.name, '')), lower(coalesce(u.name, '')), lower(c.full_name)`,
        [siteId, id],
      )
    ).rows;
  }
}
