import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { reconcileTime } from '@onpar/rules';
import { z } from 'zod';
import { CurrentDevice, CurrentUser, DeviceAuthGuard, DevicePrincipal, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { IMAGE_TYPES, MAX_UPLOAD_BYTES, StorageService } from '../storage/storage.service';

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

const BoloBody = z.object({
  eventId: z.string().uuid(),
  note: z.string().trim().min(3, 'Say what to look out for.').max(2000),
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
  e.full_name AS "employeeName", e.employee_number AS "employeeNumber"`;
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
  ) {}

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
      return { id: b.eventId };
    });
  }

  /** A BOLO: a note and an optional photo. Multipart with `data` and `photo`, or JSON. Safe to retry. */
  @Post('bolo')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async bolo(@CurrentDevice() device: DevicePrincipal, @Req() req: Request, @Body() body: Record<string, unknown>, @UploadedFile() photo?: Upload) {
    const b = parseBody(BoloBody, jsonField(body));
    const time = reconcileTime(b.trustedAt, b.deviceClock, new Date());
    if (!time.ok) throw new UnprocessableEntityException(time.reason);
    if (photo && !IMAGE_TYPES[photo.mimetype]) throw new BadRequestException('The photo must be a JPEG, PNG or WebP image.');
    const employeeId = await optionalGuard(this.jwt, req, device);
    return this.db.withTenant(device.companyId, async (tx) => {
      const existing = (await tx.query('SELECT id FROM bolos WHERE id = $1', [b.eventId])).rows[0];
      if (existing) return { id: existing.id };
      const key = photo ? await this.storage.put(device.companyId, 'bolos', photo.buffer, IMAGE_TYPES[photo.mimetype]) : null;
      await tx.query(
        `INSERT INTO bolos (id, company_id, device_id, site_id, employee_id, note, photo_key, photo_content_type, reported_at, late_synced)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9)`,
        [b.eventId, device.deviceId, device.siteId, employeeId, b.note, key, photo?.mimetype ?? null, time.officialAt, time.lateSynced],
      );
      await this.audit.record(tx, {
        actorType: employeeId ? 'employee' : 'device',
        actorId: employeeId ?? device.deviceId,
        actorLabel: device.label,
        action: 'bolo.create',
        entityType: 'bolo',
        entityId: b.eventId,
        after: { siteId: device.siteId, note: b.note, photo: !!key },
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
  ) {}

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

  /** BOLOs, newest first, optionally for one site. */
  @Get('bolos')
  @RequirePermission('reports.view')
  bolos(@CurrentUser() user: UserPrincipal, @Query('siteId') siteId?: string) {
    return this.db.withTenant(user.companyId, async (tx) =>
      (
        await tx.query(
          `SELECT b.id, b.note, b.reported_at AS "reportedAt", b.late_synced AS "lateSynced", b.photo_key IS NOT NULL AS "hasPhoto",
                  s.id AS "siteId", s.name AS "siteName", d.label AS "deviceLabel", d.post_name AS "postName",
                  e.full_name AS "employeeName", e.employee_number AS "employeeNumber"
             FROM bolos b JOIN devices d ON d.id = b.device_id LEFT JOIN sites s ON s.id = b.site_id LEFT JOIN employees e ON e.id = b.employee_id
            WHERE ($1::uuid[] IS NULL OR b.site_id = ANY($1::uuid[])) AND ($2::uuid IS NULL OR b.site_id = $2::uuid)
            ORDER BY b.reported_at DESC LIMIT 200`,
          [user.siteIds, siteId && /^[0-9a-f-]{36}$/i.test(siteId) ? siteId : null],
        )
      ).rows,
    );
  }

  @Get('bolos/:id/photo')
  @RequirePermission('reports.view')
  async boloPhoto(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const b = await this.db.withTenant(user.companyId, async (tx) => {
      const row = (await tx.query('SELECT site_id, photo_key AS key, photo_content_type AS type FROM bolos WHERE id = $1', [id])).rows[0];
      if (!row?.key || (user.siteIds && !user.siteIds.includes(row.site_id))) throw new NotFoundException('Photo not found.');
      await this.audit.byUser(tx, user, { action: 'bolo.photo_view', entityType: 'bolo', entityId: id });
      return row;
    });
    res.setHeader('Content-Type', b.type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(b.key));
  }
}
