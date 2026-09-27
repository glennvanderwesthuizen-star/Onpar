import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, UnprocessableEntityException } from '@nestjs/common';
import {
  canStartPatrol,
  checkScan,
  patrolShare,
  patrolWindows,
  pointMissing,
  readingOutOfLimit,
  reconcileTime,
  sastDate,
  sastLongDate,
  sastTime,
  ALERT_ESCALATE_AFTER_MIN,
  Check,
  ReadingValue,
  SCAN_RESULT_LABELS,
} from '@onpar/rules';
import type { GuardPrincipal } from '../common/auth';
import { DbService, Tx } from '../db/db.service';
import { IMAGE_TYPES, StorageService } from '../storage/storage.service';
import { ScoringService } from '../scoring/scoring.service';
import { ReportsService } from '../reports/reports.service';

export interface Upload {
  fieldname?: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface ScanInput {
  eventId: string;
  patrolId: string;
  qrCode: string;
  lat: number;
  lng: number;
  accuracyM: number;
  trustedAt: Date;
  deviceClock: Date;
}

const MIN = 60_000;

/** Patrols on the device and the patrol timer (section 6.5). */
@Injectable()
export class PatrolsService implements OnModuleDestroy {
  private readonly log = new Logger('Patrols');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly scoring: ScoringService,
    private readonly reports: ReportsService,
  ) {}

