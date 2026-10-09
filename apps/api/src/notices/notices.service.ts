import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { ACK_TEXT, DEFAULT_ACK_HOURS, DEFAULT_DISCIPLINE, WARNING_LADDER, warningsNeedAction, needsHandDelivery, NoticeEventKind, noticeStatus, NOTICE_EVENT_LABELS, NOTICE_TYPE_LABELS, NoticeType } from '@onpar/rules';
import { AuditService } from '../audit/audit.service';
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
    private readonly audit: AuditService,
  ) {}

  /** Whether a guard signed in on the post phone may open his own notices there (owner, 9 Oct 2026; on unless switched off). */
  async onPostPhone(tx: Tx): Promise<boolean> {
    return ((await tx.query('SELECT notices_on_post_phone AS v FROM hr_settings')).rows[0]?.v as boolean | undefined) ?? true;
  }

  /** How many warnings call for action, over how many months, and the notice for an inquiry (D-53). */
  async discipline(tx: Tx): Promise<{ warningThreshold: number; warningMonths: number; hearingMinDays: number }> {
    const r = (await tx.query('SELECT warning_threshold, warning_months, hearing_min_days FROM hr_settings')).rows[0];
    return r ? { warningThreshold: r.warning_threshold, warningMonths: r.warning_months, hearingMinDays: r.hearing_min_days } : { ...DEFAULT_DISCIPLINE };
  }

  /** The employee's warnings in the period, oldest first, as later notices quote them. */
  async warningsOnFile(tx: Tx, employeeId: string, months: number) {
    return (
      await tx.query(
        `SELECT id, type, issued_at, to_char(issued_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS date, coalesce(nullif(details->>'charge', ''), subject) AS charge
           FROM notices WHERE employee_id = $1 AND type = ANY($2::text[]) AND issued_at > now() - make_interval(months => $3) ORDER BY issued_at`,
        [employeeId, WARNING_LADDER, months],
      )
    ).rows.map((r) => ({ id: r.id as string, type: r.type as NoticeType, label: NOTICE_TYPE_LABELS[r.type as NoticeType], date: r.date as string, charge: r.charge as string, issuedAt: r.issued_at as Date }));
  }

  /**
   * After a warning is sent: at the set number of warnings in the period, management is alerted
   * with all of them, to choose what to do next. Nothing else happens by itself.
   */
  async checkWarnings(tx: Tx, employeeId: string, noticeId: string) {
    const d = await this.discipline(tx);
    const ws = await this.warningsOnFile(tx, employeeId, d.warningMonths);
    if (!warningsNeedAction(ws.length, d.warningThreshold)) return false;
    const name = (await tx.query('SELECT full_name FROM employees WHERE id = $1', [employeeId])).rows[0]?.full_name ?? '';
    const ordinal = ws.length === 3 ? 'third' : `${ws.length}th`;
    await this.notifications.recordForSite(tx, null, {
      kind: 'warning_threshold',
      title: `${name}: ${ordinal} warning`,
      body: `${name} has received ${ws.length} warnings in ${d.warningMonths} months:\n${ws.map((w, i) => `${i + 1}. ${w.label}, ${w.date}: ${w.charge}`).join('\n')}\nAction is needed: send an end of line memorandum, or proceed to a disciplinary inquiry. Open the HR page.`,
      lockScreen: 'An HR matter needs your attention.',
      url: `/hr?attention=${employeeId}`,
      entityType: 'notice',
      entityId: noticeId,
    });
    return true;
  }

  /** An employee's own notices, newest first. */
  async forEmployee(tx: Tx, employeeId: string, id?: string) {
    const rows = (await tx.query(`SELECT n.id, n.type, n.subject, n.body, n.issued_at, n.documents FROM notices n WHERE n.employee_id = $1 AND ($2::uuid IS NULL OR n.id = $2::uuid) ORDER BY n.issued_at DESC`, [employeeId, id ?? null])).rows;
    const events = rows.length ? (await tx.query(`SELECT notice_id, kind, at FROM notice_events WHERE notice_id = ANY($1::uuid[])`, [rows.map((r) => r.id)])).rows : [];
    return rows.map((n) => {
      const ev = events.filter((e) => e.notice_id === n.id) as { kind: NoticeEventKind; at: Date }[];
      const status = noticeStatus(ev);
      return {
        id: n.id as string,
        typeLabel: NOTICE_TYPE_LABELS[n.type as NoticeType],
        subject: n.subject as string,
        body: n.body as string,
        /** Documents sent with it (the rights documents with a notice to appear). */
        documents: (n.documents ?? []) as { title: string; body: string }[],
        issuedAt: n.issued_at as Date,
        acknowledged: ev.find((e) => e.kind === 'acknowledged')?.at ?? null,
        status,
        statusLabel: NOTICE_EVENT_LABELS[status],
      };
    });
  }

  /** His list (without the text). Seeing it counts as delivered. `where` says how: his own page or the post phone. */
  async employeeList(tx: Tx, who: { employeeId: string; name: string }, where: string) {
    for (const n of await this.forEmployee(tx, who.employeeId)) await this.event(tx, n.id, 'delivered', { type: 'employee', id: who.employeeId, label: who.name }, where);
    return { ackText: ACK_TEXT, notices: (await this.forEmployee(tx, who.employeeId)).map(({ body: _b, ...n }) => n) };
  }

  async employeeOpen(tx: Tx, who: { employeeId: string; name: string }, id: string, where: string) {
    if (!(await this.forEmployee(tx, who.employeeId, id)).length) throw new NotFoundException('Notice not found.');
    await this.event(tx, id, 'delivered', { type: 'employee', id: who.employeeId, label: who.name }, where);
    await this.event(tx, id, 'opened', { type: 'employee', id: who.employeeId, label: who.name }, where);
    return { ...(await this.forEmployee(tx, who.employeeId, id))[0], ackText: ACK_TEXT };
  }

  async employeeAcknowledge(tx: Tx, who: { employeeId: string; name: string }, id: string, where: string) {
    if (!(await this.forEmployee(tx, who.employeeId, id)).length) throw new NotFoundException('Notice not found.');
    await this.event(tx, id, 'delivered', { type: 'employee', id: who.employeeId, label: who.name }, where);
    await this.event(tx, id, 'opened', { type: 'employee', id: who.employeeId, label: who.name }, where);
    await this.event(tx, id, 'acknowledged', { type: 'employee', id: who.employeeId, label: who.name }, `${where}. ${ACK_TEXT}`);
    await this.audit.record(tx, { actorType: 'employee', actorId: who.employeeId, actorLabel: who.name, action: 'notice.acknowledge', entityType: 'notice', entityId: id, after: { where } });
    return (await this.forEmployee(tx, who.employeeId, id))[0];
  }

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
