import { Inject, Injectable } from '@nestjs/common';
import * as webpush from 'web-push';
import { AlertKind, Role, wantsAlert } from '@onpar/rules';
import { CONFIG, Config } from '../config';
import { decrypt, encrypt } from '../common/crypto';
import { DbService } from '../db/db.service';

/** One browser a person has allowed alerts on. */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** The server's key pair for sending alerts, and who to contact about them (the website's address). */
export interface PushKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export type PushResult = { ok: true } | { ok: false; gone: boolean; detail: string };

/** Hands one alert to a browser's delivery service. Swapped for a recorder in the automated tests. */
export interface PushSender {
  send(target: PushTarget, payload: string, keys: PushKeys): Promise<PushResult>;
}

/** The real sender: encrypts the alert for that one browser and posts it to Google, Apple, Mozilla or Microsoft. */
export class WebPushSender implements PushSender {
  async send(target: PushTarget, payload: string, keys: PushKeys): Promise<PushResult> {
    try {
      await webpush.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, payload, {
        vapidDetails: { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
        // Kept for a day if the phone is off; an alert older than that is no longer useful.
        TTL: 24 * 3600,
        urgency: 'high',
        timeout: 10_000,
      });
      return { ok: true };
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      // 404 and 410 mean the browser no longer accepts alerts (switched off, or the app was removed).
      return { ok: false, gone: status === 404 || status === 410, detail: status ? `The delivery service answered ${status}.` : 'The delivery service could not be reached.' };
    }
  }
}

/** What to tell one or more people. */
export interface AlertInput {
  userIds: string[];
  kind: AlertKind;
  title: string;
  /** The details, shown only inside On Par after sign-in. */
  body?: string;
  /** The line shown on a locked screen: general, with no personal details (for example "Panic at Estate ABC"). */
  lockScreen: string;
  /** The page it opens, inside On Par. */
  url?: string;
  siteId?: string | null;
  entityType?: string;
  entityId?: string;
}

export interface DeliverySummary {
  /** Alerts recorded (one per person who receives this kind). */
  alerts: number;
  /** Devices the alert was handed to the delivery service for. */
  sent: number;
  failed: number;
  /** People with no device set up; they still see it in their alerts list. */
  noDevice: number;
}

/**
 * The alert service (plan of 6 Oct 2026). Every alert is first written to the person's alerts
 * list, so nothing is lost when a phone is off or alerts are not allowed; it is then sent to
 * each device they set up. A second channel (WhatsApp, SMS) is added in `deliver`.
 */
@Injectable()
export class NotificationsService {
  sender: PushSender = new WebPushSender();
  private cachedKeys: PushKeys | null = null;

  constructor(
    private readonly db: DbService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /** The server's alert keys, made and saved the first time they are needed. */
  async keys(): Promise<PushKeys> {
    if (this.cachedKeys) return this.cachedKeys;
    let [row] = await this.db.query<{ public_key: string; private_key_enc: string }>('SELECT * FROM push_keys_get()');
    if (!row) {
      const made = webpush.generateVAPIDKeys();
      [row] = await this.db.query('SELECT * FROM push_keys_init($1, $2)', [made.publicKey, encrypt(made.privateKey, this.config.dataKey)]);
    }
    this.cachedKeys = { publicKey: row.public_key, privateKey: decrypt(row.private_key_enc, this.config.dataKey), subject: this.config.webOrigin };
    return this.cachedKeys;
  }

  /**
   * Records the alert for each person who receives this kind (their role allows it and they
   * have not switched it off), then sends it. Never throws for a delivery problem: the alert
   * is in the list either way.
   */
  async notify(companyId: string, input: AlertInput): Promise<DeliverySummary> {
    const ids = await this.db.withTenant(companyId, async (tx) => {
      const people = (await tx.query(`SELECT id, role FROM users WHERE id = ANY($1::uuid[]) AND active`, [[...new Set(input.userIds)]])).rows as { id: string; role: Role }[];
      const out: string[] = [];
      for (const p of people) {
        const off = new Set<string>((await tx.query('SELECT kind FROM notification_prefs WHERE user_id = $1 AND NOT enabled', [p.id])).rows.map((r) => r.kind));
        if (!wantsAlert(p.role, input.kind, off)) continue;
        const r = await tx.query(
          `INSERT INTO notifications (company_id, user_id, kind, title, body, lock_screen, url, site_id, entity_type, entity_id)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [p.id, input.kind, input.title, input.body ?? '', input.lockScreen, input.url ?? '/alerts', input.siteId ?? null, input.entityType ?? null, input.entityId ?? null],
        );
        out.push(r.rows[0].id);
      }
      return out;
    });
    const summary: DeliverySummary = { alerts: ids.length, sent: 0, failed: 0, noDevice: 0 };
    for (const id of ids) {
      const r = await this.deliver(companyId, id).catch(() => ({ sent: 0, failed: 1, noDevice: 0 }));
      summary.sent += r.sent;
      summary.failed += r.failed;
      summary.noDevice += r.noDevice;
    }
    return summary;
  }

  /** Sends one recorded alert to every device its person set up, and records what happened. */
  private async deliver(companyId: string, notificationId: string) {
    const keys = await this.keys();
    const { n, targets } = await this.db.withTenant(companyId, async (tx) => {
      const n = (await tx.query('SELECT id, user_id, kind, lock_screen FROM notifications WHERE id = $1', [notificationId])).rows[0];
      const targets = (await tx.query('SELECT id, endpoint, p256dh, auth, label FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at', [n.user_id])).rows;
      return { n, targets: targets as (PushTarget & { id: string; label: string })[] };
    });
    // The alert carries only the general line. Tapping it opens the alerts list, which shows the details after sign-in.
    const payload = JSON.stringify({ id: n.id, title: 'On Par', body: n.lock_screen, url: `/alerts?open=${n.id}`, tag: `${n.kind}:${n.id}` });
    const results = await Promise.all(targets.map(async (t) => ({ t, r: await this.sender.send(t, payload, keys).catch((): PushResult => ({ ok: false, gone: false, detail: 'The alert could not be sent.' })) })));
    await this.db.withTenant(companyId, async (tx) => {
      if (!targets.length) {
        await tx.query(`INSERT INTO notification_deliveries (company_id, notification_id, channel, status) VALUES (app_company_id(), $1, 'push', 'no_device')`, [notificationId]);
      }
      for (const { t, r } of results) {
        await tx.query(`INSERT INTO notification_deliveries (company_id, notification_id, channel, status, device_label, detail) VALUES (app_company_id(), $1, 'push', $2, $3, $4)`, [
          notificationId,
          r.ok ? 'sent' : 'failed',
          t.label,
          r.ok ? '' : r.detail,
        ]);
        if (r.ok) await tx.query('UPDATE push_subscriptions SET last_ok_at = now() WHERE id = $1', [t.id]);
        // A device that no longer accepts alerts is forgotten, so the settings page shows the truth.
        else if (r.gone) await tx.query('DELETE FROM push_subscriptions WHERE id = $1', [t.id]);
      }
    });
    return { sent: results.filter((x) => x.r.ok).length, failed: results.filter((x) => !x.r.ok).length, noDevice: targets.length ? 0 : 1 };
  }
}
