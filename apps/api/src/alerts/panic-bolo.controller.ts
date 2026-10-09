import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { can, EMERGENCY_OPTION_KINDS, emergencyOptions, reconcileTime, Role, sastDate } from '@onpar/rules';
import { z } from 'zod';
import { CurrentDevice, CurrentUser, DeviceAuthGuard, DevicePrincipal, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { AUDIO_TYPES, IMAGE_TYPES, MAX_VIDEO_BYTES, StorageService, VIDEO_TYPES } from '../storage/storage.service';
import { ScoringService } from '../scoring/scoring.service';
import { NotificationsService } from '../notifications/notifications.service';

const isoTime = z.string().datetime({ offset: true, message: 'Send times in ISO 8601 format.' }).transform((s) => new Date(s));

const PanicBody = z.object({
  eventId: z.string().uuid(),
  trustedAt: isoTime,
  deviceClock: isoTime,
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  accuracyM: z.number().min(0).max(100000).nullish(),
  mock: z.boolean().default(false),
  callStarted: z.boolean().default(false),
});

const EmergencyCallBody = z.object({
  eventId: z.string().uuid(),
  kind: z.enum(['control_room', ...EMERGENCY_OPTION_KINDS]),
  panicId: z.string().uuid().nullish(),
  trustedAt: isoTime,
  deviceClock: isoTime,
});

const BoloBody = z.object({
  eventId: z.string().uuid(),
  note: z.string().trim().max(2000).default(''),
  trustedAt: isoTime,
  deviceClock: isoTime,
});

interface Upload {
  mimetype: string;
  size: number;
  buffer: Buffer;
}

function jsonField(body: Record<string, unknown>): unknown {
  if (typeof body?.data !== 'string') return body;
  try {
    return JSON.parse(body.data);
  } catch {
    throw new BadRequestException('The form data could not be read.');
  }
}

/**
 * The guard signed in on this phone, if any. Panic and BOLO work without anyone
 * signed in (decision D-27), so a missing or expired sign-in is not an error.
 */
async function optionalGuard(jwt: JwtService, req: Request, device: DevicePrincipal): Promise<string | null> {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    const p = await jwt.verifyAsync<{ sub: string; cid: string; did: string; typ: string }>(header.slice(7), { algorithms: ['HS256'] });
    return p.typ === 'guard' && p.did === device.deviceId && p.cid === device.companyId ? p.sub : null;
  } catch {
    return null;
  }
}

const PANIC_COLUMNS = `p.id, p.raised_at AS "raisedAt", p.received_at AS "receivedAt", p.late_synced AS "lateSynced",
  p.lat, p.lng, p.accuracy_m AS "accuracyM", p.location_mock AS "locationMock", p.call_started AS "callStarted",
  p.acknowledged_at AS "acknowledgedAt", ua.full_name AS "acknowledgedBy", p.resolved_at AS "resolvedAt",
  ur.full_name AS "resolvedBy", p.resolution_note AS "resolutionNote",
  s.id AS "siteId", s.name AS "siteName", d.label AS "deviceLabel", d.post_name AS "postName",
  e.full_name AS "employeeName", e.employee_number AS "employeeNumber",
  (SELECT coalesce(json_agg(json_build_object('service', c.service, 'national', c.national, 'calledAt', c.called_at, 'by', ce.full_name) ORDER BY c.called_at), '[]'::json)
     FROM emergency_calls c LEFT JOIN employees ce ON ce.id = c.employee_id WHERE c.panic_id = p.id) AS "emergencyCalls"`;
const PANIC_FROM = `panic_alerts p JOIN devices d ON d.id = p.device_id LEFT JOIN sites s ON s.id = p.site_id
  LEFT JOIN employees e ON e.id = p.employee_id LEFT JOIN users ua ON ua.id = p.acknowledged_by LEFT JOIN users ur ON ur.id = p.resolved_by`;

