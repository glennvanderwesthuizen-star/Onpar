import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Res, UnprocessableEntityException, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { CAPTURE_METHODS, IDENTITY_DOCUMENTS, reconcileTime, STAFF_CODE_DIGITS } from '@onpar/rules';
import { assertSiteAccess, CurrentCustomer, CurrentGuard, CurrentUser, CustomerAuthGuard, CustomerPrincipal, GuardAuthGuard, GuardPrincipal, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { IMAGE_TYPES, MAX_UPLOAD_BYTES, StorageService } from '../storage/storage.service';
import { UnitStaffService } from './unit-staff.service';

interface Upload {
  mimetype: string;
  size: number;
  buffer: Buffer;
}
type Files = Partial<Record<'face' | 'identity', Upload[]>>;

const optional = z.string().trim().nullable().default(null).transform((v) => v || null);
const StaffBody = z.object({
  fullName: z.string().trim().max(120).default(''),
  cell: z.string().trim().max(40).default(''),
  idNumber: z.string().trim().max(40).default(''),
  days: z.array(z.number()).max(7).default([]),
  hoursFrom: optional,
  hoursTo: optional,
  endDate: optional,
});
const AdminStaffBody = StaffBody.extend({ unitId: z.string().uuid().nullable().default(null) });
const isoTime = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const FindBody = z.object({ code: z.string().transform((s) => s.replace(/\D/g, '')).pipe(z.string().length(STAFF_CODE_DIGITS, `Enter the last ${STAFF_CODE_DIGITS} digits of their cell number.`)) });
const EnterBody = z.object({
  eventId: z.string().uuid(),
  enrol: z
    .object({ idNumber: z.string().max(40), surname: z.string().trim().max(80), names: z.string().trim().max(120).default(''), document: z.enum(IDENTITY_DOCUMENTS), method: z.enum(CAPTURE_METHODS) })
    .nullable()
    .default(null),
  samePerson: z.boolean().default(true),
  handling: z.object({ note: z.string().trim().max(300).default(''), allowed: z.boolean() }).nullable().default(null),
  trustedAt: isoTime,
  deviceClock: isoTime,
});
const LeaveBody = z.object({ eventId: z.string().uuid(), trustedAt: isoTime, deviceClock: isoTime });

function jsonField(body: Record<string, unknown>): unknown {
  if (typeof body?.data !== 'string') return body;
  try {
    return JSON.parse(body.data);
  } catch {
    throw new BadRequestException('The form data could not be read.');
  }
}

/** "My staff" in the customer app: the people who work for this unit, and when. A customer sees and changes only their own unit's. */
@Controller('customer/staff')
@UseGuards(CustomerAuthGuard)
export class CustomerStaffController {
  constructor(
    private readonly db: DbService,
    private readonly staff: UnitStaffService,
  ) {}

  private unit(me: CustomerPrincipal) {
    return { unitId: me.customerKind === 'client' ? null : me.unitId };
  }

  @Get()
  list(@CurrentCustomer() me: CustomerPrincipal) {
    return this.db.withTenant(me.companyId, (tx) => this.staff.list(tx, me.siteId, this.unit(me)));
  }

  @Post()
  add(@CurrentCustomer() me: CustomerPrincipal, @Body() body: unknown) {
    const b = parseBody(StaffBody, body);
    return this.db.withTenant(me.companyId, (tx) => this.staff.create(tx, me.siteId, this.unit(me).unitId, { kind: 'customer', customer: me }, b));
  }

  @Post(':id/remove')
  @HttpCode(200)
  remove(@CurrentCustomer() me: CustomerPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(me.companyId, (tx) => this.staff.remove(tx, me.siteId, id, { kind: 'customer', customer: me }, this.unit(me)));
  }
}

/** Staff of the units of a site, on the website: the administrator registers them for a tenant who sends the details. */
@Controller('sites/:siteId/unit-staff')
@UseGuards(UserAuthGuard)
export class SiteStaffController {
  constructor(
    private readonly db: DbService,
    private readonly staff: UnitStaffService,
  ) {}

  private async site(tx: Tx, user: UserPrincipal, siteId: string) {
    assertSiteAccess(user, siteId);
    if (!(await tx.query('SELECT 1 FROM sites WHERE id = $1', [siteId])).rowCount) throw new NotFoundException('Site not found.');
  }

  @Get()
  @RequirePermission('visitors.view')
  list(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      return this.staff.list(tx, siteId);
    });
  }

  @Post()
  @RequirePermission('visitors.staff.manage')
  add(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Body() body: unknown) {
    const { unitId, ...b } = parseBody(AdminStaffBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      return this.staff.create(tx, siteId, unitId, { kind: 'user', user }, b);
    });
  }

  @Post(':id/remove')
  @RequirePermission('visitors.staff.manage')
  @HttpCode(200)
  remove(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      return this.staff.remove(tx, siteId, id, { kind: 'user', user });
    });
  }
}

