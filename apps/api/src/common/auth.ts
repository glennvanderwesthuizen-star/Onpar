import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { can, Permission, Role, SITE_SCOPED_ROLES } from '@onpar/rules';
import { hashToken } from './crypto';
import { DbService } from '../db/db.service';
import { userToken } from './session';

/** A signed-in management user. */
export interface UserPrincipal {
  kind: 'user';
  userId: string;
  companyId: string;
  role: Role;
  name: string;
  /** Null means all sites in the company. */
  siteIds: string[] | null;
}

/** A registered post device, identified by its token. */
export interface DevicePrincipal {
  kind: 'device';
  deviceId: string;
  companyId: string;
  siteId: string | null;
  label: string;
}

const PERMISSION_KEY = 'onpar:permission';
export const RequirePermission = (p: Permission) => SetMetadata(PERMISSION_KEY, p);

/** Routes a user with a temporary password may still use (to see who they are and choose a new one). */
const TEMPORARY_OK_KEY = 'onpar:temporary-ok';
export const AllowTemporaryPassword = () => SetMetadata(TEMPORARY_OK_KEY, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): UserPrincipal => {
  return ctx.switchToHttp().getRequest().principal;
});

export const CurrentDevice = createParamDecorator((_: unknown, ctx: ExecutionContext): DevicePrincipal => {
  return ctx.switchToHttp().getRequest().principal;
});

/** Requires a management user's session (the website's cookie, or a Bearer token), and the route's permission if any. */
@Injectable()
export class UserAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly db: DbService,
    private readonly reflector: Reflector,
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
    if (payload.typ !== 'user') throw new UnauthorizedException('Please sign in.');

    // Re-read the user so a deactivated account or changed role takes effect immediately.
    let mustChange = false;
    const principal = await this.db.withTenant(payload.cid, async (tx) => {
      const u = (await tx.query('SELECT id, role, active, full_name, must_change_password FROM users WHERE id = $1', [payload.sub])).rows[0];
      if (!u || !u.active) return null;
      mustChange = u.must_change_password;
      let siteIds: string[] | null = null;
      if (SITE_SCOPED_ROLES.includes(u.role)) {
        siteIds = (await tx.query('SELECT site_id FROM user_sites WHERE user_id = $1', [u.id])).rows.map(
          (r) => r.site_id,
        );
      }
      return { kind: 'user', userId: u.id, companyId: payload.cid, role: u.role, name: u.full_name, siteIds };
    });
    if (!principal) throw new UnauthorizedException('This account is no longer active.');
    req.principal = principal;
    if (mustChange && !this.reflector.getAllAndOverride<boolean>(TEMPORARY_OK_KEY, [ctx.getHandler(), ctx.getClass()])) {
      throw new ForbiddenException('Please choose your own password first.');
    }

    const permission = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (permission && !can(principal.role as Role, permission)) {
      throw new ForbiddenException('Your role does not allow this.');
    }
    return true;
  }
}

/** Requires `X-Device-Token` from a registered device that is not locked, disabled or retired. */
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(private readonly db: DbService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const token: string = req.headers['x-device-token'] ?? '';
    if (!token) throw new UnauthorizedException('Device not registered.');
    const [d] = await this.db.query<{ id: string; company_id: string; status: string; site_id: string | null; label: string }>(
      'SELECT * FROM auth_device_by_token_hash($1)',
      [hashToken(token)],
    );
    if (!d) throw new UnauthorizedException('Device not registered.');
    if (d.status !== 'registered' && d.status !== 'active') {
      throw new ForbiddenException(`This device is ${d.status}. Contact your supervisor.`);
    }
    req.principal = { kind: 'device', deviceId: d.id, companyId: d.company_id, siteId: d.site_id, label: d.label };
    return true;
  }
}

/** Throws 404 (not 403, so nothing leaks) when a site-scoped user asks for a site outside their list. */
export function assertSiteAccess(user: UserPrincipal, siteId: string) {
  if (user.siteIds && !user.siteIds.includes(siteId)) {
    throw new NotFoundException('Site not found.');
  }
}

/** A guard signed in on a post device. */
export interface GuardPrincipal {
  kind: 'guard';
  employeeId: string;
  companyId: string;
  /** The post phone. Null when a supervisor acts for himself on his own phone (D-42). */
  deviceId: string | null;
  /** The post phone's site; for a supervisor on his own phone, his home site. */
  siteId: string | null;
  /** A supervisor or site manager acting as the employee he is, signed in to the supervisor app. */
  ownPhone?: boolean;
}

export const CurrentGuard = createParamDecorator((_: unknown, ctx: ExecutionContext): GuardPrincipal => {
  return ctx.switchToHttp().getRequest().principal;
});

/**
 * Requires the device token and a guard token issued on that same device, so a
 * guard's session cannot be used from another phone.
 */
