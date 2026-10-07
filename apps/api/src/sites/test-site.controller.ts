import { randomInt } from 'node:crypto';
import { Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, CustomerPrincipal, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { hashSecret } from '../common/crypto';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { PassBody, VisitPassService } from '../visitors/visit-pass.service';
import { UnitStaffService } from '../visitors/unit-staff.service';
import { VisitorSetupService } from '../visitors/visitor-setup.service';

const UNITS = 12;
const GATES = ['Main gate', 'Back gate'];
/** Made-up tenants. None of these is a real person. */
const TENANTS = ['Test Tenant One', 'Test Tenant Two', 'Test Tenant Three', 'Test Tenant Four', 'Test Tenant Five', 'Test Tenant Six', 'Test Tenant Seven', 'Test Tenant Eight', 'Test Tenant Nine', 'Test Tenant Ten', 'Test Tenant Eleven', 'Test Tenant Twelve'];

/**
 * The made-up visitors of the owner's test sheet ("On Par Test Visitors"). The ID numbers have
 * month 13, so they can never be a real person's; the plates start with TEST.
 */
const ANNOUNCED = [
  { unit: 1, name: 'Lerato Mokoena', idNumber: '', registration: 'TEST01GP', contractor: false, maxWorkers: null, days: 14, what: 'Visitor, known by number plate, for two weeks' },
  { unit: 2, name: 'Johan van Wyk', idNumber: '7113116101084', registration: '', contractor: false, maxWorkers: null, days: 14, what: 'Visitor, known by ID number, for two weeks' },
  { unit: 3, name: 'Priya Naidoo', idNumber: '7213121102083', registration: 'TEST03GP', contractor: true, maxWorkers: 3, days: 14, what: 'Contractor with up to 3 workers, for two weeks, out by 18:00' },
  { unit: 4, name: 'Sibusiso Dlamini', idNumber: '', registration: 'TEST04GP', contractor: false, maxWorkers: null, days: 1, what: 'Visitor, known by number plate, today only' },
] as const;

/** Made-up staff of a unit. The cell numbers (and the contractor's above) start with 0000, which no real number does. */
const STAFF = [
  { unit: 5, fullName: 'Test Cleaner', cell: '0000111111', byVehicle: false, registration: '', what: 'Cleaner, on foot' },
  { unit: 6, fullName: 'Test Gardener', cell: '0000222222', byVehicle: true, registration: 'TEST09GP', what: 'Gardener, by vehicle' },
] as const;

const pick = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join('');

/**
 * Makes a ready-made site for testing in one go (owner's request, 7 Oct 2026): two gates, twelve
 * units with a tenant sign-in each, four announced visitors and two staff of a unit. Everything
 * is made up and named as a test. Guards and phones are not made: a guard is a real enrolment.
 */
@Controller('test-sites')
@UseGuards(UserAuthGuard)
export class TestSiteController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly passes: VisitPassService,
    private readonly staff: UnitStaffService,
    private readonly setup: VisitorSetupService,
  ) {}

  @Post()
  @RequirePermission('customers.manage')
  create(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => {
      // The next free "Test site N".
      const taken = new Set((await tx.query(`SELECT lower(name) AS name FROM sites WHERE lower(name) LIKE 'test site %'`)).rows.map((r) => r.name as string));
      let n = 1;
      while (taken.has(`test site ${n}`)) n++;
      const name = `Test site ${n}`;
      const siteId = (
        await tx.query(
          `INSERT INTO sites (company_id, name, address, client, minimum_grade, armed, province)
           VALUES (app_company_id(), $1, 'Made-up site for testing', 'Test client', 'D', false, 'GP') RETURNING id`,
          [name],
        )
      ).rows[0].id as string;
      await tx.query(
        `INSERT INTO site_shifts (company_id, site_id, name, kind, start_time, end_time, guards_required, equipment, sort_order) VALUES
           (app_company_id(), $1, 'Day', 'day', '06:00', '18:00', 2, '{}', 0),
           (app_company_id(), $1, 'Night', 'night', '18:00', '06:00', 2, '{}', 1)`,
        [siteId],
      );
      for (const g of GATES) await tx.query('INSERT INTO site_gates (company_id, site_id, name) VALUES (app_company_id(), $1, $2)', [siteId, g]);
      await this.setup.categories(tx, siteId);

      // One password for all twelve tenants, so testing is not twelve passwords. Shown once.
      const password = `test-${pick('abcdefghjkmnpqrstuvwxyz23456789', 8)}`;
      const hash = await hashSecret(password);
      let tag = '';
      do tag = pick('abcdefghjkmnpqrstuvwxyz', 4);
      while ((await tx.query('SELECT auth_email_taken($1) AS taken', [`unit1@${tag}.onpar.test`])).rows[0].taken);
      const tenants: { unit: string; name: string; email: string; me: CustomerPrincipal }[] = [];
      for (let u = 1; u <= UNITS; u++) {
        const unitId = (await tx.query('INSERT INTO site_units (company_id, site_id, name) VALUES (app_company_id(), $1, $2) RETURNING id', [siteId, String(u)])).rows[0].id as string;
        const email = `unit${u}@${tag}.onpar.test`;
        const customerId = (
          await tx.query(
            `INSERT INTO customers (company_id, site_id, unit_id, kind, full_name, email, password_hash, must_change_password, created_by)
             VALUES (app_company_id(), $1, $2, 'tenant', $3, $4, $5, false, $6) RETURNING id`,
            [siteId, unitId, TENANTS[u - 1], email, hash, user.userId],
          )
        ).rows[0].id as string;
        tenants.push({ unit: String(u), name: TENANTS[u - 1], email, me: { kind: 'customer', customerId, companyId: user.companyId, siteId, unitId, customerKind: 'tenant', name: TENANTS[u - 1] } });
      }

      const day = (await tx.query(`SELECT to_char(now() AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS today, to_char((now() AT TIME ZONE 'Africa/Johannesburg') + interval '13 days', 'YYYY-MM-DD') AS last`)).rows[0];
      for (const a of ANNOUNCED) {
        const once = a.days === 1;
        const body: PassBody = {
          kind: once ? 'once' : 'ongoing',
          visitorName: a.name,
          categoryId: null,
          contractor: a.contractor,
          maxWorkers: a.maxWorkers,
          leaveBy: null,
          gateId: null,
          idNumber: a.idNumber,
          cell: a.contractor ? '0000333333' : '',
          registration: a.registration,
          visitDate: once ? day.today : null,
          time: null,
          days: [],
          hoursFrom: null,
          hoursTo: null,
          startDate: once ? null : day.today,
          endDate: once ? null : day.last,
        };
        await this.passes.create(tx, tenants[a.unit - 1].me, body);
      }
      for (const s of STAFF) {
        await this.staff.create(tx, siteId, tenants[s.unit - 1].me.unitId, { kind: 'user', user }, { fullName: s.fullName, cell: s.cell, idNumber: '', days: [], hoursFrom: null, hoursTo: null, endDate: null, byVehicle: s.byVehicle, registration: s.registration });
      }
      await this.audit.byUser(tx, user, { action: 'site.create_test', entityType: 'site', entityId: siteId, after: { name, gates: GATES.length, units: UNITS, tenants: UNITS, announced: ANNOUNCED.length, staff: STAFF.length } });
      return {
        siteId,
        name,
        gates: GATES,
        password,
        tenants: tenants.map((t) => ({ unit: t.unit, name: t.name, email: t.email })),
        announced: ANNOUNCED.map((a) => ({ unit: String(a.unit), name: a.name, what: a.what, registration: a.registration || null })),
        staff: STAFF.map((s) => ({ unit: String(s.unit), name: s.fullName, what: s.what, code: s.cell.slice(-6), registration: s.registration || null })),
      };
    });
  }
}
