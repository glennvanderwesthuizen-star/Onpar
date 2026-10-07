import { BadRequestException, Body, Controller, Get, HttpCode, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { passwordProblem } from '@onpar/rules';
import { AllowTemporaryPassword, CurrentCustomer, CustomerAuthGuard, CustomerPrincipal } from '../common/auth';
import { hashSecret, verifySecret } from '../common/crypto';
import { parseBody } from '../common/validation';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';

const ContactBody = z.object({
  phone: z.string().trim().min(6, 'Enter the number the gate should phone.').max(30),
  secondContactName: z.string().trim().max(120).default(''),
  secondContactPhone: z.string().trim().max(30).default(''),
});
const VisitorAlertsBody = z.object({ muteExit: z.boolean().optional(), muteArrival: z.boolean().optional() });
const PasswordBody = z.object({ currentPassword: z.string().min(1, 'Enter your current password.'), newPassword: z.string() });

/**
 * The customer app (phase 3, D-39), for the client and the tenants of a site. A customer sees
 * and changes only their own record. Nothing here reaches guards, scores or other customers.
 * Visitor approval and announcing visitors are added on top of this later (D-40).
 */
@Controller('customer')
@UseGuards(CustomerAuthGuard)
export class CustomerAppController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get('me')
  @AllowTemporaryPassword()
  me(@CurrentCustomer() me: CustomerPrincipal) {
    return this.db.withTenant(me.companyId, async (tx) => {
      const c = (
        await tx.query(
          `SELECT c.id, c.kind, c.full_name AS "fullName", c.email, c.phone, c.second_contact_name AS "secondContactName",
                  c.second_contact_phone AS "secondContactPhone", c.must_change_password AS "mustChangePassword", c.mute_exit_alerts AS "muteExitAlerts", c.mute_arrival_alerts AS "muteArrivalAlerts",
                  s.name AS "siteName", s.address AS "siteAddress", u.name AS "unitName", co.name AS "companyName"
             FROM customers c JOIN sites s ON s.id = c.site_id JOIN companies co ON co.id = c.company_id
             LEFT JOIN site_units u ON u.id = c.unit_id WHERE c.id = $1`,
          [me.customerId],
        )
      ).rows[0];
      return { ...c, kindLabel: c.kind === 'client' ? 'Client' : 'Tenant' };
    });
  }

  /** A customer keeps their own phone numbers current: the gate phones these when an alert goes unanswered. */
  @Put('contact')
  contact(@CurrentCustomer() me: CustomerPrincipal, @Body() body: unknown) {
    const b = parseBody(ContactBody, body);
    if (b.secondContactPhone && !b.secondContactName) throw new BadRequestException({ message: 'Say whose number the second one is.', errors: { secondContactName: 'Enter their name.' } });
    return this.db.withTenant(me.companyId, async (tx) => {
      const before = (await tx.query(`SELECT phone, second_contact_name AS "secondContactName", second_contact_phone AS "secondContactPhone" FROM customers WHERE id = $1 FOR UPDATE`, [me.customerId])).rows[0];
      await tx.query('UPDATE customers SET phone = $2, second_contact_name = $3, second_contact_phone = $4 WHERE id = $1', [me.customerId, b.phone, b.secondContactName, b.secondContactPhone]);
      await this.audit.byAccount(tx, me, { action: 'customer.contact_update', entityType: 'customer', entityId: me.customerId, before, after: b });
      return { ok: true };
    });
  }

  /** A customer may switch off "your visitor has arrived" and "has left" for themselves. Requests and exceptions are always sent. */
  @Put('visitor-alerts')
  visitorAlerts(@CurrentCustomer() me: CustomerPrincipal, @Body() body: unknown) {
    const b = parseBody(VisitorAlertsBody, body);
    return this.db.withTenant(me.companyId, async (tx) => {
      const before = (await tx.query('SELECT mute_exit_alerts AS "muteExit", mute_arrival_alerts AS "muteArrival" FROM customers WHERE id = $1 FOR UPDATE', [me.customerId])).rows[0];
      await tx.query('UPDATE customers SET mute_exit_alerts = COALESCE($2, mute_exit_alerts), mute_arrival_alerts = COALESCE($3, mute_arrival_alerts) WHERE id = $1', [me.customerId, b.muteExit ?? null, b.muteArrival ?? null]);
      await this.audit.byAccount(tx, me, { action: 'customer.visitor_alerts_update', entityType: 'customer', entityId: me.customerId, before, after: b });
      return { ok: true };
    });
  }

  @Post('password')
  @AllowTemporaryPassword()
  @HttpCode(200)
  password(@CurrentCustomer() me: CustomerPrincipal, @Body() body: unknown) {
    const p = parseBody(PasswordBody, body);
    return this.db.withTenant(me.companyId, async (tx) => {
      const c = (await tx.query('SELECT email, password_hash FROM customers WHERE id = $1', [me.customerId])).rows[0];
      if (!(await verifySecret(c.password_hash, p.currentPassword))) {
        throw new BadRequestException({ message: 'Your current password is not right.', errors: { currentPassword: 'Not right.' } });
      }
      const problem = passwordProblem(p.newPassword, c.email) ?? (p.newPassword === p.currentPassword ? 'Choose a password different from the current one.' : null);
      if (problem) throw new BadRequestException({ message: problem, errors: { newPassword: problem } });
      await tx.query('UPDATE customers SET password_hash = $2, must_change_password = false, password_changed_at = now() WHERE id = $1', [me.customerId, await hashSecret(p.newPassword)]);
      await this.audit.byAccount(tx, me, { action: 'customer.password_change', entityType: 'customer', entityId: me.customerId });
      return { ok: true };
    });
  }
}