@Injectable()
export class GuardAuthGuard implements CanActivate {
  constructor(
    private readonly device: DeviceAuthGuard,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    await this.device.canActivate(ctx);
    const req = ctx.switchToHttp().getRequest();
    const d: DevicePrincipal = req.principal;
    const header: string = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    let payload: { sub: string; cid: string; did: string; typ: string };
    try {
      payload = await this.jwt.verifyAsync(token, { algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException('Please log in with your employee number and PIN.');
    }
    if (payload.typ !== 'guard' || payload.did !== d.deviceId || payload.cid !== d.companyId) {
      throw new UnauthorizedException('Please log in with your employee number and PIN.');
    }
    req.principal = { kind: 'guard', employeeId: payload.sub, companyId: d.companyId, deviceId: d.deviceId, siteId: d.siteId };
    return true;
  }
}

/** Roles that may act as their own officer record from their own phone (D-42). Guards use the post phone. */
export const SELF_SERVICE_ROLES: readonly Role[] = ['site_supervisor', 'site_manager'];

/**
 * For the pages a person has about himself (his shifts, Duty On and Duty From, score, training,
 * uniform). Two ways in: a guard on a post phone, as before; or a supervisor or site manager
 * signed in to the supervisor app whose sign-in is joined to his officer record. Either way the
 * request acts only for that one officer.
 */
@Injectable()
export class GuardOrSelfAuthGuard implements CanActivate {
  constructor(
    private readonly guard: GuardAuthGuard,
    private readonly user: UserAuthGuard,
    private readonly db: DbService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    if (req.headers['x-device-token']) return this.guard.canActivate(ctx);
    await this.user.canActivate(ctx);
    const u: UserPrincipal = req.principal;
    if (!SELF_SERVICE_ROLES.includes(u.role)) throw new ForbiddenException('Your role does not allow this.');
    const e = await this.db.withTenant(u.companyId, async (tx) =>
      (
        await tx.query(
          `SELECT e.id, e.home_site_id, e.status FROM users us JOIN employees e ON e.id = us.employee_id WHERE us.id = $1`,
          [u.userId],
        )
      ).rows[0],
    );
    if (!e) throw new ForbiddenException('Your sign-in is not joined to your officer record yet. Ask an administrator to join them on the Users page.');
    if (e.status !== 'active') throw new ForbiddenException('Your officer record is not active.');
    req.principal = { kind: 'guard', employeeId: e.id, companyId: u.companyId, deviceId: null, siteId: e.home_site_id, ownPhone: true } satisfies GuardPrincipal;
    return true;
  }
}

/**
 * A signed-in customer (phase 3, D-39): the client who hires the security company, or a
 * tenant inside a site. Never staff: a customer's sign-in opens only the customer app.
 */
export interface CustomerPrincipal {
  kind: 'customer';
  customerId: string;
  companyId: string;
  siteId: string;
  unitId: string | null;
  customerKind: 'client' | 'tenant';
  name: string;
}

export const CurrentCustomer = createParamDecorator((_: unknown, ctx: ExecutionContext): CustomerPrincipal => {
  return ctx.switchToHttp().getRequest().principal;
});

/** Requires a customer's session. A customer on a temporary password can only see who they are and choose a new one. */
@Injectable()
export class CustomerAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly db: DbService,
    private readonly reflector: Reflector,
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
    if (payload.typ !== 'customer') throw new UnauthorizedException('Please sign in.');
    // Re-read the customer so a deactivated account stops working at once.
    const c = await this.db.withTenant(payload.cid, async (tx) =>
      (await tx.query('SELECT id, site_id, unit_id, kind, full_name, active, must_change_password FROM customers WHERE id = $1', [payload.sub])).rows[0],
    );
    if (!c || !c.active) throw new UnauthorizedException('This account is no longer active.');
    req.principal = { kind: 'customer', customerId: c.id, companyId: payload.cid, siteId: c.site_id, unitId: c.unit_id, customerKind: c.kind, name: c.full_name } satisfies CustomerPrincipal;
    if (c.must_change_password && !this.reflector.getAllAndOverride<boolean>(TEMPORARY_OK_KEY, [ctx.getHandler(), ctx.getClass()])) {
      throw new ForbiddenException('Please choose your own password first.');
    }
    return true;
  }
}

/** Whoever is signed in, staff or customer, for the things both have: their own alerts and devices. */
export type AccountPrincipal = UserPrincipal | CustomerPrincipal;

export const CurrentAccount = createParamDecorator((_: unknown, ctx: ExecutionContext): AccountPrincipal => {
  return ctx.switchToHttp().getRequest().principal;
});

@Injectable()
export class AccountAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly users: UserAuthGuard,
    private readonly customers: CustomerAuthGuard,
  ) {}

  canActivate(ctx: ExecutionContext): Promise<boolean> {
    // Only to choose which check to run; that check verifies the token properly.
    const claims = this.jwt.decode<{ typ?: string } | null>(userToken(ctx.switchToHttp().getRequest()) || '');
    return claims?.typ === 'customer' ? this.customers.canActivate(ctx) : this.users.canActivate(ctx);
  }
}
