import { Body, Controller, HttpCode, HttpException, HttpStatus, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { z } from 'zod';
import { CurrentDevice, DeviceAuthGuard, DevicePrincipal } from '../common/auth';
import { verifySecret } from '../common/crypto';
import { parseBody } from '../common/validation';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';

/** Five wrong PINs lock the account until a supervisor resets it (section 6.1). */
export const PIN_LOCKOUT_ATTEMPTS = 5;

const HeartbeatBody = z.object({
  appVersion: z.string().max(40).optional(),
  batteryPct: z.number().int().min(0).max(100).optional(),
  kioskStatus: z.string().max(40).optional(),
});

const LoginBody = z.object({
  employeeNumber: z.string().trim().min(1, 'Enter your employee number.'),
  pin: z.string().regex(/^\d{4,6}$/, 'Your PIN is 4 to 6 digits.'),
});

/** Endpoints the guard's post device calls. Authenticated by the device token. */
@Controller('device')
@UseGuards(DeviceAuthGuard)
export class DeviceController {
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  @Post('heartbeat')
  @HttpCode(200)
  async heartbeat(@CurrentDevice() device: DevicePrincipal, @Body() body: unknown) {
    const b = parseBody(HeartbeatBody, body);
    await this.db.withTenant(device.companyId, (tx) =>
      tx.query(
        `UPDATE devices SET last_seen_at = now(), status = CASE WHEN status = 'registered' THEN 'active' ELSE status END,
                app_version = coalesce($2, app_version), battery_pct = coalesce($3, battery_pct),
                kiosk_status = coalesce($4, kiosk_status)
          WHERE id = $1`,
        [device.deviceId, b.appVersion ?? null, b.batteryPct ?? null, b.kioskStatus ?? null],
      ),
    );
    return { serverTime: new Date().toISOString() };
  }

  /** Guard login with employee number and PIN. */
  @Post('login')
  @HttpCode(200)
  async login(@CurrentDevice() device: DevicePrincipal, @Body() body: unknown) {
    const { employeeNumber, pin } = parseBody(LoginBody, body);

    const e = await this.db.withTenant(device.companyId, async (tx) => {
      return (
        await tx.query(
          `SELECT id, full_name, pin_hash, pin_failed_attempts, pin_locked_at, status
             FROM employees WHERE employee_number = $1`,
          [employeeNumber],
        )
      ).rows[0];
    });
    const deny = () => new UnauthorizedException('Employee number or PIN is incorrect.');
    if (!e || e.status !== 'active' || !e.pin_hash) throw deny();
    if (e.pin_locked_at) throw this.locked();

    const ok = await verifySecret(e.pin_hash, pin);
    const actor = { actorType: 'employee' as const, actorId: e.id, actorLabel: e.full_name };

    const result = await this.db.withTenant(device.companyId, async (tx) => {
      if (ok) {
        // Only succeeds if nobody locked the account since it was read.
        const r = await tx.query(
          'UPDATE employees SET pin_failed_attempts = 0 WHERE id = $1 AND pin_locked_at IS NULL',
          [e.id],
        );
        if (!r.rowCount) return 'locked' as const;
        await this.audit.record(tx, { ...actor, action: 'guard.login', entityType: 'device', entityId: device.deviceId });
        return 'ok' as const;
      }
      // Increment atomically so parallel attempts cannot slip past the limit.
      const r = (
        await tx.query(
          `UPDATE employees SET pin_failed_attempts = pin_failed_attempts + 1,
                  pin_locked_at = CASE WHEN pin_failed_attempts + 1 >= $2 THEN now() ELSE pin_locked_at END
            WHERE id = $1 RETURNING pin_failed_attempts, pin_locked_at`,
          [e.id, PIN_LOCKOUT_ATTEMPTS],
        )
      ).rows[0];
      await this.audit.record(tx, {
        ...actor,
        action: r.pin_locked_at ? 'guard.locked_out' : 'guard.login_failed',
        entityType: 'device',
        entityId: device.deviceId,
        after: { failedAttempts: r.pin_failed_attempts },
      });
      return r.pin_locked_at ? ('locked' as const) : ('wrong' as const);
    });

    if (result === 'locked') throw this.locked();
    if (result === 'wrong') throw deny();

    const token = await this.jwt.signAsync(
      { sub: e.id, cid: device.companyId, did: device.deviceId, typ: 'guard' },
      { expiresIn: '16h' },
    );
    return { token, employee: { id: e.id, name: e.full_name } };
  }

  private locked() {
    return new HttpException(
      'Too many wrong PINs. Your account is locked. Ask your supervisor to reset it.',
      HttpStatus.LOCKED,
    );
  }
}

