import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { passwordProblem, ROLE_LABELS, ROLES, Role, SITE_SCOPED_ROLES } from '@onpar/rules';
import { AllowTemporaryPassword, CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { hashSecret, verifySecret } from '../common/crypto';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { temporaryPassword } from '../db/company';

const UserBody = z.object({
  fullName: z.string().trim().min(2, 'Enter their full name.').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  role: z.enum(ROLES, { message: 'Choose a role.' }),
  siteIds: z.array(z.string().uuid()).default([]),
  /** This person's own officer record, when he is also an employee with shifts (D-42). */
  employeeId: z.string().uuid().nullable().default(null),
});
// Leaving `employeeId` out keeps the join as it is; null removes it.
const UpdateBody = UserBody.omit({ email: true, employeeId: true }).extend({ active: z.boolean(), employeeId: z.string().uuid().nullable().optional() });
const PasswordBody = z.object({ currentPassword: z.string().min(1, 'Enter your current password.'), newPassword: z.string() });

/** Management users: the system administrator adds them, sets their role and sites, and resets passwords. */
@Controller()
@UseGuards(UserAuthGuard)
export class UsersController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get('users')
  @RequirePermission('users.manage')
  list(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, (tx) => this.rows(tx));
  }

  @Post('users')
  @RequirePermission('users.manage')
  create(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const u = parseBody(UserBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const siteIds = await this.checkSites(tx, u.role, u.siteIds);
      const password = temporaryPassword();
      let id: string;
      try {
        await tx.query('SAVEPOINT add_user');
        id = (
          await tx.query(
            `INSERT INTO users (company_id, email, full_name, password_hash, role, must_change_password) VALUES (app_company_id(), $1, $2, $3, $4, true) RETURNING id`,
            [u.email, u.fullName, await hashSecret(password), u.role],
          )
        ).rows[0].id;
      } catch (e) {
        // Email addresses sign in across all companies, so they are unique everywhere.
        if ((e as { code?: string }).code === '23505') {
          await tx.query('ROLLBACK TO SAVEPOINT add_user');
          throw new ConflictException({ message: 'That email address already has an On Par account.', errors: { email: 'Already in use.' } });
        }
        throw e;
      }
      for (const s of siteIds) await tx.query('INSERT INTO user_sites (company_id, user_id, site_id) VALUES (app_company_id(), $1, $2)', [id, s]);
      await this.linkOfficer(tx, id, u.employeeId);
      await this.audit.byUser(tx, user, { action: 'user.create', entityType: 'user', entityId: id, after: { ...u, siteIds } });
      return { id, temporaryPassword: password };
    });
  }

  @Put('users/:id')
  @RequirePermission('users.manage')
  update(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const u = parseBody(UpdateBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const before = (await this.rows(tx, id))[0];
      if (!before) throw new NotFoundException('User not found.');
      if (id === user.userId && (!u.active || u.role !== before.role)) {
        throw new BadRequestException('You cannot change your own role or deactivate yourself. Ask another administrator.');
      }
      const siteIds = await this.checkSites(tx, u.role, u.siteIds);
      await tx.query('UPDATE users SET full_name = $2, role = $3, active = $4 WHERE id = $1', [id, u.fullName, u.role, u.active]);
      await tx.query('DELETE FROM user_sites WHERE user_id = $1', [id]);
      for (const s of siteIds) await tx.query('INSERT INTO user_sites (company_id, user_id, site_id) VALUES (app_company_id(), $1, $2)', [id, s]);
      if (u.employeeId !== undefined) await this.linkOfficer(tx, id, u.employeeId);
      const admins = (await tx.query(`SELECT count(*)::int AS n FROM users WHERE role = 'system_admin' AND active`)).rows[0].n;
      if (!admins) throw new BadRequestException('The company must keep at least one active system administrator.');
      await this.audit.byUser(tx, user, { action: 'user.update', entityType: 'user', entityId: id, before, after: { ...u, siteIds } });
      return (await this.rows(tx, id))[0];
    });
  }

  /** Gives the user a new temporary password, shown once; they choose their own at next sign-in. */
  @Post('users/:id/reset-password')
  @RequirePermission('users.manage')
  @HttpCode(200)
  reset(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const password = temporaryPassword();
      const r = await tx.query('UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1', [id, await hashSecret(password)]);
      if (!r.rowCount) throw new NotFoundException('User not found.');
      await this.audit.byUser(tx, user, { action: 'user.password_reset', entityType: 'user', entityId: id });
      return { temporaryPassword: password };
    });
  }

  /** Any signed-in user changes their own password (required after a temporary one). */
  @Post('auth/password')
  @AllowTemporaryPassword()
  @HttpCode(200)
  changeOwn(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const p = parseBody(PasswordBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const u = (await tx.query('SELECT email, password_hash FROM users WHERE id = $1', [user.userId])).rows[0];
      if (!(await verifySecret(u.password_hash, p.currentPassword))) {
        throw new BadRequestException({ message: 'Your current password is not right.', errors: { currentPassword: 'Not right.' } });
      }
      const problem = passwordProblem(p.newPassword, u.email) ?? (p.newPassword === p.currentPassword ? 'Choose a password different from the current one.' : null);
      if (problem) throw new BadRequestException({ message: problem, errors: { newPassword: problem } });
      await tx.query('UPDATE users SET password_hash = $2, must_change_password = false, password_changed_at = now() WHERE id = $1', [
        user.userId,
        await hashSecret(p.newPassword),
      ]);
      await this.audit.byUser(tx, user, { action: 'user.password_change', entityType: 'user', entityId: user.userId });
      return { ok: true };
    });
  }

  /** Joins a sign-in to the person's own officer record, or removes the join. An officer belongs to one sign-in only. */
  private async linkOfficer(tx: Tx, userId: string, employeeId: string | null) {
    if (employeeId) {
      const e = (await tx.query('SELECT id FROM employees WHERE id = $1', [employeeId])).rows[0];
      if (!e) throw new BadRequestException({ message: 'Choose an officer from the list.', errors: { employeeId: 'Unknown officer.' } });
      const taken = (await tx.query('SELECT full_name FROM users WHERE employee_id = $1 AND id <> $2', [employeeId, userId])).rows[0];
      if (taken) throw new ConflictException({ message: `That officer record is already joined to ${taken.full_name}'s sign-in.`, errors: { employeeId: 'Already joined to another sign-in.' } });
    }
    await tx.query('UPDATE users SET employee_id = $2 WHERE id = $1', [userId, employeeId]);
  }

  /** Site-scoped roles need at least one site; everyone else sees the whole company, so sites are cleared. */
  private async checkSites(tx: Tx, role: Role, siteIds: string[]) {
    if (!SITE_SCOPED_ROLES.includes(role)) return [];
    const unique = [...new Set(siteIds)];
    if (!unique.length) throw new BadRequestException({ message: `A ${ROLE_LABELS[role].toLowerCase()} needs at least one site.`, errors: { siteIds: 'Choose at least one site.' } });
    const found = (await tx.query('SELECT id FROM sites WHERE id = ANY($1::uuid[])', [unique])).rowCount;
    if (found !== unique.length) throw new BadRequestException({ message: 'Choose sites from the list.', errors: { siteIds: 'Unknown site.' } });
    return unique;
  }

  private async rows(tx: Tx, id: string | null = null) {
    return (
      await tx.query(
        `SELECT u.id, u.full_name AS "fullName", u.email, u.role, u.active, u.must_change_password AS "mustChangePassword",
                u.created_at AS "createdAt", u.employee_id AS "employeeId",
                (SELECT e.full_name || ' (' || coalesce(e.tsf_number, e.employee_number) || ')' FROM employees e WHERE e.id = u.employee_id) AS "employeeLabel",
                coalesce(array_agg(us.site_id) FILTER (WHERE us.site_id IS NOT NULL), '{}') AS "siteIds",
                (SELECT max(a.at) FROM audit_log a WHERE a.entity_type = 'user' AND a.entity_id = u.id AND a.action = 'auth.login') AS "lastSignIn"
           FROM users u LEFT JOIN user_sites us ON us.user_id = u.id
          WHERE ($1::uuid IS NULL OR u.id = $1::uuid)
          GROUP BY u.id ORDER BY u.active DESC, lower(u.full_name)`,
        [id],
      )
    ).rows.map((r) => ({ ...r, roleLabel: ROLE_LABELS[r.role as Role] }));
  }
}
