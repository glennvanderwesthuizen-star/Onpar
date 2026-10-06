import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ALERT_INFO, alertKindsFor, deviceLabel, isPushEndpoint } from '@onpar/rules';
import { CurrentUser, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from './notifications.service';

const SubscribeBody = z.object({
  endpoint: z.string().max(2000).refine(isPushEndpoint, 'This browser cannot receive On Par alerts.'),
  keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
});
const EndpointBody = z.object({ endpoint: z.string().max(2000) });
const PrefsBody = z.object({ off: z.array(z.string().max(40)).max(40) });

/** How many alerts the list shows. Older ones stay in the database. */
const LIST_LIMIT = 100;

/**
 * A signed-in person's own alerts: the devices they allowed alerts on, the test alert, their
 * alerts list and which alerts they receive. Everything here acts only on the caller's own rows.
 */
@Controller('notifications')
@UseGuards(UserAuthGuard)
export class NotificationsController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** What the browser needs to switch alerts on, and the devices already set up. */
  @Get('push')
  async push(@CurrentUser() user: UserPrincipal) {
    const { publicKey } = await this.notifications.keys();
    const devices = await this.db.withTenant(user.companyId, async (tx) =>
      (await tx.query(`SELECT id, label, endpoint, created_at AS "addedAt", last_ok_at AS "lastAlertAt" FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at`, [user.userId])).rows,
    );
    return { publicKey, devices };
  }

  /** Allow alerts on this device. A browser that was set up for someone else moves to the caller. */
  @Post('push/subscribe')
  @HttpCode(200)
  async subscribe(@CurrentUser() user: UserPrincipal, @Body() body: unknown, @Req() req: Request) {
    const s = parseBody(SubscribeBody, body);
    const label = deviceLabel(String(req.headers['user-agent'] ?? ''));
    await this.db.query('SELECT push_subscription_release($1, $2)', [s.endpoint, s.keys.p256dh]);
    return this.db.withTenant(user.companyId, async (tx) => {
      let id: string;
      try {
        await tx.query('SAVEPOINT add_device');
        id = (
          await tx.query(`INSERT INTO push_subscriptions (company_id, user_id, endpoint, p256dh, auth, label) VALUES (app_company_id(), $1, $2, $3, $4, $5) RETURNING id`, [
            user.userId,
            s.endpoint,
            s.keys.p256dh,
            s.keys.auth,
            label,
          ])
        ).rows[0].id;
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;
        await tx.query('ROLLBACK TO SAVEPOINT add_device');
        throw new BadRequestException('Alerts could not be switched on for this device. Turn them off in the browser, then try again.');
      }
      await this.audit.byUser(tx, user, { action: 'alerts.device_add', entityType: 'push_subscription', entityId: id, after: { label } });
      return { id, label };
    });
  }

  /** Stop alerts on the device the caller is using. */
  @Post('push/unsubscribe')
  @HttpCode(200)
  unsubscribe(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const { endpoint } = parseBody(EndpointBody, body);
    return this.remove(user, 'endpoint = $2', endpoint);
  }

  /** Stop alerts on one of the caller's other devices (for example a lost phone). */
  @Delete('push/devices/:id')
  async removeDevice(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.remove(user, 'id = $2::uuid', id);
    if (!r.removed) throw new NotFoundException('Device not found.');
    return r;
  }

  private remove(user: UserPrincipal, where: string, value: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const gone = (await tx.query(`DELETE FROM push_subscriptions WHERE user_id = $1 AND ${where} RETURNING id, label`, [user.userId, value])).rows;
      for (const g of gone) await this.audit.byUser(tx, user, { action: 'alerts.device_remove', entityType: 'push_subscription', entityId: g.id, before: { label: g.label } });
      return { removed: gone.length };
    });
  }

  /** Sends the caller a test alert on every device they set up, and says how it went. */
  @Post('test')
  @HttpCode(200)
  async test(@CurrentUser() user: UserPrincipal) {
    const result = await this.notifications.notify(user.companyId, {
      userIds: [user.userId],
      kind: 'test',
      title: 'Test alert',
      body: 'Alerts are working on this device. Real alerts will look like this one.',
      lockScreen: 'Test alert: alerts are working on this device.',
    });
    await this.db.withTenant(user.companyId, (tx) => this.audit.byUser(tx, user, { action: 'alerts.test', entityType: 'user', entityId: user.userId, after: result }));
    return result;
  }

  /** The caller's alerts, newest first, with how many are unread. */
  @Get()
  list(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const alerts = (
        await tx.query(
          `SELECT n.id, n.kind, n.title, n.body, n.url, n.site_id AS "siteId", s.name AS "siteName", n.created_at AS "at",
                  n.read_at AS "readAt", n.opened_at AS "openedAt"
             FROM notifications n LEFT JOIN sites s ON s.id = n.site_id
            WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT ${LIST_LIMIT}`,
          [user.userId],
        )
      ).rows.map((a) => ({ ...a, kindLabel: ALERT_INFO[a.kind as keyof typeof ALERT_INFO]?.label ?? 'Alert' }));
      const unread = (await tx.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [user.userId])).rows[0].n;
      return { unread, alerts };
    });
  }

  /** Marks one alert as seen. With `opened`, also records that it was opened by tapping it on the phone. */
  @Post(':id/read')
  @HttpCode(200)
  read(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { opened } = parseBody(z.object({ opened: z.boolean().default(false) }), body ?? {});
    return this.db.withTenant(user.companyId, async (tx) => {
      const r = await tx.query(
        `UPDATE notifications SET read_at = coalesce(read_at, now()), opened_at = CASE WHEN $3 THEN coalesce(opened_at, now()) ELSE opened_at END
          WHERE id = $1 AND user_id = $2 RETURNING url`,
        [id, user.userId, opened],
      );
      if (!r.rowCount) throw new NotFoundException('Alert not found.');
      return { ok: true, url: r.rows[0].url as string };
    });
  }

  @Post('read-all')
  @HttpCode(200)
  readAll(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const r = await tx.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [user.userId]);
      return { marked: r.rowCount ?? 0 };
    });
  }

  /** The alerts the caller's role can receive, and which they switched off. */
  @Get('preferences')
  preferences(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const off = new Set((await tx.query('SELECT kind FROM notification_prefs WHERE user_id = $1 AND NOT enabled', [user.userId])).rows.map((r) => r.kind));
      return alertKindsFor(user.role).map((kind) => ({ kind, label: ALERT_INFO[kind].label, about: ALERT_INFO[kind].about, optional: ALERT_INFO[kind].optional, on: !ALERT_INFO[kind].optional || !off.has(kind) }));
    });
  }

  /** Saves which alerts the caller switched off. Alerts that cannot be switched off are refused. */
  @Put('preferences')
  setPreferences(@CurrentUser() user: UserPrincipal, @Body() body: unknown) {
    const { off } = parseBody(PrefsBody, body);
    const mine = alertKindsFor(user.role);
    for (const k of off) {
      const kind = mine.find((m) => m === k);
      if (!kind) throw new BadRequestException('Choose alerts from the list.');
      if (!ALERT_INFO[kind].optional) throw new BadRequestException(`${ALERT_INFO[kind].label} alerts cannot be switched off.`);
    }
    return this.db.withTenant(user.companyId, async (tx) => {
      const before = (await tx.query('SELECT kind FROM notification_prefs WHERE user_id = $1 AND NOT enabled ORDER BY kind', [user.userId])).rows.map((r) => r.kind);
      await tx.query('DELETE FROM notification_prefs WHERE user_id = $1', [user.userId]);
      for (const kind of new Set(off)) await tx.query('INSERT INTO notification_prefs (company_id, user_id, kind, enabled) VALUES (app_company_id(), $1, $2, false)', [user.userId, kind]);
      const after = [...new Set(off)].sort();
      await this.audit.byUser(tx, user, { action: 'alerts.preferences', entityType: 'user', entityId: user.userId, before: { off: before }, after: { off: after } });
      return { off: after };
    });
  }
}
