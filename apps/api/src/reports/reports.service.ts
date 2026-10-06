import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  can,
  followUpEffect,
  pickColourSlot,
  sastDate,
  sastLongDate,
  DEFAULT_ROUTING,
  FOLLOW_UP_OUTCOMES,
  FollowUpOutcome,
  MANAGEMENT_ACTIONS,
  ManagementAction,
  Priority,
  ReportCategory,
  REPORT_CATEGORIES,
  ROLE_LABELS,
  Routing,
  Stage,
  STAGE_LABELS,
} from '@onpar/rules';
import type { GuardPrincipal, UserPrincipal } from '../common/auth';
import { Tx } from '../db/db.service';
import { IMAGE_TYPES, StorageService } from '../storage/storage.service';
import { ScoringService } from '../scoring/scoring.service';
import { TasksService } from '../tasks/tasks.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface Upload {
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export type Actor =
  | { type: 'user'; user: UserPrincipal }
  | { type: 'employee'; id: string; name: string }
  | { type: 'system' };

export interface NewReport {
  siteId: string;
  category: ReportCategory;
  priority: Priority;
  description: string;
  source: 'guard' | 'user' | 'declaration' | 'patrol';
  sourceId?: string | null;
  employeeId?: string | null;
  userId?: string | null;
  deviceId?: string | null;
  reportedAt: Date;
  lateSynced?: boolean;
  eventId?: string | null;
  photo?: Upload;
  photoPending?: boolean;
}

