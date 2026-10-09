import { BadRequestException, Body, CanActivate, ForbiddenException, Controller, createParamDecorator, ExecutionContext, Get, HttpCode, HttpException, HttpStatus, Inject, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { POST_DEVICE_LINE, POST_PHONE_LINE } from '@onpar/rules';
import { z } from 'zod';
import { CurrentGuard, GuardAuthGuard, GuardPrincipal } from '../common/auth';
import { hashSecret, hashToken, verifySecret } from '../common/crypto';
import { clearSessionCookie, CSRF_HEADER, CSRF_VALUE, setSessionCookie, userToken } from '../common/session';
import { CONFIG, Config } from '../config';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { NoticesService } from './notices.service';
import { tidyCode } from './hr-notices.controller';

/** The employee signed in to his portal on his own phone. */
export interface PortalPrincipal {
  kind: 'portal';
  employeeId: string;
  companyId: string;
  name: string;
}

/** Personal and disciplinary matters: the portal session is a week, shorter than a customer's. */
export const PORTAL_SESSION_DAYS = 7;
const THROTTLE = { max: 5, window: '15 minutes', lock: '15 minutes' } as const;
const IP_THROTTLE = { max: 30, window: '15 minutes', lock: '15 minutes' } as const;

const LoginBody = z.object({ login: z.string().trim().min(1, 'Enter your sign-in name.').max(40), password: z.string().min(1, 'Enter your password.').max(200) });
const ActivateBody = z.object({
  code: z.string().min(1, 'Enter the code from HR.').max(40),
  password: z.string().min(8, 'Choose a password of at least 8 characters.').max(200),
});

@Injectable()
export class PortalAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly db: DbService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const token = userToken(req);
    if (!token) throw new UnauthorizedException('Please sign in.');
    let payload: { sub: string; cid: string; typ: string };
    try {
      payload = await this.jwt.verifyAsync(token, { algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException('Your session has expired. Please sign in again.');
    }
    if (payload.typ !== 'portal') throw new UnauthorizedException('Please sign in.');
    // Re-read, so a new code from HR or a leaver stops the old sign-in at once.
    const e = await this.db.withTenant(payload.cid, async (tx) =>
      (await tx.query(`SELECT e.id, e.full_name, e.status, a.password_hash FROM employees e JOIN portal_accounts a ON a.employee_id = e.id WHERE e.id = $1`, [payload.sub])).rows[0],
    );
    if (!e || e.status !== 'active' || !e.password_hash) throw new UnauthorizedException('Please sign in.');
    req.principal = { kind: 'portal', employeeId: e.id, companyId: payload.cid, name: e.full_name } satisfies PortalPrincipal;
    return true;
  }
}

export const CurrentPortal = createParamDecorator((_: unknown, ctx: ExecutionContext): PortalPrincipal => ctx.switchToHttp().getRequest().principal);

const tooMany = (until: Date) => new HttpException({ message: `Too many attempts. Try again after ${until.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' })}.` }, HttpStatus.TOO_MANY_REQUESTS);

/**
 * The employee portal (brief section 6.14; owner's step 7, 8 Oct 2026): the guard's personal
 * door, on his own phone or any browser. For now it carries his notices; queries and his roster
 * come later. Opened with a one-time code from HR, as there is no SMS yet.
 */
@Controller('portal')
export class PortalController {
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly notices: NoticesService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  private async throttle(keys: string[]) {
    for (const key of keys) {
      const [row] = await this.db.query<{ until: Date | null }>('SELECT auth_throttle_locked($1) AS until', [key]);
      if (row.until) throw tooMany(row.until);
    }
  }

  private async fail(keys: [string, string]) {
    const [a] = await this.db.query<{ until: Date | null }>('SELECT auth_throttle_fail($1, $2, $3, $4) AS until', [keys[0], THROTTLE.max, THROTTLE.window, THROTTLE.lock]);
    const [b] = await this.db.query<{ until: Date | null }>('SELECT auth_throttle_fail($1, $2, $3, $4) AS until', [keys[1], IP_THROTTLE.max, IP_THROTTLE.window, IP_THROTTLE.lock]);
    const until = a.until ?? b.until;
    if (until) throw tooMany(until);
  }

  private async session(employeeId: string, companyId: string, req: Request, res: Response) {
    const token = await this.jwt.signAsync({ sub: employeeId, cid: companyId, typ: 'portal' }, { expiresIn: `${PORTAL_SESSION_DAYS}d` });
    setSessionCookie(res, token, this.config.cookieSecure, PORTAL_SESSION_DAYS * 24);
    return req.headers[CSRF_HEADER] === CSRF_VALUE ? { ok: true } : { token };
  }

  /** First time: the code from HR, and a password of his own. */
  @Post('activate')
  @HttpCode(200)
  async activate(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const b = parseBody(ActivateBody, body);
    const code = tidyCode(b.code);
    const keys: [string, string] = [`portal-code:${hashToken(code)}`, `ip:${req.ip ?? 'unknown'}`];
    await this.throttle(keys);
    const [a] = await this.db.query<{ employee_id: string; company_id: string; login: string; code_expires_at: Date | null; active: boolean; full_name: string }>('SELECT * FROM auth_portal_by_code($1)', [hashToken(code)]);
    if (!a || !a.active || !a.code_expires_at || a.code_expires_at < new Date()) {
      await this.fail(keys);
      throw new BadRequestException({ message: 'That code is not right or has expired. Ask HR for a new one.', errors: { code: 'Not right or expired.' } });
    }
    const hash = await hashSecret(b.password);
    await this.db.withTenant(a.company_id, async (tx) => {
      await tx.query(`UPDATE portal_accounts SET password_hash = $2, code_hash = NULL, code_expires_at = NULL, activated_at = now(), updated_at = now() WHERE employee_id = $1`, [a.employee_id, hash]);
      await this.audit.record(tx, { actorType: 'employee', actorId: a.employee_id, actorLabel: a.full_name, action: 'portal.activate', entityType: 'employee', entityId: a.employee_id });
    });
    return { ...(await this.session(a.employee_id, a.company_id, req, res)), login: a.login };
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const b = parseBody(LoginBody, body);
    const login = b.login.replace(/\s+/g, '');
    const keys: [string, string] = [`portal:${login.toLowerCase()}`, `ip:${req.ip ?? 'unknown'}`];
    await this.throttle(keys);
    const [a] = await this.db.query<{ employee_id: string; company_id: string; password_hash: string | null; active: boolean; full_name: string }>('SELECT * FROM auth_portal_by_login($1)', [login]);
    const ok = !!a?.password_hash && (await verifySecret(a.password_hash, b.password));
    if (!a || !ok || !a.active) {
      if (a) await this.db.withTenant(a.company_id, (tx) => this.audit.record(tx, { actorType: 'employee', actorId: a.employee_id, actorLabel: a.full_name, action: 'portal.login_failed', entityType: 'employee', entityId: a.employee_id }));
      await this.fail(keys);
      throw new UnauthorizedException('Sign-in name or password is incorrect.');
    }
    await this.db.query('SELECT auth_throttle_clear($1)', [keys[0]]);
    await this.db.withTenant(a.company_id, (tx) => this.audit.record(tx, { actorType: 'employee', actorId: a.employee_id, actorLabel: a.full_name, action: 'portal.login', entityType: 'employee', entityId: a.employee_id }));
    return this.session(a.employee_id, a.company_id, req, res);
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    clearSessionCookie(res, this.config.cookieSecure);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(PortalAuthGuard)
  me(@CurrentPortal() me: PortalPrincipal) {
    return this.db.withTenant(me.companyId, async (tx) => {
      const e = (await tx.query(`SELECT e.full_name, e.employee_number, c.name AS company FROM employees e JOIN companies c ON c.id = e.company_id WHERE e.id = $1`, [me.employeeId])).rows[0];
      return { name: e.full_name, employeeNumber: e.employee_number, company: e.company };
    });
  }

  /** His notices. Seeing the list counts as delivered. */
  @Get('notices')
  @UseGuards(PortalAuthGuard)
  list(@CurrentPortal() me: PortalPrincipal) {
    return this.db.withTenant(me.companyId, (tx) => this.notices.employeeList(tx, { employeeId: me.employeeId, name: me.name }, 'On his own page'));
  }

  /** One notice. Opening it is recorded. */
  @Get('notices/:id')
  @UseGuards(PortalAuthGuard)
  open(@CurrentPortal() me: PortalPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(me.companyId, (tx) => this.notices.employeeOpen(tx, { employeeId: me.employeeId, name: me.name }, id, 'On his own page'));
  }

  /** "I acknowledge receipt." It does not mean he agrees or admits anything. */
  @Post('notices/:id/acknowledge')
  @HttpCode(200)
  @UseGuards(PortalAuthGuard)
  acknowledge(@CurrentPortal() me: PortalPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(me.companyId, (tx) => this.notices.employeeAcknowledge(tx, { employeeId: me.employeeId, name: me.name }, id, 'On his own page'));
  }
}

/**
 * Notices on the post phone (owner, 9 Oct 2026, D-52): the guard signed in with his own PIN, and
 * holding the phone at that moment, sees his own notices. With two guards on one phone, only the
 * one holding it sees his. The home screen line stays generic. A company can switch this off on
 * the HR page; then only the generic line shows (brief section 6.14).
 */
@Controller('device')
@UseGuards(GuardAuthGuard)
export class PersonalMessageController {
  constructor(
    private readonly db: DbService,
    private readonly notices: NoticesService,
  ) {}

  private async who(tx: Tx, guard: GuardPrincipal) {
    const name = ((await tx.query('SELECT full_name FROM employees WHERE id = $1', [guard.employeeId])).rows[0]?.full_name ?? '') as string;
    return { employeeId: guard.employeeId, name };
  }

  private async allowed(tx: Tx) {
    if (!(await this.notices.onPostPhone(tx))) throw new ForbiddenException('Notices are not shown on the post phone. Open them on your own phone or see your supervisor.');
  }

  @Get('personal-message')
  get(@CurrentGuard() guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      const n = (
        await tx.query(
          `SELECT count(*)::int AS n FROM notices x WHERE x.employee_id = $1
             AND NOT EXISTS (SELECT 1 FROM notice_events e WHERE e.notice_id = x.id AND e.kind IN ('acknowledged','hand_delivered'))`,
          [guard.employeeId],
        )
      ).rows[0].n as number;
      const here = await this.notices.onPostPhone(tx);
      return { waiting: n > 0, text: n > 0 ? (here ? POST_PHONE_LINE : POST_DEVICE_LINE) : null, canOpen: here };
    });
  }

  @Get('notices')
  list(@CurrentGuard() guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      await this.allowed(tx);
      return this.notices.employeeList(tx, await this.who(tx, guard), 'On the post phone');
    });
  }

  @Get('notices/:id')
  open(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      await this.allowed(tx);
      return this.notices.employeeOpen(tx, await this.who(tx, guard), id, 'On the post phone');
    });
  }

  @Post('notices/:id/acknowledge')
  @HttpCode(200)
  acknowledge(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      await this.allowed(tx);
      return this.notices.employeeAcknowledge(tx, await this.who(tx, guard), id, 'On the post phone');
    });
  }
}
