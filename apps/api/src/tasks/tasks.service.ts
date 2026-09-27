import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  addDays,
  sastLongDate,
  occurrenceDates,
  occurrenceDeadline,
  reconcileTime,
  sastDate,
  sastInstant,
  CouldNotCompleteReason,
  GENERATE_AHEAD_DAYS,
  Recurrence,
} from '@onpar/rules';
import type { GuardPrincipal } from '../common/auth';
import { DbService, Tx } from '../db/db.service';
import { IMAGE_TYPES, StorageService } from '../storage/storage.service';
import { ScoringService } from '../scoring/scoring.service';

export interface Upload {
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface GuardAction {
  eventId: string;
  comment: string;
  trustedAt: Date;
  deviceClock: Date;
  photoToFollow: boolean;
}

/** Columns copied from a task into each occurrence, so history shows the task as it was. */
const SNAPSHOT = `title, instructions, due_time, photo_required, assignee_type, assignee_employee_id, assignee_device_id`;

@Injectable()
export class TasksService implements OnModuleDestroy {
  private readonly log = new Logger('Tasks');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly scoring: ScoringService,
  ) {}

  /** Runs the scheduler every few minutes while the server is up. */
  startScheduler(everyMs = 5 * 60 * 1000) {
    const tick = () => this.runSchedule(new Date()).catch((e) => this.log.error(`Scheduler failed: ${e.message}`));
    tick();
    this.timer = setInterval(tick, everyMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * For every company: creates occurrences up to a week ahead and records
   * open occurrences whose day has ended as missed. Occurrences come from the
   * calendar alone, so a missed one never stops the next (scenario 9).
   */
  async runSchedule(now: Date) {
    const companies = await this.db.query<{ scheduler_company_ids: string }>('SELECT * FROM scheduler_company_ids()');
    let created = 0;
    let missed = 0;
    for (const { scheduler_company_ids: companyId } of companies) {
      await this.db.withTenant(companyId, async (tx) => {
        const tasks = (await tx.query('SELECT id FROM tasks WHERE active')).rows;
        for (const t of tasks) created += await this.generate(tx, t.id, now);
        missed += await this.sweepMissed(tx, now);
      });
    }
    return { created, missed };
  }

  /** Creates this task's occurrences through `now` plus the look-ahead. Idempotent. */
  async generate(tx: Tx, taskId: string, now: Date): Promise<number> {
    const t = (
      await tx.query(
        `SELECT id, recurrence, start_date, end_date, generated_through, active FROM tasks WHERE id = $1 FOR UPDATE`,
        [taskId],
      )
    ).rows[0];
    if (!t?.active) return 0;
    const to = addDays(sastDate(now), GENERATE_AHEAD_DAYS);
    const from = t.generated_through ? addDays(t.generated_through, 1) : t.start_date;
    if (from > to) return 0;
    const dates = occurrenceDates({ recurrence: t.recurrence as Recurrence, startDate: t.start_date, endDate: t.end_date }, from, to);
    let n = 0;
    for (const d of dates) {
      const r = await tx.query(
        `INSERT INTO task_occurrences (company_id, task_id, site_id, occurrence_date, ${SNAPSHOT})
         SELECT company_id, id, site_id, $2, ${SNAPSHOT} FROM tasks WHERE id = $1
         ON CONFLICT (task_id, occurrence_date) DO NOTHING`,
        [taskId, d],
      );
      n += r.rowCount ?? 0;
    }
    await tx.query('UPDATE tasks SET generated_through = $2 WHERE id = $1', [taskId, to]);
    return n;
  }

  /** Records open occurrences whose day has ended as missed, with a history entry. */
  async sweepMissed(tx: Tx, now: Date): Promise<number> {
    const rows = (
      await tx.query(
        `UPDATE task_occurrences
            SET state = 'missed',
                missed_at = ((occurrence_date + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg')
          WHERE state = 'open'
            AND ((occurrence_date + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg') <= $1
          RETURNING id, missed_at, title, occurrence_date, site_id, assignee_type, assignee_employee_id, assignee_device_id`,
        [now],
      )
    ).rows;
    for (const r of rows) {
      await tx.query(
        `INSERT INTO task_history (company_id, occurrence_id, at, actor_type, action, note)
         VALUES (app_company_id(), $1, $2, 'system', 'missed', 'Not done by the end of the day.')`,
        [r.id, r.missed_at],
      );
      // A task for a person costs that person the point. A task for a post costs it for
      // every guard who logged Duty On at that post and was on duty that day, since it
      // showed on each of their screens (decision D-21).
      const responsible =
        r.assignee_type === 'employee' ? [r.assignee_employee_id] : await this.guardsOnPost(tx, r.assignee_device_id, r.occurrence_date);
      for (const employeeId of responsible) {
        await this.scoring.record(tx, {
          employeeId,
          siteId: r.site_id,
          date: r.occurrence_date,
          type: 'missed_task',
          sourceType: 'task',
          sourceId: r.id,
          evidence:
            r.assignee_type === 'employee'
              ? `“${r.title}” was not done by the end of ${sastLongDate(r.occurrence_date)}.`
              : `“${r.title}” for your post was not done by the end of ${sastLongDate(r.occurrence_date)}, and you were on duty there that day.`,
        });
      }
    }
    return rows.length;
  }

  /** Guards who logged Duty On on this post's device and were on duty at some point on the date. */
  async guardsOnPost(tx: Tx, deviceId: string, date: string): Promise<string[]> {
    const { closesAt } = occurrenceDeadline(date, null);
    return (
      await tx.query(
        `SELECT DISTINCT a.employee_id
           FROM duty_events x JOIN attendance a ON a.id = x.attendance_id
          WHERE x.kind = 'duty_on' AND x.device_id = $1
            AND a.duty_on_at < $3 AND (a.duty_from_at IS NULL OR a.duty_from_at >= $2)`,
        [deviceId, sastInstant(date, '00:00'), closesAt],
      )
    ).rows.map((r) => r.employee_id);
  }

  /** Today's tasks for the guard: assigned to them, or to the post this device is at. */
  async guardTasks(guard: GuardPrincipal, now = new Date()) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      return (
        await tx.query(
          `SELECT o.id, o.occurrence_date AS "date", o.title, o.instructions, to_char(o.due_time, 'HH24:MI') AS "dueTime",
                  o.photo_required AS "photoRequired", o.state, o.done_at AS "doneAt", o.photo_pending AS "photoPending",
                  t.report_id AS "reportId"
             FROM task_occurrences o JOIN tasks t ON t.id = o.task_id
            WHERE o.occurrence_date = $1
              AND ((o.assignee_type = 'employee' AND o.assignee_employee_id = $2)
                OR (o.assignee_type = 'post' AND o.assignee_device_id = $3))
              AND o.state <> 'cancelled'
            ORDER BY o.due_time NULLS LAST, o.title`,
          [sastDate(now), guard.employeeId, guard.deviceId],
        )
      ).rows.map((o) => ({ ...o, anyTime: !o.dueTime }));
    });
  }

  /** The guard completes a task, with the photo now or (offline) later. */
  complete(guard: GuardPrincipal, occurrenceId: string, a: GuardAction, photo?: Upload, receivedAt = new Date()) {
    return this.guardAction(guard, occurrenceId, a, receivedAt, async (tx, o, at) => {
      if (o.photo_required && !photo && !a.photoToFollow) throw new BadRequestException('This task needs a photo.');
      const key = photo ? await this.store(guard, photo) : null;
      await tx.query(
        `UPDATE task_occurrences SET state = 'completed', done_by = $2, done_at = $3, comment = $4, missed_at = NULL,
                photo_key = $5, photo_content_type = $6, photo_pending = $7
          WHERE id = $1`,
        [o.id, guard.employeeId, at, a.comment, key, photo?.mimetype ?? null, !photo && a.photoToFollow],
      );
      await this.scoring.reverseFor(tx, 'task', o.id, 'missed_task', 'Done before the day ended; the device synced afterwards.', { type: 'system' });
      await this.scoring.record(tx, {
        employeeId: guard.employeeId,
        siteId: o.site_id,
        date: o.occurrence_date,
        type: 'task_completed',
        sourceType: 'task',
        sourceId: o.id,
        evidence: `Completed “${o.title}” on ${sastLongDate(o.occurrence_date)}.`,
      });
      return { action: 'completed', note: a.comment };
    });
  }

  /** "I could not complete this task", with a reason. No penalty until a supervisor reviews it (section 6.4). */
  cannotComplete(guard: GuardPrincipal, occurrenceId: string, a: GuardAction & { reason: CouldNotCompleteReason }, photo?: Upload, receivedAt = new Date()) {
    return this.guardAction(guard, occurrenceId, a, receivedAt, async (tx, o, at) => {
      if (a.reason === 'other' && !a.comment.trim()) throw new BadRequestException('Explain the reason in the comment.');
      const key = photo ? await this.store(guard, photo) : null;
      await tx.query(
        `UPDATE task_occurrences SET state = 'could_not_complete', done_by = $2, done_at = $3, comment = $4, missed_at = NULL,
                cannot_reason = $5, photo_key = $6, photo_content_type = $7, photo_pending = $8
          WHERE id = $1`,
        [o.id, guard.employeeId, at, a.comment, a.reason, key, photo?.mimetype ?? null, !photo && a.photoToFollow],
      );
      // No penalty until a supervisor reviews it; undo a missed event if it was reported in time but synced late.
      await this.scoring.reverseFor(tx, 'task', o.id, 'missed_task', 'Reported as could not complete before the day ended; the device synced afterwards.', { type: 'system' });
      return { action: 'could_not_complete', note: [a.reason, a.comment].filter(Boolean).join(': ') };
    });
  }

  /** Attaches a photo sent after the completion. Once only. */
  async attachPhoto(guard: GuardPrincipal, occurrenceId: string, photo: Upload) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      const o = (await tx.query('SELECT id, done_by, photo_key FROM task_occurrences WHERE id = $1 FOR UPDATE', [occurrenceId])).rows[0];
      if (!o || o.done_by !== guard.employeeId) throw new NotFoundException('Task not found.');
      if (!o.photo_key) {
        const key = await this.store(guard, photo);
        await tx.query(
          'UPDATE task_occurrences SET photo_key = $2, photo_content_type = $3, photo_pending = false WHERE id = $1',
          [o.id, key, photo.mimetype],
        );
      }
      return this.guardView(tx, occurrenceId);
    });
  }

  private async guardAction(
    guard: GuardPrincipal,
    occurrenceId: string,
    a: GuardAction,
    receivedAt: Date,
    apply: (tx: Tx, o: Record<string, any>, at: Date) => Promise<{ action: string; note: string }>,
  ) {
    const time = reconcileTime(a.trustedAt, a.deviceClock, receivedAt);
    if (!time.ok) throw new UnprocessableEntityException(time.reason);
    const at = time.officialAt;

    return this.db.withTenant(guard.companyId, async (tx) => {
      const seen = (await tx.query('SELECT occurrence_id FROM task_history WHERE event_id = $1', [a.eventId])).rows[0];
      if (seen) {
        if (seen.occurrence_id !== occurrenceId) throw new ConflictException('This event ID is already used.');
        return this.guardView(tx, occurrenceId);
      }
      const o = (await tx.query('SELECT * FROM task_occurrences WHERE id = $1 FOR UPDATE', [occurrenceId])).rows[0];
      const mine =
        o && ((o.assignee_type === 'employee' && o.assignee_employee_id === guard.employeeId) || (o.assignee_type === 'post' && o.assignee_device_id === guard.deviceId));
      if (!mine) throw new NotFoundException('Task not found.');
      const reportId = (await tx.query('SELECT report_id FROM tasks WHERE id = $1', [o.task_id])).rows[0].report_id;
      if (reportId) throw new ConflictException('Record this inspection on the report: Job done or Not fixed.');

      const { closesAt } = occurrenceDeadline(o.occurrence_date, null);
      if (at.getTime() < sastInstant(o.occurrence_date, '00:00').getTime()) throw new ConflictException('This task is not due yet.');
      if (o.state === 'cancelled') throw new ConflictException('This task was cancelled.');
      if (o.state === 'completed' || o.state === 'could_not_complete') throw new ConflictException('This task has already been done.');
      // A task marked missed still counts if it was done before the day ended and only synced afterwards.
      if (at.getTime() >= closesAt.getTime()) throw new ConflictException('This task was missed: the day has ended.');

      const onDuty = await tx.query(
        `SELECT 1 FROM attendance WHERE employee_id = $1 AND duty_on_at <= $2 AND (duty_from_at IS NULL OR duty_from_at >= $2)`,
        [guard.employeeId, at],
      );
      if (!onDuty.rowCount) throw new ConflictException('Log Duty On before doing tasks.');

      const wasMissed = o.state === 'missed';
      const { action, note } = await apply(tx, o, at);
      const name = (await tx.query('SELECT full_name FROM employees WHERE id = $1', [guard.employeeId])).rows[0].full_name;
      await tx.query(
        `INSERT INTO task_history (company_id, occurrence_id, at, actor_type, actor_id, actor_label, action, note, event_id,
                                   late_synced, drift_flagged)
         VALUES (app_company_id(), $1, $2, 'employee', $3, $4, $5, $6, $7, $8, $9)`,
        [o.id, at, guard.employeeId, name, action, wasMissed ? `${note} (synced after the day ended)`.trim() : note, a.eventId, time.lateSynced, time.driftFlagged],
      );
      return this.guardView(tx, occurrenceId);
    });
  }

  private store(guard: GuardPrincipal, photo: Upload) {
    if (!IMAGE_TYPES[photo.mimetype]) throw new BadRequestException('Photos must be JPEG, PNG or WebP images.');
    return this.storage.put(guard.companyId, `tasks/${guard.employeeId}`, photo.buffer, IMAGE_TYPES[photo.mimetype]);
  }

  private async guardView(tx: Tx, id: string) {
    return (
      await tx.query(
        `SELECT id, occurrence_date AS "date", title, state, done_at AS "doneAt", cannot_reason AS "cannotReason",
                photo_key IS NOT NULL AS "photoReceived", photo_pending AS "photoPending"
           FROM task_occurrences WHERE id = $1`,
        [id],
      )
    ).rows[0];
  }
}