/** The report workflow (section 6.6). All writes go through here so every step lands in the history. */
@Injectable()
export class ReportsService {
  constructor(
    private readonly storage: StorageService,
    private readonly scoring: ScoringService,
    private readonly tasks: TasksService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(tx: Tx, companyId: string, r: NewReport, actor: Actor): Promise<string> {
    if (!REPORT_CATEGORIES[r.category]) throw new BadRequestException('Choose a category.');
    if (r.photo && !IMAGE_TYPES[r.photo.mimetype]) throw new BadRequestException('Photos must be JPEG, PNG or WebP images.');
    // Numbers are per company and never reused; the lock stops two reports taking the same one.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('report-number:' || app_company_id()::text))`);
    const number = (await tx.query('SELECT coalesce(max(number), 0) + 1 AS n FROM reports')).rows[0].n as number;
    const open = (await tx.query(`SELECT colour_slot FROM reports WHERE stage <> 'closed'`)).rows.map((x) => x.colour_slot);
    const photoKey = r.photo ? await this.storage.put(companyId, 'reports', r.photo.buffer, IMAGE_TYPES[r.photo.mimetype]) : null;

    // An injury report links to the reporter's shift, so management can see what was declared at Duty On (section 6.2).
    let linkedAttendance: string | null = null;
    if (r.category === 'injury' && r.employeeId) {
      linkedAttendance =
        (
          await tx.query(
            `SELECT id FROM attendance WHERE employee_id = $1 AND duty_on_at <= $2 ORDER BY duty_on_at DESC LIMIT 1`,
            [r.employeeId, r.reportedAt],
          )
        ).rows[0]?.id ?? null;
    }

    const { id } = (
      await tx.query(
        `INSERT INTO reports (company_id, number, site_id, category, priority, description, photo_key, photo_content_type,
                              photo_pending, colour_slot, reported_by_employee, reported_by_user, device_id, source, source_id,
                              linked_attendance_id, reported_at, late_synced, event_id)
         VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         RETURNING id`,
        [
          number,
          r.siteId,
          r.category,
          r.priority,
          r.description,
          photoKey,
          r.photo?.mimetype ?? null,
          !r.photo && !!r.photoPending,
          pickColourSlot(open, number),
          r.employeeId ?? null,
          r.userId ?? null,
          r.deviceId ?? null,
          r.source,
          r.sourceId ?? null,
          linkedAttendance,
          r.reportedAt,
          !!r.lateSynced,
          r.eventId ?? null,
        ],
      )
    ).rows[0];

    // Route to the site's people for this priority (default: supervisor; plus site manager for Red).
    const site = (await tx.query('SELECT report_routing FROM sites WHERE id = $1', [r.siteId])).rows[0];
    const routing: Routing = { ...DEFAULT_ROUTING, ...(site?.report_routing ?? {}) };
    await tx.query(
      `INSERT INTO report_recipients (company_id, report_id, user_id)
       SELECT app_company_id(), $1, u.id FROM users u JOIN user_sites us ON us.user_id = u.id
        WHERE us.site_id = $2 AND u.active AND u.role = ANY($3::text[])
       ON CONFLICT DO NOTHING`,
      [id, r.siteId, routing[r.priority]],
    );

    await this.history(tx, id, actor, {
      action: 'reported',
      stageAfter: 'reported',
      note: r.source === 'declaration' ? 'Raised from a Duty On/From declaration comment.' : '',
      at: r.reportedAt,
      eventId: r.eventId ?? null,
      lateSynced: !!r.lateSynced,
    });
    // A Red report also goes to the phones of the people responsible for the site.
    if (r.priority === 'red') {
      const siteName = (await tx.query('SELECT name FROM sites WHERE id = $1', [r.siteId])).rows[0]?.name ?? 'a site';
      await this.notifications.recordForSite(tx, r.siteId, {
        kind: 'red_report',
        title: `Red report at ${siteName}`,
        body: `#${number} ${REPORT_CATEGORIES[r.category]}: ${r.description.length > 140 ? `${r.description.slice(0, 140)}…` : r.description}`,
        lockScreen: `Red report at ${siteName}`,
        url: `/reports/${id}`,
        entityType: 'report',
        entityId: id,
      });
    }
    return id;
  }

  /** A management step: assign, actioned, attendance checked, or close. */
  async act(
    tx: Tx,
    user: UserPrincipal,
    reportId: string,
    action: ManagementAction,
    input: { note: string; assigneePersonId?: string | null; photo?: Upload },
  ) {
    const rep = await this.lockForUser(tx, user, reportId);
    const rule = MANAGEMENT_ACTIONS[action];
    if (!(rule.from as readonly string[]).includes(rep.stage)) {
      throw new ConflictException(`This report is at “${STAGE_LABELS[rep.stage as Stage]}”, so it cannot be ${rule.label.toLowerCase()} now.`);
    }
    if (action === 'close' && !can(user.role, 'reports.close')) throw new ForbiddenException('Only a company manager can close reports.');
    let assignee = rep.assignee_person_id;
    if (action === 'assign') {
      const p = (await tx.query('SELECT id, name, role FROM people WHERE id = $1 AND active', [input.assigneePersonId])).rows[0];
      if (!p) throw new BadRequestException({ message: 'Choose who to assign it to.', errors: { assigneePersonId: 'Choose a person.' } });
      assignee = p.id;
    }
    if (input.photo && !IMAGE_TYPES[input.photo.mimetype]) throw new BadRequestException('Photos must be JPEG, PNG or WebP images.');
    const photoKey = input.photo ? await this.storage.put(user.companyId, 'reports', input.photo.buffer, IMAGE_TYPES[input.photo.mimetype]) : null;

    await tx.query(
      `UPDATE reports SET stage = $2, assignee_person_id = $3, needs_attention = false,
              closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE closed_at END
        WHERE id = $1`,
      [reportId, rule.to, assignee],
    );
    await this.history(tx, reportId, { type: 'user', user }, {
      action: rule.to,
      stageAfter: rule.to,
      note: input.note,
      assigneePersonId: action === 'assign' ? assignee : null,
      photoKey,
      photoType: input.photo?.mimetype ?? null,
    });

    if (rule.to === 'attendance_checked') await this.sendInspection(tx, rep);
    if (rule.to === 'closed' && rep.reported_by_employee) {
      await this.scoring.record(tx, {
        employeeId: rep.reported_by_employee,
        siteId: rep.site_id,
        date: sastDate(new Date()),
        type: 'report_closed',
        sourceType: 'report',
        sourceId: reportId,
        evidence: `Report #${rep.number} (${REPORT_CATEGORIES[rep.category as ReportCategory]}) you made on ${sastLongDate(sastDate(new Date(rep.reported_at)))} was closed.`,
      });
    }
  }

  /** A note from the higher level without changing the stage. */
  async note(tx: Tx, user: UserPrincipal, reportId: string, note: string) {
    const rep = await this.lockForUser(tx, user, reportId);
    if (rep.stage === 'closed') throw new ConflictException('This report is closed.');
    await tx.query('UPDATE reports SET needs_attention = false WHERE id = $1', [reportId]);
    await this.history(tx, reportId, { type: 'user', user }, { action: 'note', stageAfter: rep.stage, note });
  }

  /**
   * An officer on site follows up (section 6.6). The reporter can, and so can
   * any officer at the report's site. It is always added to the history and
   * flagged for the higher level; some outcomes also move the stage.
   */
  async followUp(
    tx: Tx,
    guard: GuardPrincipal,
    reportId: string,
    input: { eventId: string; outcome: FollowUpOutcome; note: string; at: Date; lateSynced: boolean; photo?: Upload },
  ) {
    const seen = (await tx.query('SELECT report_id FROM report_history WHERE event_id = $1', [input.eventId])).rows[0];
    if (seen) {
      if (seen.report_id !== reportId) throw new ConflictException('This event ID is already used.');
      return;
    }
    const rep = (await tx.query('SELECT * FROM reports WHERE id = $1 FOR UPDATE', [reportId])).rows[0];
    if (!rep || (rep.reported_by_employee !== guard.employeeId && rep.site_id !== guard.siteId)) {
      throw new NotFoundException('Report not found.');
    }
    const effect = followUpEffect(rep.stage, input.outcome);
    if (effect.kind === 'refused') throw new ConflictException(effect.reason);
    if (input.photo && !IMAGE_TYPES[input.photo.mimetype]) throw new BadRequestException('Photos must be JPEG, PNG or WebP images.');
    const photoKey = input.photo ? await this.storage.put(guard.companyId, 'reports', input.photo.buffer, IMAGE_TYPES[input.photo.mimetype]) : null;
    const name = (await tx.query('SELECT full_name FROM employees WHERE id = $1', [guard.employeeId])).rows[0].full_name;
    const stageAfter: Stage = effect.kind === 'move' ? effect.to : rep.stage;

    await tx.query('UPDATE reports SET stage = $2, needs_attention = true WHERE id = $1', [reportId, stageAfter]);
    await this.history(tx, reportId, { type: 'employee', id: guard.employeeId, name }, {
      action: 'follow_up',
      stageAfter,
      outcome: input.outcome,
      note: [FOLLOW_UP_OUTCOMES[input.outcome], input.note.trim(), effect.kind === 'move' ? effect.history : ''].filter(Boolean).join(' · '),
      at: input.at,
      eventId: input.eventId,
      lateSynced: input.lateSynced,
      photoKey,
      photoType: input.photo?.mimetype ?? null,
    });

    if (effect.kind === 'move' && effect.to === 'job_inspected') await this.finishInspection(tx, rep, guard, name, input.at);
    if (effect.kind === 'move' && effect.to === 'assigned') await this.cancelInspection(tx, rep.id, 'Not fixed: the report went back to Assigned.');
  }

  /** Sends the inspection task to the officer on site: the post the report came from, or the reporter. */
  private async sendInspection(tx: Tx, rep: Record<string, any>) {
    let post: string | null = null;
    if (rep.device_id) {
      post = (await tx.query(`SELECT id FROM devices WHERE id = $1 AND site_id = $2 AND status IN ('registered','active')`, [rep.device_id, rep.site_id])).rows[0]?.id ?? null;
    }
    post ??= (await tx.query(`SELECT id FROM devices WHERE site_id = $1 AND status IN ('registered','active') ORDER BY label LIMIT 1`, [rep.site_id])).rows[0]?.id ?? null;
    const employee = post ? null : rep.reported_by_employee;
    if (!post && !employee) return;
    const assignee = (await tx.query('SELECT name, role FROM people WHERE id = $1', [rep.assignee_person_id])).rows[0];
    const { id } = (
      await tx.query(
        `INSERT INTO tasks (company_id, site_id, title, instructions, assignee_type, assignee_employee_id, assignee_device_id,
                            recurrence, start_date, report_id)
         VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, 'once', $7, $8) RETURNING id`,
        [
          rep.site_id,
          `Inspect the work on report #${rep.number}`,
          `${assignee ? `${assignee.name} (${assignee.role}) says the work is done. ` : ''}Check it and record Job done or Not fixed on the report. Report: ${rep.description}`,
          post ? 'post' : 'employee',
          employee,
          post,
          sastDate(new Date()),
          rep.id,
        ],
      )
    ).rows[0];
    await this.tasks.generate(tx, id, new Date());
  }

  private async finishInspection(tx: Tx, rep: Record<string, any>, guard: GuardPrincipal, name: string, at: Date) {
    const occ = (
      await tx.query(
        `SELECT o.id, o.site_id, o.occurrence_date, o.title FROM task_occurrences o JOIN tasks t ON t.id = o.task_id
          WHERE t.report_id = $1 AND o.state IN ('open','missed') FOR UPDATE OF o`,
        [rep.id],
      )
    ).rows;
    for (const o of occ) {
      await tx.query(`UPDATE task_occurrences SET state = 'completed', done_by = $2, done_at = $3, missed_at = NULL WHERE id = $1`, [o.id, guard.employeeId, at]);
      await tx.query(
        `INSERT INTO task_history (company_id, occurrence_id, at, actor_type, actor_id, actor_label, action, note)
         VALUES (app_company_id(), $1, $2, 'employee', $3, $4, 'completed', $5)`,
        [o.id, at, guard.employeeId, name, `Recorded on report #${rep.number}: repair done, all OK.`],
      );
      await this.scoring.reverseFor(tx, 'task', o.id, 'missed_task', 'The inspection was recorded on the report.', { type: 'system' });
      await this.scoring.record(tx, {
        employeeId: guard.employeeId,
        siteId: o.site_id,
        date: o.occurrence_date,
        type: 'task_completed',
        sourceType: 'task',
        sourceId: o.id,
        evidence: `Inspected the work on report #${rep.number}.`,
      });
    }
  }

  private async cancelInspection(tx: Tx, reportId: string, note: string) {
    const occ = (
      await tx.query(
        `UPDATE task_occurrences o SET state = 'cancelled' FROM tasks t
          WHERE t.id = o.task_id AND t.report_id = $1 AND o.state = 'open' RETURNING o.id`,
        [reportId],
      )
    ).rows;
    for (const o of occ) {
      await tx.query(
        `INSERT INTO task_history (company_id, occurrence_id, at, actor_type, action, note) VALUES (app_company_id(), $1, now(), 'system', 'cancelled', $2)`,
        [o.id, note],
      );
    }
  }

  private async lockForUser(tx: Tx, user: UserPrincipal, reportId: string) {
    const rep = (await tx.query('SELECT * FROM reports WHERE id = $1 FOR UPDATE', [reportId])).rows[0];
    if (!rep || (user.siteIds && !user.siteIds.includes(rep.site_id))) throw new NotFoundException('Report not found.');
    return rep;
  }

  private history(
    tx: Tx,
    reportId: string,
    actor: Actor,
    h: {
      action: string;
      stageAfter: Stage;
      note?: string;
      outcome?: FollowUpOutcome;
      assigneePersonId?: string | null;
      photoKey?: string | null;
      photoType?: string | null;
      at?: Date;
      eventId?: string | null;
      lateSynced?: boolean;
    },
  ) {
    const who =
      actor.type === 'user'
        ? { id: actor.user.userId, label: actor.user.name, role: ROLE_LABELS[actor.user.role] }
        : actor.type === 'employee'
          ? { id: actor.id, label: actor.name, role: 'Security officer' }
          : { id: null, label: 'System', role: '' };
    return tx.query(
      `INSERT INTO report_history (company_id, report_id, at, actor_type, actor_id, actor_label, actor_role, action, stage_after,
                                   outcome, note, assignee_person_id, photo_key, photo_content_type, event_id, late_synced)
       VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        reportId,
        h.at ?? new Date(),
        actor.type,
        who.id,
        who.label,
        who.role,
        h.action,
        h.stageAfter,
        h.outcome ?? null,
        h.note ?? '',
        h.assigneePersonId ?? null,
        h.photoKey ?? null,
        h.photoType ?? null,
        h.eventId ?? null,
        !!h.lateSynced,
      ],
    );
  }
}