/** Staff at the gate: found by the last six digits of their cell number, let in against their reference photo, and scanned out. */
@Controller('device/staff')
@UseGuards(GuardAuthGuard)
export class GateStaffController {
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly staff: UnitStaffService,
  ) {}

  private async gate(tx: Tx, guard: GuardPrincipal) {
    const r = guard.deviceId
      ? (
          await tx.query(
            `SELECT g.id, g.name, g.site_id AS "siteId", s.name AS "siteName" FROM devices d JOIN site_gates g ON g.id = d.gate_id AND g.site_id = d.site_id AND g.active
               JOIN sites s ON s.id = g.site_id WHERE d.id = $1`,
            [guard.deviceId],
          )
        ).rows[0]
      : null;
    if (!r) throw new BadRequestException('This phone is not set up as a gate phone. Ask the administrator to give it a gate on the site’s page.');
    return r as { id: string; name: string; siteId: string; siteName: string };
  }

  private async actor(tx: Tx, guard: GuardPrincipal) {
    const name = (await tx.query('SELECT full_name FROM employees WHERE id = $1', [guard.employeeId])).rows[0]?.full_name ?? '';
    return { employeeId: guard.employeeId, deviceId: guard.deviceId, companyId: guard.companyId, name };
  }

  /** Sent in the body, never in the address. */
  @Post('find')
  @HttpCode(200)
  find(@CurrentGuard() guard: GuardPrincipal, @Body() body: unknown) {
    const b = parseBody(FindBody, body);
    return this.db.withTenant(guard.companyId, async (tx) => ({ staff: await this.staff.find(tx, await this.gate(tx, guard), b.code) }));
  }

  /** The reference photo, for the guard to compare. Each look is recorded. */
  @Get(':id/photo')
  async photo(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const photo = await this.db.withTenant(guard.companyId, async (tx) => this.staff.refPhoto(tx, await this.gate(tx, guard), await this.actor(tx, guard), id));
    res.setHeader('Content-Type', photo.type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(photo.key));
  }

  /** How alike the snapshot and the reference photo are. Advice for the guard; nothing is saved. */
  @Post(':id/compare')
  @HttpCode(200)
  @UseInterceptors(FileFieldsInterceptor([{ name: 'face', maxCount: 1 }], { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  compare(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string, @UploadedFiles() files: Files = {}) {
    const face = files.face?.[0];
    if (!face || !IMAGE_TYPES[face.mimetype]) throw new BadRequestException('Take a photo of their face.');
    return this.db.withTenant(guard.companyId, async (tx) => this.staff.compare(tx, await this.gate(tx, guard), id, face));
  }

  /** Multipart: `data` (JSON), the snapshot `face`, and `identity` when the ID was typed on the first day. Safe to retry. */
  @Post(':id/enter')
  @HttpCode(200)
  @UseInterceptors(FileFieldsInterceptor([{ name: 'face', maxCount: 1 }, { name: 'identity', maxCount: 1 }], { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  enter(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @UploadedFiles() files: Files = {}) {
    const b = parseBody(EnterBody, jsonField(body));
    const time = reconcileTime(b.trustedAt, b.deviceClock, new Date());
    if (!time.ok) throw new UnprocessableEntityException(time.reason);
    const face = files.face?.[0];
    const identity = files.identity?.[0];
    for (const f of [face, identity]) if (f && !IMAGE_TYPES[f.mimetype]) throw new BadRequestException('Photos must be JPEG, PNG or WebP images.');
    return this.db.withTenant(guard.companyId, async (tx) => this.staff.enter(tx, await this.gate(tx, guard), await this.actor(tx, guard), id, b, time.officialAt, face, identity));
  }

  @Post(':id/leave')
  @HttpCode(200)
  leave(@CurrentGuard() guard: GuardPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(LeaveBody, body);
    const time = reconcileTime(b.trustedAt, b.deviceClock, new Date());
    if (!time.ok) throw new UnprocessableEntityException(time.reason);
    return this.db.withTenant(guard.companyId, async (tx) => this.staff.leave(tx, await this.gate(tx, guard), await this.actor(tx, guard), id, b.eventId, time.officialAt));
  }
}
