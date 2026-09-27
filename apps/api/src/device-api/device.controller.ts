import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { z } from 'zod';
import { CurrentDevice, DeviceAuthGuard, DevicePrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService } from '../db/db.service';
import { PinService } from './pin.service';

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
    private readonly pins: PinService,
  ) {}

  /**
   * The approved contacts for this device's site (brief section 6.10): the only numbers the
   * phone can call. Available before anyone logs in, so the control room can always be reached.
   */
  @Get('contacts')
  contacts(@CurrentDevice() device: DevicePrincipal) {
    if (!device.siteId) return [];
    return this.db.withTenant(device.companyId, async (tx) => {
      const labels: Record<string, string> = { supervisor: 'Supervisor', site_manager: 'Site manager', control_room: 'Control room' };
      const order = ['supervisor', 'site_manager', 'control_room'];
      return (await tx.query('SELECT kind, name, phone FROM site_contacts WHERE site_id = $1', [device.siteId])).rows
        .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
        .map((c) => ({ kind: c.kind, label: labels[c.kind] ?? c.kind, name: c.name, phone: c.phone }));
    });
  }

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
    const e = await this.pins.check(device.companyId, { employeeNumber }, pin, device.deviceId, 'guard.login');
    const token = await this.jwt.signAsync(
      { sub: e.id, cid: device.companyId, did: device.deviceId, typ: 'guard' },
      { expiresIn: '16h' },
    );
    return { token, employee: { id: e.id, name: e.name } };
  }
}