  /** Checks for overdue patrols, escalations and missed windows every minute. */
  startTimer(everyMs = 60_000) {
    const tick = () => this.tick(new Date()).catch((e) => this.log.error(`Patrol timer failed: ${e.message}`));
    tick();
    this.timer = setInterval(tick, everyMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now: Date) {
    const companies = await this.db.query<{ scheduler_company_ids: string }>('SELECT * FROM scheduler_company_ids()');
    const out = { raised: 0, escalated: 0, missed: 0 };
    for (const { scheduler_company_ids: companyId } of companies) {
      await this.db.withTenant(companyId, async (tx) => {
        // The server can only run the timer once it has the first scan (section 6.5).
        const raised = await tx.query(
          `INSERT INTO patrol_alerts (company_id, patrol_id, site_id, employee_id, raised_at)
           SELECT company_id, id, site_id, employee_id, started_at + make_interval(mins => max_duration_minutes)
             FROM patrol_instances
            WHERE state = 'active' AND started_at + make_interval(mins => max_duration_minutes) <= $1
           ON CONFLICT (patrol_id) DO NOTHING`,
          [now],
        );
        out.raised += raised.rowCount ?? 0;
        const escalated = await tx.query(
          `UPDATE patrol_alerts SET escalated_at = raised_at + make_interval(mins => $2)
            WHERE cleared_at IS NULL AND acknowledged_at IS NULL AND escalated_at IS NULL
              AND raised_at + make_interval(mins => $2) <= $1`,
          [now, ALERT_ESCALATE_AFTER_MIN],
        );
        out.escalated += escalated.rowCount ?? 0;
        out.missed += await this.recordMissedWindows(tx, now);
      });
    }
    return out;
  }

  /** Windows that ended while the guard was on duty with no patrol of that type become missed patrols. */
  private async recordMissedWindows(tx: Tx, now: Date): Promise<number> {
    const shifts = (
      await tx.query(
        `SELECT a.id, a.employee_id, a.site_id, a.shift_id, a.scheduled_start, a.scheduled_end, a.duty_on_at, a.duty_from_at
           FROM attendance a
          WHERE a.shift_id IS NOT NULL AND a.scheduled_start < $1
            AND (a.duty_from_at IS NULL OR a.duty_from_at > $1::timestamptz - interval '1 day')`,
        [now],
      )
    ).rows;
    let n = 0;
    for (const a of shifts) {
      const rules = (
        await tx.query(
          `SELECT r.*, t.name, t.code FROM patrol_rules r JOIN patrol_types t ON t.id = r.patrol_type_id
            WHERE r.shift_id = $1 AND t.active`,
          [a.shift_id],
        )
      ).rows;
      for (const r of rules) {
        const onDutyUntil = a.duty_from_at ? new Date(a.duty_from_at).getTime() : Infinity;
        for (const w of patrolWindows(new Date(a.scheduled_start), new Date(a.scheduled_end), r.per_shift)) {
          if (w.end > now || w.end.getTime() <= new Date(a.duty_on_at).getTime() || w.start.getTime() >= onDutyUntil) continue;
          const ins = await tx.query(
            `INSERT INTO patrol_instances (id, company_id, site_id, patrol_type_id, attendance_id, employee_id, window_index,
                                           window_start, window_end, state, max_duration_minutes)
             VALUES (gen_random_uuid(), app_company_id(), $1, $2, $3, $4, $5, $6, $7, 'missed', $8)
             ON CONFLICT (attendance_id, patrol_type_id, window_index) DO NOTHING RETURNING id`,
            [a.site_id, r.patrol_type_id, a.id, a.employee_id, w.index, w.start, w.end, r.max_duration_minutes],
          );
          if (!ins.rows[0]) continue;
          n++;
          await this.scoring.record(tx, {
            employeeId: a.employee_id,
            siteId: a.site_id,
            date: sastDate(new Date(a.scheduled_start)),
            type: 'missed_patrol',
            sourceType: 'patrol',
            sourceId: ins.rows[0].id,
            evidence: `No ${r.name} patrol (${r.code}) in the ${sastTime(w.start)}–${sastTime(w.end)} window on ${sastLongDate(sastDate(w.start))}.`,
          });
        }
      }
    }
    return n;
  }

  /** What the device shows: each patrol type, what is due, when the next opens, and the patrol in progress. */
  async state(guard: GuardPrincipal, now = new Date()) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      const a = await this.onDutyAt(tx, guard, now);
      if (!a) return { onDuty: false, types: [], active: null };
      const types = (
        await tx.query(
          `SELECT t.id, t.code, t.name, t.single_scan AS "singleScan", r.per_shift AS "perShift",
                  r.min_gap_minutes AS "minGapMinutes", r.max_duration_minutes AS "maxDurationMinutes"
             FROM patrol_types t JOIN patrol_rules r ON r.patrol_type_id = t.id AND r.shift_id = $2
            WHERE t.site_id = $1 AND t.active ORDER BY t.code`,
          [a.site_id, a.shift_id],
        )
      ).rows;
      const out = [];
      for (const t of types) {
        const h = await this.history(tx, a.id, guard.employeeId, t.id);
        const windows = patrolWindows(new Date(a.scheduled_start), new Date(a.scheduled_end), t.perShift);
        const check = canStartPatrol(now, windows, t, h);
        const done = (await tx.query(`SELECT count(*)::int AS n FROM patrol_instances WHERE attendance_id = $1 AND patrol_type_id = $2 AND state = 'completed'`, [a.id, t.id])).rows[0].n;
        const points = (
          await tx.query(
            // qrHash lets the phone recognise a scanned point with no signal, without ever holding the codes themselves.
            `SELECT id, name, instruction, photo_mode AS "photoMode", note_mode AS "noteMode", checks, lat, lng, radius_m AS "radiusM",
                    encode(sha256(convert_to(qr_code, 'UTF8')), 'hex') AS "qrHash"
               FROM patrol_points WHERE patrol_type_id = $1 AND active ORDER BY sort_order, name`,
            [t.id],
          )
        ).rows;
        out.push({
          ...t,
          done,
          canStart: check.ok,
          reason: check.ok ? null : check.reason,
          opensAt: check.ok ? null : check.opensAt,
          points,
        });
      }
      const act = (await tx.query(`SELECT id FROM patrol_instances WHERE employee_id = $1 AND state = 'active'`, [guard.employeeId])).rows[0];
      return { onDuty: true, types: out, active: act ? await this.patrolView(tx, act.id) : null };
    });
  }

  /**
   * A scan. The first accepted scan of a new patrol ID starts the patrol and its
   * clock. Every scan is logged, including rejected ones. Rejections return
   * accepted: false with the reason, rather than an error, so the log is kept.
   */
  async scan(guard: GuardPrincipal, s: ScanInput, receivedAt = new Date()) {
    const time = reconcileTime(s.trustedAt, s.deviceClock, receivedAt);
    if (!time.ok) throw new UnprocessableEntityException(time.reason);
    const at = time.officialAt;
    return this.db.withTenant(guard.companyId, async (tx) => {
      const seen = (await tx.query('SELECT result, patrol_id FROM patrol_scans WHERE id = $1', [s.eventId])).rows[0];
      if (seen) return this.scanReply(tx, seen.result, seen.patrol_id);

      const a = await this.onDutyAt(tx, guard, at);
      if (!a) throw new ConflictException('Log Duty On before patrolling.');
      const point = (await tx.query('SELECT * FROM patrol_points WHERE qr_code = $1 AND active', [s.qrCode])).rows[0];
      const log = (result: string, patrolId: string | null, distanceM: number | null) =>
        tx.query(
          `INSERT INTO patrol_scans (id, company_id, patrol_id, point_id, employee_id, device_id, qr_code, lat, lng, accuracy_m, distance_m,
                                     result, official_at, received_at, late_synced)
           VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [s.eventId, patrolId, point?.id ?? null, guard.employeeId, guard.deviceId, s.qrCode, s.lat, s.lng, s.accuracyM, distanceM, result, at, receivedAt, time.lateSynced],
        );
      if (!point || point.site_id !== a.site_id) {
        await log('rejected_unknown_code', null, null);
        return this.scanReply(tx, 'rejected_unknown_code', null);
      }

      let patrol = (await tx.query('SELECT * FROM patrol_instances WHERE id = $1', [s.patrolId])).rows[0];
      if (patrol && (patrol.employee_id !== guard.employeeId || patrol.state !== 'active')) {
        throw new ConflictException('That patrol is not in progress.');
      }
      if (patrol && patrol.patrol_type_id !== point.patrol_type_id) {
        await log('rejected_wrong_type', patrol.id, null);
        return this.scanReply(tx, 'rejected_wrong_type', patrol.id);
      }

      const last = (
        await tx.query(
          `SELECT official_at FROM patrol_scans WHERE employee_id = $1 AND point_id = $2 AND result = 'accepted' ORDER BY official_at DESC LIMIT 1`,
          [guard.employeeId, point.id],
        )
      ).rows[0];
      const since = last ? (at.getTime() - new Date(last.official_at).getTime()) / 1000 : null;
      const check = checkScan({ lat: s.lat, lng: s.lng, accuracyM: s.accuracyM }, { lat: point.lat, lng: point.lng, radiusM: point.radius_m }, since);
      if (check.result !== 'accepted') {
        await log(check.result, patrol?.id ?? null, check.distanceM);
        return this.scanReply(tx, check.result, patrol?.id ?? null, check.distanceM);
      }

      if (!patrol) {
        const rule = (
          await tx.query(
            `SELECT r.per_shift AS "perShift", r.min_gap_minutes AS "minGapMinutes", r.max_duration_minutes AS "maxDurationMinutes"
               FROM patrol_rules r WHERE r.patrol_type_id = $1 AND r.shift_id = $2`,
            [point.patrol_type_id, a.shift_id],
          )
        ).rows[0];
        if (!rule) throw new ConflictException('This patrol is not set up for your shift.');
        const windows = patrolWindows(new Date(a.scheduled_start), new Date(a.scheduled_end), rule.perShift);
        const start = canStartPatrol(at, windows, rule, await this.history(tx, a.id, guard.employeeId, point.patrol_type_id));
        if (!start.ok) {
          await log('rejected_not_open', null, check.distanceM);
          return { accepted: false, result: 'rejected_not_open', message: start.reason, opensAt: start.opensAt, patrol: null };
        }
        await tx.query(
          `INSERT INTO patrol_instances (id, company_id, site_id, patrol_type_id, attendance_id, employee_id, device_id, window_index,
                                         window_start, window_end, state, started_at, max_duration_minutes)
           VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $11)`,
          [s.patrolId, a.site_id, point.patrol_type_id, a.id, guard.employeeId, guard.deviceId, start.window.index, start.window.start, start.window.end, at, rule.maxDurationMinutes],
        );
        patrol = (await tx.query('SELECT * FROM patrol_instances WHERE id = $1', [s.patrolId])).rows[0];
      }

      await log('accepted', patrol.id, check.distanceM);
      const needsNothing = point.photo_mode !== 'required' && point.note_mode !== 'required' && (point.checks as Check[]).length === 0;
      await tx.query(
        `INSERT INTO patrol_visits (company_id, patrol_id, point_id, scanned_at, done_at) VALUES (app_company_id(), $1, $2, $3, $4)
         ON CONFLICT (patrol_id, point_id) DO NOTHING`,
        [patrol.id, point.id, at, needsNothing ? at : null],
      );
      await this.completeIfDone(tx, patrol.id);
      return this.scanReply(tx, 'accepted', patrol.id, check.distanceM, point);
    });
  }

  /**
   * The instruction, photo, note and readings for a scanned point. It counts as
   * done only when everything required is saved; an out-of-limit reading or a
   * Problem raises an Amber report (scenario 7).
   */
  async saveChecks(
    guard: GuardPrincipal,
    patrolId: string,
    pointId: string,
    input: { eventId: string; note: string; readings: ReadingValue[]; trustedAt: Date; deviceClock: Date },
    files: Upload[],
    receivedAt = new Date(),
  ) {
    const time = reconcileTime(input.trustedAt, input.deviceClock, receivedAt);
    if (!time.ok) throw new UnprocessableEntityException(time.reason);
    return this.db.withTenant(guard.companyId, async (tx) => {
      const seen = (await tx.query('SELECT patrol_id FROM patrol_visits WHERE checks_event_id = $1', [input.eventId])).rows[0];
      if (seen) return this.patrolView(tx, seen.patrol_id);
      const patrol = (await tx.query('SELECT * FROM patrol_instances WHERE id = $1 FOR UPDATE', [patrolId])).rows[0];
      if (!patrol || patrol.employee_id !== guard.employeeId) throw new NotFoundException('Patrol not found.');
      if (patrol.state !== 'active') throw new ConflictException('This patrol is no longer in progress.');
      const visit = (await tx.query('SELECT * FROM patrol_visits WHERE patrol_id = $1 AND point_id = $2 FOR UPDATE', [patrolId, pointId])).rows[0];
      if (!visit) throw new ConflictException('Scan the point first.');
      if (visit.done_at) throw new ConflictException('This point is already done.');
      const point = (await tx.query('SELECT * FROM patrol_points WHERE id = $1', [pointId])).rows[0];
      const checks = point.checks as Check[];

      for (const f of files) if (!IMAGE_TYPES[f.mimetype]) throw new BadRequestException('Photos must be JPEG, PNG or WebP images.');
      const photo = files.find((f) => f.fieldname === 'photo');
      const readings = input.readings.map((r) => ({ ...r, photo: r.photo || files.some((f) => f.fieldname === `check_${r.checkId}`) }));
      for (const c of checks) {
        if (c.kind === 'photo' && files.some((f) => f.fieldname === `check_${c.id}`) && !readings.find((r) => r.checkId === c.id)) {
          readings.push({ checkId: c.id, photo: true });
        }
      }
      const missing = pointMissing({ photoMode: point.photo_mode, noteMode: point.note_mode, checks }, { photo: !!photo, note: input.note, readings });
      if (missing.length) throw new BadRequestException({ message: missing.join(' '), missing });

      const at = time.officialAt;
      const photoKey = photo ? await this.storage.put(guard.companyId, 'patrols', photo.buffer, IMAGE_TYPES[photo.mimetype]) : null;
      const flagged: string[] = [];
      const rows: { c: Check; r: ReadingValue; out: boolean }[] = [];
      for (const c of checks) {
        const r = readings.find((x) => x.checkId === c.id);
        if (!r) continue;
        const out = readingOutOfLimit(c, r);
        rows.push({ c, r, out });
        if (out) {
          flagged.push(
            c.kind === 'number'
              ? `${c.label}: ${r.value} ${c.unit}${c.below != null && (r.value as number) < c.below ? ` (below ${c.below})` : ` (above ${c.above})`}`
              : `${c.label}: Problem`,
          );
        }
      }
      let reportId: string | null = null;
      if (flagged.length) {
        const name = (await tx.query('SELECT full_name FROM employees WHERE id = $1', [guard.employeeId])).rows[0].full_name;
        reportId = await this.reports.create(
          tx,
          guard.companyId,
          {
            siteId: patrol.site_id,
            category: 'maintenance',
            priority: 'amber',
            description: `Patrol check at ${point.name}: ${flagged.join('; ')}.${input.note.trim() ? ` Note: ${input.note.trim()}` : ''}`,
            source: 'patrol',
            sourceId: input.eventId,
            employeeId: guard.employeeId,
            deviceId: guard.deviceId,
            reportedAt: at,
            lateSynced: time.lateSynced,
          },
          { type: 'employee', id: guard.employeeId, name },
        );
      }
      for (const { c, r, out } of rows) {
        await tx.query(
          `INSERT INTO patrol_readings (company_id, patrol_id, point_id, check_id, label, kind, value_num, value_ok, unit, out_of_limit, report_id, at)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [patrolId, pointId, c.id, c.label, c.kind, c.kind === 'number' ? r.value : null, c.kind === 'ok_problem' ? r.ok : null, c.kind === 'number' ? c.unit : null, out, out ? reportId : null, at],
        );
      }
      await tx.query(
        `UPDATE patrol_visits SET done_at = $3, note = $4, photo_key = $5, photo_content_type = $6, checks_event_id = $7
          WHERE patrol_id = $1 AND point_id = $2`,
        [patrolId, pointId, at, input.note.trim(), photoKey, photo?.mimetype ?? null, input.eventId],
      );
      await this.completeIfDone(tx, patrolId);
      return { ...(await this.patrolView(tx, patrolId)), reportRaised: !!reportId };
    });
  }

  /** A guard who cannot finish a multi-point patrol gives a reason: partial, no penalty until reviewed (section 6.5). */
  async cannotFinish(guard: GuardPrincipal, patrolId: string, input: { reason: string; trustedAt: Date; deviceClock: Date }, receivedAt = new Date()) {
    const time = reconcileTime(input.trustedAt, input.deviceClock, receivedAt);
    if (!time.ok) throw new UnprocessableEntityException(time.reason);
    return this.db.withTenant(guard.companyId, async (tx) => {
      const p = (await tx.query('SELECT * FROM patrol_instances WHERE id = $1 FOR UPDATE', [patrolId])).rows[0];
      if (!p || p.employee_id !== guard.employeeId) throw new NotFoundException('Patrol not found.');
      if (p.state === 'partial') return this.patrolView(tx, patrolId);
      if (p.state !== 'active') throw new ConflictException('This patrol is no longer in progress.');
      await tx.query(`UPDATE patrol_instances SET state = 'partial', finished_at = $2, partial_reason = $3 WHERE id = $1`, [patrolId, time.officialAt, input.reason]);
      await this.clearAlert(tx, patrolId, null, 'The guard ended the patrol early and gave a reason.');
      return this.patrolView(tx, patrolId);
    });
  }

  /** Completes the patrol once every point of its type is done, and awards its share of patrol points. */
  private async completeIfDone(tx: Tx, patrolId: string) {
    const p = (await tx.query('SELECT * FROM patrol_instances WHERE id = $1 FOR UPDATE', [patrolId])).rows[0];
    if (p.state !== 'active') return;
    const status = (
      await tx.query(
        `SELECT count(*)::int AS total, count(v.done_at)::int AS done, max(v.done_at) AS last
           FROM patrol_points pt LEFT JOIN patrol_visits v ON v.point_id = pt.id AND v.patrol_id = $1
          WHERE pt.patrol_type_id = $2 AND pt.active`,
        [patrolId, p.patrol_type_id],
      )
    ).rows[0];
    const type = (await tx.query('SELECT name, code, single_scan FROM patrol_types WHERE id = $1', [p.patrol_type_id])).rows[0];
    const singleDone = type.single_scan && (await tx.query('SELECT 1 FROM patrol_visits WHERE patrol_id = $1 AND done_at IS NOT NULL', [patrolId])).rowCount;
    if (!singleDone && (status.total === 0 || status.done < status.total)) return;
    const finished = singleDone
      ? (await tx.query('SELECT max(done_at) AS t FROM patrol_visits WHERE patrol_id = $1', [patrolId])).rows[0].t
      : status.last;

    // Patrol points: the shift's allocation shared over every required patrol, cumulatively rounded (scenario 6).
    const a = (await tx.query('SELECT shift_id, scheduled_start FROM attendance WHERE id = $1', [p.attendance_id])).rows[0];
    const alloc = (await tx.query('SELECT patrol_points::float AS pts FROM site_shifts WHERE id = $1', [a.shift_id])).rows[0]?.pts ?? 0;
    const required = (
      await tx.query(
        `SELECT coalesce(sum(r.per_shift), 0)::int AS n FROM patrol_rules r JOIN patrol_types t ON t.id = r.patrol_type_id
          WHERE r.shift_id = $1 AND t.active`,
        [a.shift_id],
      )
    ).rows[0].n;
    const k = (await tx.query(`SELECT count(*)::int AS n FROM patrol_instances WHERE attendance_id = $1 AND state = 'completed'`, [p.attendance_id])).rows[0].n + 1;
    const share = patrolShare(alloc, required, k);
    await tx.query(`UPDATE patrol_instances SET state = 'completed', finished_at = $2, points_earned = $3 WHERE id = $1`, [patrolId, finished, share]);
    await this.scoring.record(tx, {
      employeeId: p.employee_id,
      siteId: p.site_id,
      date: sastDate(new Date(a.scheduled_start)),
      type: 'patrol_completed',
      sourceType: 'patrol',
      sourceId: patrolId,
      impact: share,
      evidence: `${type.name} patrol (${type.code}) completed at ${sastTime(new Date(finished))}: patrol ${k} of ${required} this shift.`,
    });
    await this.clearAlert(tx, patrolId, null, 'The patrol was completed.');
  }

  async clearAlert(tx: Tx, patrolId: string, userId: string | null, reason: string) {
    await tx.query(
      `UPDATE patrol_alerts SET cleared_at = now(), cleared_by = $2, clear_reason = $3 WHERE patrol_id = $1 AND cleared_at IS NULL`,
      [patrolId, userId, reason],
    );
  }

  private async onDutyAt(tx: Tx, guard: GuardPrincipal, at: Date) {
    return (
      await tx.query(
        `SELECT * FROM attendance WHERE employee_id = $1 AND shift_id IS NOT NULL AND duty_on_at <= $2
            AND (duty_from_at IS NULL OR duty_from_at >= $2) ORDER BY duty_on_at DESC LIMIT 1`,
        [guard.employeeId, at],
      )
    ).rows[0];
  }

  private async history(tx: Tx, attendanceId: string, employeeId: string, typeId: string) {
    const rows = (
      await tx.query(`SELECT window_index, state, finished_at FROM patrol_instances WHERE attendance_id = $1 AND patrol_type_id = $2`, [attendanceId, typeId])
    ).rows;
    const active = (await tx.query(`SELECT 1 FROM patrol_instances WHERE employee_id = $1 AND state = 'active'`, [employeeId])).rowCount;
    const finished = rows.filter((r) => r.finished_at).map((r) => new Date(r.finished_at).getTime());
    return {
      usedWindows: rows.filter((r) => r.state !== 'missed').map((r) => r.window_index),
      lastFinishedAt: finished.length ? new Date(Math.max(...finished)) : null,
      activePatrol: !!active,
    };
  }

  private async scanReply(tx: Tx, result: string, patrolId: string | null, distanceM?: number | null, point?: Record<string, any>) {
    return {
      accepted: result === 'accepted',
      result,
      message: SCAN_RESULT_LABELS[result as keyof typeof SCAN_RESULT_LABELS] ?? result,
      distanceM: distanceM ?? null,
      point: point ? { id: point.id, name: point.name, instruction: point.instruction, photoMode: point.photo_mode, noteMode: point.note_mode, checks: point.checks } : null,
      patrol: patrolId ? await this.patrolView(tx, patrolId) : null,
    };
  }

  async patrolView(tx: Tx, id: string) {
    const p = (
      await tx.query(
        `SELECT p.id, p.state, p.started_at AS "startedAt", p.finished_at AS "finishedAt", p.window_start AS "windowStart",
                p.window_end AS "windowEnd", p.max_duration_minutes AS "maxDurationMinutes", p.points_earned::float AS "pointsEarned",
                p.partial_reason AS "partialReason", t.name AS "typeName", t.code AS "typeCode"
           FROM patrol_instances p JOIN patrol_types t ON t.id = p.patrol_type_id WHERE p.id = $1`,
        [id],
      )
    ).rows[0];
    if (!p) return null;
    const points = (
      await tx.query(
        `SELECT pt.id, pt.name, v.scanned_at AS "scannedAt", v.done_at AS "doneAt"
           FROM patrol_points pt JOIN patrol_instances p ON p.patrol_type_id = pt.patrol_type_id
           LEFT JOIN patrol_visits v ON v.point_id = pt.id AND v.patrol_id = p.id
          WHERE p.id = $1 AND pt.active ORDER BY pt.sort_order, pt.name`,
        [id],
      )
    ).rows;
    const deadline = p.startedAt ? new Date(new Date(p.startedAt).getTime() + p.maxDurationMinutes * MIN) : null;
    return { ...p, deadline, points };
  }
}
