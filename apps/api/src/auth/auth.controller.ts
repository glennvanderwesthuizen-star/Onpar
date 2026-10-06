import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Inject, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtService } from '@nestjs/jwt';
import { z } from 'zod';
import { ROLE_LABELS, Role, PERMISSIONS, can, Permission } from '@onpar/rules';
import { AllowTemporaryPassword, CurrentUser, UserAuthGuard, UserPrincipal, SELF_SERVICE_ROLES } from '../common/auth';
import { hashSecret, hashToken, verifySecret } from '../common/crypto';
import { clearSessionCookie, CSRF_HEADER, CSRF_VALUE, SESSION_HOURS, setSessionCookie } from '../common/session';
import { CONFIG, Config } from '../config';
import { parseBody } from '../common/validation';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';

const LoginBody = z.object({
  email: z.string().trim().email('Enter your email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

// Verifying against a real hash when the email is unknown keeps response times alike.
let dummyHash: Promise<string> | undefined;

/** Sign-in throttling: per email address, and per network address for guessing across many accounts. */
export const THROTTLE = {
  email: { max: 5, window: '15 minutes', lock: '15 minutes' },
  ip: { max: 30, window: '15 minutes', lock: '15 minutes' },
} as const;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /**
   * Signs in. The website gets an httpOnly cookie and no token in the body; other
   * clients get the token. Five wrong passwords for one email, or thirty from one
   * network address, lock sign-in for 15 minutes.
   */
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { email, password } = parseBody(LoginBody, body);
    const keys = { email: `email:${hashToken(email.toLowerCase())}`, ip: `ip:${req.ip ?? 'unknown'}` };
    for (const key of Object.values(keys)) {
      const [row] = await this.db.query<{ until: Date | null }>('SELECT auth_throttle_locked($1) AS until', [key]);
      if (row.until) throw tooMany(row.until);
    }
    const [u] = await this.db.query<{
      id: string;
      company_id: string;
      password_hash: string;
      role: Role;
      active: boolean;
      full_name: string;
    }>('SELECT * FROM auth_user_by_email($1)', [email]);
    const ok = await verifySecret(u?.password_hash ?? (await (dummyHash ??= hashSecret('not-a-password'))), password);
    if (!u || !ok || !u.active) {
      if (u) {
        await this.db.withTenant(u.company_id, (tx) =>
          this.audit.record(tx, {
            actorType: 'user',
            actorId: u.id,
            actorLabel: u.full_name,
            action: 'auth.login_failed',
            entityType: 'user',
            entityId: u.id,
          }),
        );
      }
      const [byEmail] = await this.db.query<{ until: Date | null }>('SELECT auth_throttle_fail($1, $2, $3, $4) AS until', [
        keys.email,
        THROTTLE.email.max,
        THROTTLE.email.window,
        THROTTLE.email.lock,
      ]);
      const [byIp] = await this.db.query<{ until: Date | null }>('SELECT auth_throttle_fail($1, $2, $3, $4) AS until', [
        keys.ip,
        THROTTLE.ip.max,
        THROTTLE.ip.window,
        THROTTLE.ip.lock,
      ]);
      const until = byEmail.until ?? byIp.until;
      if (until) {
        if (u) {
          await this.db.withTenant(u.company_id, (tx) =>
            this.audit.record(tx, { actorType: 'system', actorLabel: 'On Par', action: 'auth.locked', entityType: 'user', entityId: u.id }),
          );
        }
        throw tooMany(until);
      }
      throw new UnauthorizedException('Email or password is incorrect.');
    }
    await this.db.query('SELECT auth_throttle_clear($1)', [keys.email]);
    await this.db.withTenant(u.company_id, (tx) =>
      this.audit.record(tx, {
        actorType: 'user',
        actorId: u.id,
        actorLabel: u.full_name,
        action: 'auth.login',
        entityType: 'user',
        entityId: u.id,
      }),
    );
    const token = await this.jwt.signAsync({ sub: u.id, cid: u.company_id, typ: 'user' }, { expiresIn: `${SESSION_HOURS}h` });
    setSessionCookie(res, token, this.config.cookieSecure);
    return req.headers[CSRF_HEADER] === CSRF_VALUE ? { ok: true } : { token };
  }

  /** Signs out of the website by clearing the cookie. */
  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    clearSessionCookie(res, this.config.cookieSecure);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(UserAuthGuard)
  @AllowTemporaryPassword()
  async me(@CurrentUser() user: UserPrincipal) {
    const { company, mustChangePassword, email, employeeId } = await this.db.withTenant(user.companyId, async (tx) => {
      const u = (await tx.query('SELECT email, must_change_password, employee_id FROM users WHERE id = $1', [user.userId])).rows[0];
      return { company: (await tx.query('SELECT id, name FROM companies')).rows[0], mustChangePassword: u.must_change_password as boolean, email: u.email as string, employeeId: u.employee_id as string | null };
    });
    const permissions = (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(user.role, p));
    return {
      id: user.userId,
      name: user.name,
      email,
      mustChangePassword,
      role: user.role,
      roleLabel: ROLE_LABELS[user.role],
      company,
      siteIds: user.siteIds,
      permissions,
      // A supervisor or site manager is also an employee (D-42): his own officer record, when joined,
      // and whether his role may use the "Me" pages (his shifts, Duty On and Duty From, uniform).
      employeeId,
      selfService: SELF_SERVICE_ROLES.includes(user.role),
    };
  }
}

function tooMany(until: Date) {
  const minutes = Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 60000));
  return new HttpException(`Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, HttpStatus.TOO_MANY_REQUESTS);
}