/** Panic and BOLO from the post phone (decisions D-27, D-28). Device key required; a guard sign-in is optional. */
@Controller('device')
@UseGuards(DeviceAuthGuard)
export class DevicePanicBoloController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly jwt: JwtService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Where an alert came from, for its wording: the site, the post, and the guard if one was signed in. */
  private async place(tx: Tx, device: DevicePrincipal, employeeId: string | null) {
    const r = (
      await tx.query(
        `SELECT (SELECT name FROM sites WHERE id = $1) AS site, (SELECT post_name FROM devices WHERE id = $2) AS post,
                (SELECT full_name FROM employees WHERE id = $3) AS guard`,
        [device.siteId, device.deviceId, employeeId],
      )
    ).rows[0];
    const site: string = r.site ?? 'a phone not yet assigned to a site';
    return { site, post: (r.post || device.label) as string, guard: (r.guard ?? null) as string | null, detail: [r.post || device.label, r.guard].filter(Boolean).join(' · ') };
  }

  /** Raises a panic. Safe to retry: the same eventId is recorded once. */
  @Post('panic')
  @HttpCode(200)
  async panic(@CurrentDevice() device: DevicePrincipal, @Req() req: Request, @Body() body: unknown) {
    const b = parseBody(PanicBody, body);
    const time = reconcileTime(b.trustedAt, b.deviceClock, new Date());
    if (!time.ok) throw new UnprocessableEntityException(time.reason);
    const employeeId = await optionalGuard(this.jwt, req, device);
    return this.db.withTenant(device.companyId, async (tx) => {
      const existing = (await tx.query('SELECT id FROM panic_alerts WHERE id = $1', [b.eventId])).rows[0];
      if (existing) return { id: existing.id };
      await tx.query(
        `INSERT INTO panic_alerts (id, company_id, device_id, site_id, employee_id, raised_at, late_synced, lat, lng, accuracy_m, location_mock, call_started)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [b.eventId, device.deviceId, device.siteId, employeeId, time.officialAt, time.lateSynced, b.lat ?? null, b.lng ?? null, b.accuracyM ?? null, b.mock, b.callStarted],
      );
      await this.audit.record(tx, {
        actorType: employeeId ? 'employee' : 'device',
        actorId: employeeId ?? device.deviceId,
        actorLabel: device.label,
        action: 'panic.raise',
        entityType: 'panic_alert',
        entityId: b.eventId,
        after: { siteId: device.siteId, located: b.lat != null, callStarted: b.callStarted, lateSynced: time.lateSynced },
      });
      // Tell the people responsible for the site on their own phones. The locked screen shows the site only.
      const where = await this.place(tx, device, employeeId);
      await this.notifications.recordForSite(tx, device.siteId, {
        kind: 'panic',
        title: `Panic at ${where.site}`,
        // Who and where, in plain words (owner, 7 Oct 2026). The locked screen still shows the site only.
        body: `${where.guard ?? 'Someone'} at ${where.site} has pressed the panic button (${where.post}).`,
        lockScreen: `Panic at ${where.site}`,
        url: `/m/panic/${b.eventId}`,
        entityType: 'panic_alert',
        entityId: b.eventId,
      });
      return { id: b.eventId };
    });
  }

  /**
   * The guard tapped a number on the emergency panel (owner, 7 Oct 2026). The phone dials; this
   * only records what was dialled, by whom and when, against the panic if there was one. The
   * number itself is not stored: the service and whether it was the local or national number are.
   */
  @Post('emergency-calls')
  @HttpCode(200)
  async emergencyCall(@CurrentDevice() device: DevicePrincipal, @Req() req: Request, @Body() body: unknown) {
    const b = parseBody(EmergencyCallBody, body);
    const time = reconcileTime(b.trustedAt, b.deviceClock, new Date());
    if (!time.ok) throw new UnprocessableEntityException(time.reason);
    const employeeId = await optionalGuard(this.jwt, req, device);
    return this.db.withTenant(device.companyId, async (tx) => {
      if ((await tx.query('SELECT 1 FROM emergency_calls WHERE id = $1', [b.eventId])).rowCount) return { id: b.eventId };
      // What the kind means does not depend on the site's numbers, so every kind is offered here.
      const all = { name: '', phone: 'x' };
      const option = [...emergencyOptions({}), ...emergencyOptions({ police_station: all, fire: all, ambulance: all, armed_response: all })].find((o) => o.kind === b.kind) ?? { kind: 'control_room', service: 'control_room', national: false };
      await tx.query(
        `INSERT INTO emergency_calls (id, company_id, site_id, device_id, employee_id, panic_id, service, option_kind, national, called_at, late_synced)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [b.eventId, device.siteId, device.deviceId, employeeId, b.panicId ?? null, option.service, option.kind, option.national, time.officialAt, time.lateSynced],
      );
      await this.audit.record(tx, {
        actorType: employeeId ? 'employee' : 'device',
        actorId: employeeId ?? device.deviceId,
        actorLabel: device.label,
        action: 'emergency.call',
        entityType: 'emergency_call',
        entityId: b.eventId,
        after: { siteId: device.siteId, service: option.service, national: option.national, panicId: b.panicId ?? null, lateSynced: time.lateSynced },
      });
      return { id: b.eventId };
    });
  }

  /**
   * A BOLO ("be on the lookout"): any of a photo, a short video (up to 30 seconds), a voice
   * note and a written note, in one. Multipart with `data` and the files, or JSON. Safe to retry.
   */
  @Post('bolo')
  @HttpCode(200)
  @UseInterceptors(FileFieldsInterceptor([{ name: 'photo', maxCount: 1 }, { name: 'voice', maxCount: 1 }, { name: 'video', maxCount: 1 }], { limits: { fileSize: MAX_VIDEO_BYTES } }))
  async bolo(
    @CurrentDevice() device: DevicePrincipal,
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files: { photo?: Upload[]; voice?: Upload[]; video?: Upload[] } = {},
  ) {
    const b = parseBody(BoloBody, jsonField(body));
    const time = reconcileTime(b.trustedAt, b.deviceClock, new Date());
    if (!time.ok) throw new UnprocessableEntityException(time.reason);
    const photo = files?.photo?.[0];
    const voice = files?.voice?.[0];
    const video = files?.video?.[0];
    if (photo && !IMAGE_TYPES[photo.mimetype]) throw new BadRequestException('The photo must be a JPEG, PNG or WebP image.');
    if (voice && !AUDIO_TYPES[voice.mimetype]) throw new BadRequestException('The voice note is not in a format On Par accepts.');
    if (video && !VIDEO_TYPES[video.mimetype]) throw new BadRequestException('The video must be MP4.');
    if (!photo && !voice && !video && b.note.length < 3) throw new BadRequestException('Add a photo, a video, a voice note or a written note.');
    const employeeId = await optionalGuard(this.jwt, req, device);
    return this.db.withTenant(device.companyId, async (tx) => {
      const existing = (await tx.query('SELECT id FROM bolos WHERE id = $1', [b.eventId])).rows[0];
      if (existing) return { id: existing.id };
      const put = (f: Upload | undefined, types: Record<string, string>) => (f ? this.storage.put(device.companyId, 'bolos', f.buffer, types[f.mimetype]) : Promise.resolve(null));
      const [photoKey, voiceKey, videoKey] = [await put(photo, IMAGE_TYPES), await put(voice, AUDIO_TYPES), await put(video, VIDEO_TYPES)];
      await tx.query(
        `INSERT INTO bolos (id, company_id, device_id, site_id, employee_id, note, photo_key, photo_content_type, voice_key, voice_content_type,
                            video_key, video_content_type, reported_at, late_synced)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [b.eventId, device.deviceId, device.siteId, employeeId, b.note, photoKey, photo?.mimetype ?? null, voiceKey, voice?.mimetype ?? null, videoKey, video?.mimetype ?? null, time.officialAt, time.lateSynced],
      );
      await this.audit.record(tx, {
        actorType: employeeId ? 'employee' : 'device',
        actorId: employeeId ?? device.deviceId,
        actorLabel: device.label,
        action: 'bolo.create',
        entityType: 'bolo',
        entityId: b.eventId,
        after: { siteId: device.siteId, note: b.note, photo: !!photoKey, voice: !!voiceKey, video: !!videoKey },
      });
      const where = await this.place(tx, device, employeeId);
      await this.notifications.recordForSite(tx, device.siteId, {
        kind: 'bolo',
        title: `BOLO at ${where.site}`,
        body: [where.detail, b.note.length > 140 ? `${b.note.slice(0, 140)}…` : b.note].filter(Boolean).join(' · '),
        lockScreen: `BOLO at ${where.site}`,
        url: '/reports/bolo',
        entityType: 'bolo',
        entityId: b.eventId,
      });
      return { id: b.eventId };
    });
  }
}

/** Panic alerts and BOLOs on the website. */
@Controller()
@UseGuards(UserAuthGuard)
export class PanicBoloController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly scoring: ScoringService,
  ) {}

  /**
   * What every page's banners and the Alerts count need, in one call (phase 2: before, three
   * calls every 15 to 30 seconds per open page). Null where the person's role may not see it.
   */
  @Get('banners')
  async banners(@CurrentUser() user: UserPrincipal) {
    const panics = can(user.role as Role, 'panic.view') ? await this.list(user) : null;
    const bolos = can(user.role as Role, 'reports.view') ? await this.bolos(user, undefined, 'open') : null;
    const unread = await this.db.withTenant(
      user.companyId,
      async (tx) => (await tx.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [user.userId])).rows[0].n as number,
    );
    return { panics, bolos, unread };
  }

  /** Open panics (not yet resolved), or all of the last 30 days with `status=all`. */
  @Get('panic')
  @RequirePermission('panic.view')
  list(@CurrentUser() user: UserPrincipal, @Query('status') status?: string) {
    return this.db.withTenant(user.companyId, async (tx) =>
      (
        await tx.query(
          `SELECT ${PANIC_COLUMNS} FROM ${PANIC_FROM}
            WHERE ($1::uuid[] IS NULL OR p.site_id = ANY($1::uuid[]))
              AND (CASE WHEN $2 = 'all' THEN p.raised_at > now() - interval '30 days' ELSE p.resolved_at IS NULL END)
            ORDER BY (p.resolved_at IS NULL) DESC, p.raised_at DESC`,
          [user.siteIds, status ?? 'open'],
        )
      ).rows,
    );
  }

  @Post('panic/:id/acknowledge')
  @HttpCode(200)
  @RequirePermission('panic.manage')
  acknowledge(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const p = await this.load(tx, user, id);
      if (p.acknowledged_at) return { ok: true };
      await tx.query('UPDATE panic_alerts SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1', [id, user.userId]);
      await this.audit.byUser(tx, user, { action: 'panic.acknowledge', entityType: 'panic_alert', entityId: id });
      return { ok: true };
    });
  }

  @Post('panic/:id/resolve')
  @HttpCode(200)
  @RequirePermission('panic.manage')
  resolve(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(z.object({ note: z.string().trim().min(3, 'Say what happened.').max(2000) }), body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const p = await this.load(tx, user, id);
      if (p.resolved_at) throw new ConflictException('This panic has already been resolved.');
      await tx.query(
        `UPDATE panic_alerts SET acknowledged_at = coalesce(acknowledged_at, now()), acknowledged_by = coalesce(acknowledged_by, $2),
                resolved_at = now(), resolved_by = $2, resolution_note = $3 WHERE id = $1`,
        [id, user.userId, b.note],
      );
      await this.audit.byUser(tx, user, { action: 'panic.resolve', entityType: 'panic_alert', entityId: id, reason: b.note });
      return { ok: true };
    });
  }

  private async load(tx: Tx, user: UserPrincipal, id: string) {
    const p = (await tx.query('SELECT site_id, acknowledged_at, resolved_at FROM panic_alerts WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!p || (user.siteIds && !user.siteIds.includes(p.site_id))) throw new NotFoundException('Panic alert not found.');
    return p;
  }

  /**
   * BOLOs, newest first. `status=open` gives those not yet closed (the orange alert);
   * otherwise the last 200, optionally for one site.
   */
  @Get('bolos')
  @RequirePermission('reports.view')
  bolos(@CurrentUser() user: UserPrincipal, @Query('siteId') siteId?: string, @Query('status') status?: string) {
    return this.db.withTenant(user.companyId, async (tx) =>
      (
        await tx.query(
          `SELECT b.id, b.note, b.reported_at AS "reportedAt", b.late_synced AS "lateSynced",
                  b.photo_key IS NOT NULL AS "hasPhoto", b.voice_key IS NOT NULL AS "hasVoice", b.video_key IS NOT NULL AS "hasVideo",
                  b.acknowledged_at AS "acknowledgedAt", ua.full_name AS "acknowledgedBy", b.resolved_at AS "resolvedAt",
                  ur.full_name AS "resolvedBy", b.resolution_note AS "resolutionNote",
                  pe.impact AS "awardedPoints", b.employee_id AS "employeeId",
                  s.id AS "siteId", s.name AS "siteName", d.label AS "deviceLabel", d.post_name AS "postName",
                  e.full_name AS "employeeName", e.employee_number AS "employeeNumber"
             FROM bolos b JOIN devices d ON d.id = b.device_id LEFT JOIN sites s ON s.id = b.site_id LEFT JOIN employees e ON e.id = b.employee_id
             LEFT JOIN users ua ON ua.id = b.acknowledged_by LEFT JOIN users ur ON ur.id = b.resolved_by
             LEFT JOIN performance_events pe ON pe.id = b.award_event_id
            WHERE ($1::uuid[] IS NULL OR b.site_id = ANY($1::uuid[])) AND ($2::uuid IS NULL OR b.site_id = $2::uuid)
              AND ($3::text IS DISTINCT FROM 'open' OR b.resolved_at IS NULL)
            ORDER BY b.reported_at DESC LIMIT 200`,
          [user.siteIds, siteId && /^[0-9a-f-]{36}$/i.test(siteId) ? siteId : null, status ?? null],
        )
      ).rows,
    );
  }

  @Get('bolos/:id/:media')
  @RequirePermission('reports.view')
  async boloMedia(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Param('media') media: 'photo' | 'voice' | 'video', @Res() res: Response) {
    if (!['photo', 'voice', 'video'].includes(media)) throw new NotFoundException('Not found.');
    const b = await this.db.withTenant(user.companyId, async (tx) => {
      const row = (await tx.query(`SELECT site_id, ${media}_key AS key, ${media}_content_type AS type FROM bolos WHERE id = $1`, [id])).rows[0];
      if (!row?.key || (user.siteIds && !user.siteIds.includes(row.site_id))) throw new NotFoundException('Not found.');
      if ((await tx.query('SELECT 1 FROM retention_log WHERE storage_key = $1', [row.key])).rowCount) {
        throw new NotFoundException('This was removed under the retention policy. The BOLO itself is kept.');
      }
      await this.audit.byUser(tx, user, { action: `bolo.${media}_view`, entityType: 'bolo', entityId: id });
      return row;
    });
    res.setHeader('Content-Type', b.type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(b.key));
  }

  /** "I have seen it": stops the alert flashing. */
  @Post('bolos/:id/acknowledge')
  @HttpCode(200)
  @RequirePermission('panic.manage')
  acknowledgeBolo(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const b = await this.loadBolo(tx, user, id);
      if (!b.acknowledged_at) {
        await tx.query('UPDATE bolos SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1', [id, user.userId]);
        await this.audit.byUser(tx, user, { action: 'bolo.acknowledge', entityType: 'bolo', entityId: id });
      }
      return { ok: true };
    });
  }

  /** Closes the BOLO with what was done, for example "SAPS informed". */
  @Post('bolos/:id/resolve')
  @HttpCode(200)
  @RequirePermission('panic.manage')
  resolveBolo(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const n = parseBody(z.object({ note: z.string().trim().min(3, 'Say what was done.').max(2000) }), body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const b = await this.loadBolo(tx, user, id);
      if (b.resolved_at) throw new ConflictException('This BOLO has already been closed.');
      await tx.query(
        `UPDATE bolos SET acknowledged_at = coalesce(acknowledged_at, now()), acknowledged_by = coalesce(acknowledged_by, $2),
                resolved_at = now(), resolved_by = $2, resolution_note = $3 WHERE id = $1`,
        [id, user.userId, n.note],
      );
      await this.audit.byUser(tx, user, { action: 'bolo.resolve', entityType: 'bolo', entityId: id, reason: n.note });
      return { ok: true };
    });
  }

  /**
   * Points for a useful BOLO, at a manager's or supervisor's discretion only (owner, 3 Oct 2026):
   * never automatic. Once per BOLO, within the usual award limits.
   */
  @Post('bolos/:id/award')
  @HttpCode(200)
  @RequirePermission('scores.award')
  awardBolo(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const a = parseBody(z.object({ points: z.number().int().min(1, 'At least 1 point.').max(10) }), body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const b = await this.loadBolo(tx, user, id);
      if (!b.employee_id) throw new ConflictException('Nobody was signed in on the phone, so there is nobody to give points to.');
      if (b.award_event_id) throw new ConflictException('Points have already been awarded for this BOLO.');
      const c = await this.scoring.config(tx);
      const limit = can(user.role, 'scores.reverse') ? c.managerAwardLimit : c.supervisorAwardLimit;
      if (a.points > limit) throw new ForbiddenException(`You can award up to ${limit} points.`);
      const why = `Useful BOLO${b.note ? `: ${b.note.slice(0, 120)}` : ''}`;
      const { id: eventId } = (
        await tx.query(
          `INSERT INTO performance_events (company_id, employee_id, site_id, event_date, event_type, impact, source_type, source_id, evidence,
                                           created_by_type, created_by, created_by_label, reason)
           VALUES (app_company_id(), $1, $2, $3, 'outstanding', $4, 'bolo', $5, $6, 'user', $7, $8, $6) RETURNING id`,
          [b.employee_id, b.site_id, sastDate(new Date(b.reported_at)), a.points, id, why, user.userId, user.name],
        )
      ).rows[0];
      await tx.query('UPDATE bolos SET award_event_id = $2 WHERE id = $1', [id, eventId]);
      await this.audit.byUser(tx, user, { action: 'bolo.award', entityType: 'bolo', entityId: id, after: { points: a.points } });
      return { ok: true, points: a.points };
    });
  }

  private async loadBolo(tx: Tx, user: UserPrincipal, id: string) {
    const b = (await tx.query('SELECT * FROM bolos WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!b || (user.siteIds && !user.siteIds.includes(b.site_id))) throw new NotFoundException('BOLO not found.');
    return b;
  }
}
