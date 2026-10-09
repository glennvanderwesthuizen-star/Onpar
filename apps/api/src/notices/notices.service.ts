import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { DEFAULT_ACK_HOURS, needsHandDelivery, NoticeEventKind, noticeStatus, NOTICE_EVENT_LABELS, NOTICE_TYPE_LABELS, NoticeType } from '@onpar/rules';
import { DbService, Tx } from '../db/db.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface NoticeEventRow {
  id: string;
  kind: NoticeEventKind;
  at: Date;
  actor_type: string;
  actor_label: string;
  note: string;
  photo_key: string | null;
}

/**
 * HR notices (brief section 6.16): delivery tracking and the reminder to deliver by hand. An
 * app notice alone may not be valid notice (L-03), so when the employee has not acknowledged in
 * time, HR is asked to deliver it by hand and record the signed copy.
 */
@Injectable()
export class NoticesService implements OnModuleDestroy {
  private readonly log = new Logger('Notices');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: DbService,
    private readonly notifications: NotificationsService,
  ) {}

  startTimer(everyMs = 15 * 60_000) {
    const tick = () => this.sweepAll(new Date()).catch((e) => this.log.error(`Notice sweep failed: ${e.message}`));
    this.timer = setInterval(tick, everyMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async ackHours(tx: Tx): Promise<number> {
    return ((await tx.query('SELECT notice_ack_hours AS h FROM hr_settings')).rows[0]?.h as number | undefined) ?? DEFAULT_ACK_HOURS;
  }

  async events(tx: Tx, noticeId: string): Promise<NoticeEventRow[]> {
    return (await tx.query(`SELECT id::text, kind, at, actor_type, actor_label, note, photo_key FROM notice_events WHERE notice_id = $1 ORDER BY at, id`, [noticeId])).rows;
  }

  /** Adds an event once (a second "opened" is not recorded again). */
  async event(tx: Tx, noticeId: string, kind: NoticeEventKind, actor: { type: 'user' | 'employee' | 'system'; id?: string | null; label?: string }, note = '', photo?: { key: string; type: string }) {
    await tx.query(
      `INSERT INTO notice_events (company_id, notice_id, kind, actor_type, actor_id, actor_label, note, photo_key, photo_type)
       VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
      [noticeId, kind, actor.type, actor.id ?? null, actor.label ?? '', note, photo?.key ?? null, photo?.type ?? null],
    );
  }

  /** A notice as HR sees it in a list. */
  shape(n: Record<string, any>, events: { kind: NoticeEventKind; at: Date }[]) {
    const status = noticeStatus(events);
    const at = (k: NoticeEventKind) => events.find((e) => e.kind === k)?.at ?? null;
    return {
      id: n.id as string,
      employeeId: n.employee_id as string,
      employee: n.employee as string,
      employeeNumber: n.employee_number as string,
      site: (n.site ?? null) as string | null,
      type: n.type as NoticeType,
      typeLabel: NOTICE_TYPE_LABELS[n.type as NoticeType],
      subject: n.subject as string,
      issuedAt: n.issued_at as Date,
      issuedBy: n.issued_by_name as string,
      ackDueAt: new Date(new Date(n.issued_at).getTime() + n.ack_hours * 3600_000),
      status,
      statusLabel: NOTICE_EVENT_LABELS[status],
      times: { sent: at('sent'), delivered: at('delivered'), opened: at('opened'), acknowledged: at('acknowledged'), handDeliveryRequested: at('hand_delivery_requested'), handDelivered: at('hand_delivered') },
    };
  }

  async sweepAll(now: Date) {
    let n = 0;
    for (const { scheduler_company_ids: id } of await this.db.query<{ scheduler_company_ids: string }>('SELECT * FROM scheduler_company_ids()')) {
      n += await this.db.withTenant(id, (tx) => this.sweep(tx, now));
    }
    return n;
  }

  /** Notices past their time and not acknowledged: HR is asked, once, to deliver by hand. */
  async sweep(tx: Tx, now: Date): Promise<number> {
    const open = (
      await tx.query(
        `SELECT n.id, n.issued_at, n.ack_hours, e.full_name AS employee, e.home_site_id
           FROM notices n JOIN employees e ON e.id = n.employee_id
          WHERE NOT EXISTS (SELECT 1 FROM notice_events x WHERE x.notice_id = n.id AND x.kind IN ('acknowledged','hand_delivered','hand_delivery_requested'))
            AND n.issued_at + make_interval(hours => n.ack_hours) <= $1`,
        [now],
      )
    ).rows;
    let n = 0;
    for (const o of open) {
      const events = await this.events(tx, o.id);
      if (!needsHandDelivery(new Date(o.issued_at), events, o.ack_hours, now)) continue;
      await this.event(tx, o.id, 'hand_delivery_requested', { type: 'system', label: 'On Par' }, `Not acknowledged within ${o.ack_hours} hours.`);
      await this.notifications.recordForSite(tx, null, {
        kind: 'notice_unacknowledged',
        title: 'A notice needs hand delivery',
        body: `The notice to ${o.employee} has not been acknowledged in time. Deliver it by hand and record the signed copy.`,
        lockScreen: 'An HR notice needs your attention.',
        url: `/hr?notice=${o.id}`,
        entityType: 'notice',
        entityId: o.id,
      });
      n += 1;
    }
    return n;
  }
}
