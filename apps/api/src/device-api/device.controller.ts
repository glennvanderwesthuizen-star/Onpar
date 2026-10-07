import { BadRequestException, Body, UnauthorizedException, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { normaliseTsfNumber, parseCardQr, sastDate, sastInstant } from '@onpar/rules';
import { RosterService } from '../roster/roster.service';
import { badgeOwner } from '../officers/badges';
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

// `login` is the scanned ID card, a typed TSF number or an employee number. Older app
// versions send `employeeNumber`.
const LoginBody = z.object({
  login: z.string().trim().max(200).optional(),
  employeeNumber: z.string().trim().max(200).optional(),
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
    private readonly roster: RosterService,
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

  /**
   * The guards due on duty at this phone's site about now, for the sign-in screen (owner,
   * 7 Oct 2026): a guard taps his name and types his PIN. Those whose shift starts within the
   * next three hours or is running, and who are not on duty at this moment. Names and shift times only.
   */
  @Get('expected-guards')
  expectedGuards(@CurrentDevice() device: DevicePrincipal) {
    if (!device.siteId) return [];
    return this.db.withTenant(device.companyId, async (tx) => {
      const now = new Date();
      const today = sastDate(now);
      const yesterday = sastDate(new Date(now.getTime() - 86_400_000));
      const people = (
        await tx.query(
          `SELECT e.id, e.full_name AS name, e.employee_number AS "employeeNumber", e.tsf_number AS "tsfNumber" FROM employees e
            WHERE e.status = 'active' AND e.pin_hash IS NOT NULL
              AND (e.home_site_id = $1 OR EXISTS (SELECT 1 FROM roster_allocations a WHERE a.employee_id = e.id AND a.site_id = $1 AND (a.end_date IS NULL OR a.end_date > $2::date)))
              AND NOT EXISTS (SELECT 1 FROM attendance t WHERE t.employee_id = e.id AND t.duty_from_at IS NULL)`,
          [device.siteId, yesterday],
        )
      ).rows as { id: string; name: string; employeeNumber: string | null; tsfNumber: string | null }[];
      if (!people.length) return [];
      const days = await this.roster.days(tx, people.map((p) => p.id), yesterday, today);
      const out: { login: string; name: string; shift: string; startsAt: Date }[] = [];
      for (const p of people) {
        for (const d of days.get(p.id) ?? []) {
          // A guard who was on duty earlier in this shift and went off is still listed: he may be coming back.
          if (d.status !== 'working' || d.siteId !== device.siteId) continue;
          const start = sastInstant(d.date, d.startTime.slice(0, 5));
          let end = sastInstant(d.date, d.endTime.slice(0, 5));
          if (end.getTime() <= start.getTime()) end = new Date(end.getTime() + 86_400_000);
          if (now.getTime() < start.getTime() - 3 * 3600_000 || now.getTime() >= end.getTime()) continue;
          const login = p.tsfNumber ?? p.employeeNumber;
          if (login) out.push({ login, name: p.name, shift: `${d.shiftName} ${d.startTime.slice(0, 5)} to ${d.endTime.slice(0, 5)}`, startsAt: start });
          break;
        }
      }
      return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.name.localeCompare(b.name));
    });
  }

  /** Guard login: ID card QR (or TSF number, or employee number), then the PIN, every time. */
  @Post('login')
  @HttpCode(200)
  async login(@CurrentDevice() device: DevicePrincipal, @Body() body: unknown) {
    const { login, employeeNumber, pin } = parseBody(LoginBody, body);
    const text = login || employeeNumber || '';
    if (!text) throw new BadRequestException({ message: 'Scan your ID card.', errors: { login: 'Scan your ID card.' } });
    const card = parseCardQr(text);
    let who: { employeeId: string } | { tsfNumber: string } | { employeeNumber: string };
    if (card?.kind === 'badge') {
      const owner = await this.db.withTenant(device.companyId, (tx) => badgeOwner(tx, card.token));
      if (owner === 'cancelled') throw new UnauthorizedException('This ID card has been cancelled. Use your new card, or type your TSF number.');
      if (!owner) throw new UnauthorizedException('ID card or PIN is incorrect.');
      who = owner;
    } else {
      const tsfNumber = card?.kind === 'tsf' ? card.tsfNumber : normaliseTsfNumber(text);
      who = tsfNumber ? { tsfNumber } : { employeeNumber: text };
    }
    const e = await this.pins.check(device.companyId, who, pin, device.deviceId, 'guard.login');
    const token = await this.jwt.signAsync(
      { sub: e.id, cid: device.companyId, did: device.deviceId, typ: 'guard' },
      { expiresIn: '16h' },
    );
    return { token, employee: { id: e.id, name: e.name, employeeNumber: e.employeeNumber, tsfNumber: e.tsfNumber } };
  }
}

