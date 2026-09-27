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
  deviceId: string;
  siteId: string | null;
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
