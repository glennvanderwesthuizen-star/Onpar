import { Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { hashToken, newDeviceToken } from '../common/crypto';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';

const RegisterBody = z.object({
  label: z.string().trim().min(1, 'Give the device a label, for example Device 001.'),
  serialOrImei: z.string().trim().min(4, 'Enter the serial number or IMEI.'),
  siteId: z.string().uuid().nullable().default(null),
  postName: z.string().trim().default(''),
});

const UpdateBody = z.object({
  siteId: z.string().uuid().nullable(),
  postName: z.string().trim(),
  status: z.enum(['registered', 'active', 'locked', 'disabled', 'retired']),
  reason: z.string().trim().min(3, 'Give a reason for the change.'),
});

const COLUMNS = `d.id, d.label, d.serial_or_imei AS "serialOrImei", d.site_id AS "siteId", s.name AS "siteName",
  d.post_name AS "postName", d.status, d.kiosk_status AS "kioskStatus", d.app_version AS "appVersion",
  d.last_seen_at AS "lastSeenAt", d.battery_pct AS "batteryPct", d.created_at AS "createdAt"`;

/** Device records (section 6.1). A device belongs to a post, not a person. */
@Controller('devices')
@UseGuards(UserAuthGuard)
export class DevicesController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('devices.view')
  list(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => {
      return (
        await tx.query(
          `SELECT ${COLUMNS} FROM devices d LEFT JOIN sites s ON s.id = d.site_id
            WHERE ($1::uuid[] IS NULL OR d.site_id = ANY($1::uuid[]))
            ORDER BY d.label`,
          [user.siteIds],
        )
      ).rows;
    });
  }

  /**
   * Registers a device and returns its secret token once. The token is
   * entered on (or pushed by the MDM to) the phone and is never shown again.
   */
  @Post()
  @RequirePermission('devices.manage')
  register(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const input = parseBody(RegisterBody, body);
    const token = newDeviceToken();
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.assertSite(tx, input.siteId);
      if ((await tx.query('SELECT 1 FROM devices WHERE serial_or_imei = $1', [input.serialOrImei])).rowCount) {
        throw new ConflictException({
          message: 'A device with this serial number or IMEI is already registered.',
          errors: { serialOrImei: 'Already registered.' },
        });
      }
      const { id } = (
        await tx.query(
          `INSERT INTO devices (company_id, label, serial_or_imei, site_id, post_name, token_hash)
           VALUES (app_company_id(), $1, $2, $3, $4, $5) RETURNING id`,
          [input.label, input.serialOrImei, input.siteId, input.postName, hashToken(token)],
        )
      ).rows[0];
      const device = await this.load(tx, id);
      await this.audit.byUser(tx, user, { action: 'device.register', entityType: 'device', entityId: id, after: device });
      return { device, deviceToken: token };
    });
  }

  /** Assign, reassign, lock, disable or retire. */
  @Put(':id')
  @RequirePermission('devices.manage')
  update(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parseBody(UpdateBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const before = await this.load(tx, id);
      if (before.status === 'retired') throw new ConflictException('A retired device cannot be changed.');
      await this.assertSite(tx, input.siteId);
      await tx.query('UPDATE devices SET site_id = $2, post_name = $3, status = $4 WHERE id = $1', [
        id,
        input.siteId,
        input.postName,
        input.status,
      ]);
      const after = await this.load(tx, id);
      await this.audit.byUser(tx, user, {
        action: 'device.update',
        entityType: 'device',
        entityId: id,
        before,
        after,
        reason: input.reason,
      });
      return after;
    });
  }

  private async assertSite(tx: Tx, siteId: string | null) {
    if (siteId && !(await tx.query('SELECT 1 FROM sites WHERE id = $1', [siteId])).rowCount) {
      throw new NotFoundException('Site not found.');
    }
  }

  private async load(tx: Tx, id: string) {
    const d = (await tx.query(`SELECT ${COLUMNS} FROM devices d LEFT JOIN sites s ON s.id = d.site_id WHERE d.id = $1`, [id]))
      .rows[0];
    if (!d) throw new NotFoundException('Device not found.');
    return d;
  }
}

