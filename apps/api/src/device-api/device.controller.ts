import { createHash } from 'node:crypto';
import { BadRequestException, Body, UnauthorizedException, Controller, Get, HttpCode, NotFoundException, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { StorageService } from '../storage/storage.service';
import { emergencyOptions, normaliseTsfNumber, parseCardQr, sastDate, sastInstant } from '@onpar/rules';
import { RosterService } from '../roster/roster.service';
import { badgeOwner } from '../officers/badges';
import { JwtService } from '@nestjs/jwt';
import { z } from 'zod';
import { CurrentDevice, DeviceAuthGuard, DevicePrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
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
    private readonly storage: StorageService,
  ) {}

  /**
   * The approved contacts for this device's site (brief section 6.10): the only numbers the
   * phone can call. Available before anyone logs in, so the control room can always be reached.
   */
  @Get('contacts')
  contacts(@CurrentDevice() device: DevicePrincipal) {
    if (!device.siteId) return [];
    return this.db.withTenant(device.companyId, (tx) => this.contactList(tx, device.siteId!));
  }

  private async contactList(tx: Tx, siteId: string) {
    {
      const labels: Record<string, string> = { supervisor: 'Supervisor', site_manager: 'Site manager', control_room: 'Control room' };
      const order = ['supervisor', 'site_manager', 'control_room'];
      const rows = (await tx.query('SELECT kind, name, phone FROM site_contacts WHERE site_id = $1', [siteId])).rows as { kind: string; name: string; phone: string }[];
      const logo = (await tx.query('SELECT armed_response_logo_key AS key, updated_at FROM sites WHERE id = $1', [siteId])).rows[0];
      const site = rows
        .filter((c) => order.includes(c.kind))
        .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
        .map((c) => ({ kind: c.kind, label: labels[c.kind], name: c.name, phone: c.phone }));
      // The emergency panel (owner, 7 Oct 2026): police, fire, ambulance, armed response. Also approved numbers.
      const emergency = emergencyOptions(Object.fromEntries(rows.map((c) => [c.kind, c]))).map((o) => ({
        kind: o.kind,
        label: o.label,
        name: o.name,
        phone: o.phone,
        emergency: o.service,
        national: o.national,
        // Changes when the logo does, so the phone knows to fetch it again.
        logo: o.kind === 'armed_response' && logo?.key ? String(logo.key).split('/').pop() : null,
      }));
      return [...site, ...emergency];
    }
  }

  /** The armed response company's logo for this phone's site. */
  @Get('armed-response-logo')
  async armedResponseLogo(@CurrentDevice() device: DevicePrincipal, @Res() res: Response) {
    const l = device.siteId
      ? await this.db.withTenant(device.companyId, async (tx) => (await tx.query('SELECT armed_response_logo_key AS key, armed_response_logo_type AS type FROM sites WHERE id = $1', [device.siteId])).rows[0])
      : null;
    if (!l?.key) throw new NotFoundException('No logo.');
    res.setHeader('Content-Type', l.type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(l.key));
  }

  @Post('heartbeat')
  @HttpCode(200)
  async heartbeat(@CurrentDevice() device: DevicePrincipal, @Body() body: unknown) {
    const b = parseBody(HeartbeatBody, body);
    return this.db.withTenant(device.companyId, async (tx) => {
      const r = (
        await tx.query(
          `UPDATE devices SET last_seen_at = now(), status = CASE WHEN status = 'registered' THEN 'active' ELSE status END,
                  app_version = coalesce($2, app_version), battery_pct = coalesce($3, battery_pct),
                  kiosk_status = coalesce($4, kiosk_status)
            WHERE id = $1
           RETURNING EXISTS (SELECT 1 FROM site_gates g WHERE g.id = devices.gate_id AND g.site_id = devices.site_id AND g.active) AS gate`,
          [device.deviceId, b.appVersion ?? null, b.batteryPct ?? null, b.kioskStatus ?? null],
        )
      ).rows[0];
      // Phase 2: the phone fetches the contacts only when this changes, and asks for gate data only at a gate.
      const contactsTag = device.siteId ? createHash('sha256').update(JSON.stringify(await this.contactList(tx, device.siteId))).digest('hex').slice(0, 16) : '';
      return { serverTime: new Date().toISOString(), contactsTag, gate: !!r?.gate };
    });
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
      if (out.length) return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.name.localeCompare(b.name));
      // Nobody on the roster here now (no roster yet, a relief, testing): list the site's guards, so
      // the guard can still tap his name. The PIN is still needed (owner, 8 Oct 2026).
      return people
        .filter((p) => p.tsfNumber ?? p.employeeNumber)
        .map((p) => ({ login: (p.tsfNumber ?? p.employeeNumber)!, name: p.name, shift: 'Not on the roster now' }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 40);
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

