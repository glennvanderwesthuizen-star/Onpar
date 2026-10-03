import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  sastLongDate,
  sastTime,
  arrivalStatus,
  departureStatus,
  matchShift,
  reconcileTime,
  sastDate,
  DECLARATIONS,
  DutyKind,
  declarationWordingFor,
  earnsEarlyBonus,
  reliefCheck,
  ReliefCheck,
  LeavingGuard,
  Reliever,
} from '@onpar/rules';
import type { GuardPrincipal, UserPrincipal } from '../common/auth';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { IMAGE_TYPES, StorageService } from '../storage/storage.service';
import { ScoringService } from '../scoring/scoring.service';
import { ReportsService } from '../reports/reports.service';
import { RosterService } from '../roster/roster.service';

export interface DutyInput {
  eventId: string;
  kind: DutyKind;
  trustedAt: Date;
  deviceClock: Date;
}

export interface DeclarationInput {
  eventId: string;
  dutyEventId: string;
  accepted: boolean[];
  comment: string;
  raiseEquipmentReport: boolean;
  equipmentReportPriority?: 'green' | 'amber' | 'red';
  trustedAt: Date;
  deviceClock: Date;
  selfieToFollow: boolean;
}

export interface Upload {
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const UNIQUE_VIOLATION = '23505';

/** Duty On, Duty From and their declarations (brief sections 6.2, 6.3 and 8). */
@Injectable()
export class DutyService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly scoring: ScoringService,
    private readonly reports: ReportsService,
    private readonly roster: RosterService,
  ) {}

  /**
   * Records a Duty On or Duty From pressed on the device. The PIN has already
   * been checked. Safe to retry: the same eventId returns the same result.
   */
  async recordDuty(guard: GuardPrincipal, input: DutyInput, receivedAt = new Date()) {
    const existing = await this.findDutyEvent(guard, input.eventId);
    if (existing) return existing;

    const time = reconcileTime(input.trustedAt, input.deviceClock, receivedAt);
    if (!time.ok) throw new UnprocessableEntityException(time.reason);

    try {
      return await this.db.withTenant(guard.companyId, async (tx) => {
        const attendanceId =
          input.kind === 'duty_on'
            ? await this.openShift(tx, guard.employeeId, guard.siteId, time.officialAt)
            : await this.closeShift(tx, guard.employeeId, time.officialAt, time.lateSynced ? 'late' : 'device');
        await tx.query(
          `INSERT INTO duty_events (id, company_id, attendance_id, employee_id, device_id, kind, official_at, trusted_at,
                                    device_clock, received_at, late_synced, drift_seconds, drift_flagged)
           VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            input.eventId,
            attendanceId,
            guard.employeeId,
            guard.deviceId,
            input.kind,
            time.officialAt,
            input.trustedAt,
            input.deviceClock,
            receivedAt,
            time.lateSynced,
            time.driftSeconds,
            time.driftFlagged,
          ],
        );
        const summary = await this.attendanceSummary(tx, attendanceId);
        await this.audit.record(tx, {
          actorType: 'employee',
          actorId: guard.employeeId,
          action: input.kind === 'duty_on' ? 'attendance.duty_on' : 'attendance.duty_from',
          entityType: 'attendance',
          entityId: attendanceId,
          after: { ...summary, lateSynced: time.lateSynced, driftSeconds: time.driftSeconds },
        });
        return { dutyEventId: input.eventId, attendance: summary, declaration: DECLARATIONS[input.kind] };
      });
    } catch (e) {
      // A retry that raced the first attempt: return what the first one stored.
      if ((e as { code?: string }).code === UNIQUE_VIOLATION) {
        const again = await this.findDutyEvent(guard, input.eventId);
        if (again) return again;
      }
      throw e;
    }
  }

  /** A supervisor logs Duty On or Duty From for a guard, with a reason (section 6.1). Audited. */
  async recordOnBehalf(user: UserPrincipal, employeeId: string, kind: DutyKind, reason: string, at: Date | null, eventId: string) {
    const now = new Date();
    const official = at ?? now;
    if (official.getTime() > now.getTime()) throw new BadRequestException('The time cannot be in the future.');
    return this.db.withTenant(user.companyId, async (tx) => {
      const e = (await tx.query('SELECT id, full_name, home_site_id FROM employees WHERE id = $1', [employeeId])).rows[0];
      if (!e) throw new NotFoundException('Officer not found.');
      // Logged at the site the guard is rostered at that day (a relief guard may be away from home), else his home site.
      const [today] = (await this.roster.days(tx, [e.id], sastDate(official), sastDate(official))).get(e.id)!;
      const siteId = today.status === 'working' ? today.siteId : e.home_site_id;
      if (user.siteIds && !user.siteIds.includes(e.home_site_id) && !user.siteIds.includes(siteId)) throw new NotFoundException('Officer not found.');
      const attendanceId =
        kind === 'duty_on' ? await this.openShift(tx, e.id, siteId, official) : await this.closeShift(tx, e.id, official, 'released');
      await tx.query(
        `INSERT INTO duty_events (id, company_id, attendance_id, employee_id, kind, official_at, trusted_at, device_clock,
                                  late_synced, drift_seconds, drift_flagged, on_behalf_by, on_behalf_reason)
         VALUES ($1, app_company_id(), $2, $3, $4, $5, $5, $5, false, 0, false, $6, $7)`,
        [eventId, attendanceId, e.id, kind, official, user.userId, reason],
      );
      const summary = await this.attendanceSummary(tx, attendanceId);
      await this.audit.byUser(tx, user, {
        action: kind === 'duty_on' ? 'attendance.duty_on_on_behalf' : 'attendance.duty_from_on_behalf',
        entityType: 'attendance',
        entityId: attendanceId,
        after: { ...summary, officer: e.full_name },
        reason,
      });
      return summary;
    });
  }

  /** The declaration screen that follows Duty On or Duty From. */
  async recordDeclaration(guard: GuardPrincipal, input: DeclarationInput, selfie: Upload | undefined, receivedAt = new Date()) {
    const existing = await this.db.withTenant(guard.companyId, (tx) =>
      tx.query('SELECT id, employee_id FROM declarations WHERE id = $1', [input.eventId]),
    );
    if (existing.rows[0]) {
      if (existing.rows[0].employee_id !== guard.employeeId) throw new ConflictException('This declaration ID is already used.');
      if (selfie) await this.attachSelfie(guard, input.eventId, selfie);
      return this.declarationSummary(guard, input.eventId);
    }

    if (selfie && !IMAGE_TYPES[selfie.mimetype]) throw new BadRequestException('The selfie must be a JPEG, PNG or WebP image.');
    if (!selfie && !input.selfieToFollow) throw new BadRequestException('A selfie is required.');
    if (input.raiseEquipmentReport && !input.comment.trim()) {
      throw new BadRequestException('Describe the problem in the comment to raise it as an equipment report.');
    }
    const time = reconcileTime(input.trustedAt, input.deviceClock, receivedAt);
    if (!time.ok) throw new UnprocessableEntityException(time.reason);

    await this.db.withTenant(guard.companyId, async (tx) => {
      const duty = (
        await tx.query('SELECT attendance_id, kind, employee_id FROM duty_events WHERE id = $1', [input.dutyEventId])
      ).rows[0];
      if (!duty || duty.employee_id !== guard.employeeId) {
        throw new ConflictException('The Duty On or Duty From for this declaration has not arrived yet. Send it first.');
      }
      // A phone not yet updated may show an earlier wording; it is recorded under that version.
      const wording = declarationWordingFor(duty.kind as DutyKind, input.accepted.length);
      if (!wording || !input.accepted.every(Boolean)) {
        throw new BadRequestException('Every statement must be accepted.');
      }
      let selfieKey: string | null = null;
      if (selfie) selfieKey = await this.storage.put(guard.companyId, `selfies/${guard.employeeId}`, selfie.buffer, IMAGE_TYPES[selfie.mimetype]);
      try {
        await tx.query(
          `INSERT INTO declarations (id, company_id, attendance_id, duty_event_id, employee_id, device_id, kind, wording_version,
                                     statements, comment, raise_equipment_report, official_at, device_clock, received_at,
                                     late_synced, drift_seconds, drift_flagged, selfie_key, selfie_content_type, selfie_received_at)
           VALUES ($1, app_company_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
          [
            input.eventId,
            duty.attendance_id,
            input.dutyEventId,
            guard.employeeId,
            guard.deviceId,
            duty.kind,
            wording.version,
            JSON.stringify(wording.statements.map((text) => ({ text, accepted: true }))),
            input.comment.trim(),
            input.raiseEquipmentReport,
            time.officialAt,
            input.deviceClock,
            receivedAt,
            time.lateSynced,
            time.driftSeconds,
            time.driftFlagged,
            selfieKey,
            selfie?.mimetype ?? null,
            selfie ? receivedAt : null,
          ],
        );
      } catch (e) {
        if ((e as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new ConflictException('A declaration for this Duty On or Duty From has already been made.');
        }
        throw e;
      }
      // A comment raised as an equipment report enters the normal report workflow (section 6.2).
      if (input.raiseEquipmentReport) {
        const name = (await tx.query('SELECT full_name FROM employees WHERE id = $1', [guard.employeeId])).rows[0].full_name;
        const site = (await tx.query('SELECT site_id FROM attendance WHERE id = $1', [duty.attendance_id])).rows[0].site_id;
        await this.reports.create(
          tx,
          guard.companyId,
          {
            siteId: site,
            category: 'equipment',
            priority: input.equipmentReportPriority ?? 'green',
            description: input.comment.trim(),
            source: 'declaration',
            sourceId: input.eventId,
            employeeId: guard.employeeId,
            deviceId: guard.deviceId,
            reportedAt: time.officialAt,
            lateSynced: time.lateSynced,
          },
          { type: 'employee', id: guard.employeeId, name },
        );
      }
      await this.audit.record(tx, {
        actorType: 'employee',
        actorId: guard.employeeId,
        action: 'attendance.declaration',
        entityType: 'attendance',
        entityId: duty.attendance_id,
        after: { kind: duty.kind, wordingVersion: wording.version, comment: input.comment.trim(), selfie: !!selfie },
      });
    });
    return this.declarationSummary(guard, input.eventId);
  }

  /** Attaches a selfie that was sent after its declaration. Once only; repeats are ignored. */
  async attachSelfie(guard: GuardPrincipal, declarationId: string, selfie: Upload) {
    if (!IMAGE_TYPES[selfie.mimetype]) throw new BadRequestException('The selfie must be a JPEG, PNG or WebP image.');
    await this.db.withTenant(guard.companyId, async (tx) => {
      const d = (await tx.query('SELECT employee_id, selfie_key FROM declarations WHERE id = $1', [declarationId])).rows[0];
      if (!d || d.employee_id !== guard.employeeId) throw new NotFoundException('Declaration not found.');
      if (d.selfie_key) return;
      const key = await this.storage.put(guard.companyId, `selfies/${guard.employeeId}`, selfie.buffer, IMAGE_TYPES[selfie.mimetype]);
      await tx.query(
        `UPDATE declarations SET selfie_key = $2, selfie_content_type = $3, selfie_received_at = now() WHERE id = $1`,
        [declarationId, key, selfie.mimetype],
      );
    });
    return this.declarationSummary(guard, declarationId);
  }

  /**
   * What the device needs on start-up: the guard's open shift and any
   * declaration still owed. While one is owed the app shows nothing else.
   */
  async guardState(guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      const e = (await tx.query('SELECT id, full_name, employee_number FROM employees WHERE id = $1', [guard.employeeId])).rows[0];
      const a = (
        await tx.query(
          `SELECT id FROM attendance WHERE employee_id = $1 ORDER BY duty_on_at DESC LIMIT 1`,
          [guard.employeeId],
        )
      ).rows[0];
      let attendance = null;
      let pendingDeclaration = null;
      if (a) {
        const summary = await this.attendanceSummary(tx, a.id);
        if (!summary.dutyFromAt) {
          const open = (await tx.query('SELECT id, site_id, scheduled_end, roster_status FROM attendance WHERE id = $1', [a.id])).rows[0];
          const r = await this.reliefFor(tx, open, new Date());
          attendance = {
            ...summary,
            relief: {
              canLeave: r.canLeave,
              outcome: r.outcome,
              message: r.message,
              unlocksAt: r.unlocksAt?.toISOString() ?? null,
              canGiveTurn: r.canGiveTurn,
              reliever: r.reliever?.name ?? null,
            },
          };
        }
        const owed = !summary.declarations.duty_on
          ? 'duty_on'
          : summary.dutyFromAt && !summary.declarations.duty_from
            ? 'duty_from'
            : null;
        if (owed) {
          const ev = (await tx.query('SELECT id FROM duty_events WHERE attendance_id = $1 AND kind = $2', [a.id, owed])).rows[0];
          pendingDeclaration = { kind: owed, dutyEventId: ev.id, wording: DECLARATIONS[owed as DutyKind] };
        }
      }
      return {
        employee: { id: e.id, name: e.full_name, employeeNumber: e.employee_number },
        serverTime: new Date().toISOString(),
        attendance,
        pendingDeclaration,
        // The guard's real shift today and the next few days (section 40).
        roster: await this.roster.guardRoster(tx, guard.employeeId, sastDate(new Date())),
      };
    });
  }

  private async findDutyEvent(guard: GuardPrincipal, eventId: string) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      const ev = (await tx.query('SELECT attendance_id, employee_id, kind FROM duty_events WHERE id = $1', [eventId])).rows[0];
      if (!ev) return null;
      if (ev.employee_id !== guard.employeeId) throw new ConflictException('This event ID is already used.');
      return {
        dutyEventId: eventId,
        attendance: await this.attendanceSummary(tx, ev.attendance_id),
        declaration: DECLARATIONS[ev.kind as DutyKind],
      };
    });
  }

  private async openShift(tx: Tx, employeeId: string, siteId: string | null, at: Date): Promise<string> {
    if (!siteId) throw new ConflictException('This device is not assigned to a site. Ask your supervisor.');
    const open = await tx.query('SELECT 1 FROM attendance WHERE employee_id = $1 AND duty_from_at IS NULL', [employeeId]);
    if (open.rowCount) {
      throw new ConflictException('You are still on duty from an earlier shift. Log Duty From, or ask your supervisor to close it.');
    }
    const grace = (await tx.query('SELECT grace_minutes FROM companies')).rows[0].grace_minutes;
    // The roster decides the shift (milestone 21). A guard with no roster at all falls back to the
    // site's shifts; a guard working here without being rostered here is recorded but not scored.
    const rostered = await this.roster.dutyMatch(tx, employeeId, siteId, at);
    let match: { shiftId: string; shiftDate: string; scheduledStart: Date; scheduledEnd: Date } | null;
    let shiftName: string | null | undefined;
    if (rostered.status === 'rostered') {
      match = rostered.shift;
      shiftName = rostered.shift.shiftName;
    } else {
      const shifts = (
        await tx.query(
          `SELECT id, name, to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime"
             FROM site_shifts WHERE site_id = $1`,
          [siteId],
        )
      ).rows;
      match = matchShift(shifts, at);
      shiftName = match ? shifts.find((s) => s.id === match!.shiftId)?.name : null;
    }
    const arrival = rostered.status === 'not_rostered_here' ? arrivalStatus(null, at) : arrivalStatus(match?.scheduledStart ?? null, at, grace);
    let attendanceId: string;
    try {
      attendanceId = (
        await tx.query(
          `INSERT INTO attendance (company_id, employee_id, site_id, shift_id, shift_name, shift_date, scheduled_start,
                                   scheduled_end, duty_on_at, arrival_status, late_minutes, roster_status)
           VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [
            employeeId,
            siteId,
            match?.shiftId ?? null,
            shiftName ?? null,
            match?.shiftDate ?? sastDate(at),
            match?.scheduledStart ?? null,
            match?.scheduledEnd ?? null,
            at,
            arrival.status,
            arrival.lateMinutes,
            rostered.status === 'rostered' ? 'rostered' : rostered.status,
          ],
        )
      ).rows[0].id;
    } catch (e) {
      if ((e as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new ConflictException('You are already on duty.');
      }
      throw e;
    }
    if (match && arrival.status !== 'UNSCHEDULED') {
      const site = (await tx.query('SELECT name FROM sites WHERE id = $1', [siteId])).rows[0].name;
      const shift = `the ${sastTime(match.scheduledStart)} ${shiftName ?? ''} shift at ${site} on ${sastLongDate(match.shiftDate)}`.replace(/\s+/g, ' ');
      await this.scoring.record(tx, {
        employeeId,
        siteId,
        date: match.shiftDate,
        type: arrival.status === 'LATE' ? 'late' : 'on_time',
        sourceType: 'attendance',
        sourceId: attendanceId,
        evidence:
          arrival.status === 'LATE'
            ? `Duty On at ${sastTime(at)} for ${shift}: ${arrival.lateMinutes} minutes late.`
            : `Duty On at ${sastTime(at)} for ${shift}.`,
      });
      // More than 15 minutes early earns an extra point (D-33).
      if (earnsEarlyBonus(match.scheduledStart, at)) {
        const early = Math.floor((match.scheduledStart.getTime() - at.getTime()) / 60_000);
        await this.scoring.record(tx, {
          employeeId,
          siteId,
          date: match.shiftDate,
          type: 'early_arrival',
          sourceType: 'attendance',
          sourceId: attendanceId,
          evidence: `Duty On at ${sastTime(at)}, ${early} minutes before ${shift}.`,
        });
      }
    }
    return attendanceId;
  }

  /**
   * Closes the guard's open shift. From the phone, Duty From is refused until his relief
   * has arrived (or 30 minutes after the shift), first in first out (D-33). A Duty From
   * sent late from a phone without signal is accepted and marked "not checked"; a
   * supervisor's Duty From releases him.
   */
  private async closeShift(tx: Tx, employeeId: string, at: Date, mode: 'device' | 'late' | 'released'): Promise<string> {
    const a = (
      await tx.query(
        `SELECT id, site_id, shift_date, scheduled_end, duty_on_at, roster_status FROM attendance
          WHERE employee_id = $1 AND duty_from_at IS NULL FOR UPDATE`,
        [employeeId],
      )
    ).rows[0];
    if (!a) throw new ConflictException('You are not on duty, so there is nothing to log Duty From for.');
    if (at.getTime() < new Date(a.duty_on_at).getTime()) throw new BadRequestException('Duty From cannot be before Duty On.');
    const check = await this.reliefFor(tx, a, at);
    if (mode === 'device' && !check.canLeave) throw new ConflictException(check.message);
    const reliefStatus = mode === 'released' ? 'released' : mode === 'late' ? 'not_checked' : check.outcome;
    const dep = departureStatus(a.scheduled_end && a.roster_status !== 'not_rostered_here' ? new Date(a.scheduled_end) : null, at);
    await tx.query(
      `UPDATE attendance SET duty_from_at = $2, departure_status = $3, early_minutes = $4, relief_status = $5, relieved_by_attendance_id = $6
        WHERE id = $1`,
      [a.id, at, dep.status, dep.earlyMinutes, reliefStatus, check.outcome === 'relieved' && mode === 'device' ? check.reliever!.attendanceId : null],
    );
    if (mode === 'device') await this.scoreCovering(tx, employeeId, a, at, check);
    return a.id;
  }

  /**
   * A guard who stayed past his shift because his relief was late, or never came, gets a
   * point for covering, and the points the late relief lost (D-33).
   */
  private async scoreCovering(tx: Tx, employeeId: string, a: { id: string; site_id: string; shift_date: string; scheduled_end: Date | null }, at: Date, check: ReliefCheck) {
    if (!a.scheduled_end) return;
    const stayed = Math.floor((at.getTime() - new Date(a.scheduled_end).getTime()) / 60_000);
    if (stayed < 1) return;
    const lateRelief = check.outcome === 'relieved' && check.reliever!.lateMinutes > 0;
    if (!lateRelief && check.outcome !== 'no_relief') return;
    const date = typeof a.shift_date === 'string' ? a.shift_date : sastDate(new Date(a.shift_date));
    const why = lateRelief
      ? `Stayed ${stayed} minutes after the shift until ${check.reliever!.name} arrived (${check.reliever!.lateMinutes} minutes late).`
      : `Stayed ${stayed} minutes after the shift; no relief arrived.`;
    await this.scoring.record(tx, { employeeId, siteId: a.site_id, date, type: 'covering', sourceType: 'attendance', sourceId: a.id, evidence: why });
    if (lateRelief) {
      const late = (await this.scoring.config(tx)).points.late;
      if (late < 0) {
        await this.scoring.record(tx, {
          employeeId,
          siteId: a.site_id,
          date,
          type: 'covered_points',
          impact: -late,
          sourceType: 'attendance',
          sourceId: a.id,
          evidence: `The ${-late} point${late === -1 ? '' : 's'} ${check.reliever!.name} lost for arriving late.`,
        });
      }
    }
  }

  /** Whether the guard on this open shift may log Duty From at `at` (D-33). */
  private async reliefFor(tx: Tx, a: { id: string; site_id: string; scheduled_end: Date | null; roster_status: string | null }, at: Date): Promise<ReliefCheck> {
    const end = a.scheduled_end && a.roster_status !== 'not_rostered_here' ? new Date(a.scheduled_end) : null;
    if (!end) return reliefCheck(at, a.id, null, [], []);
    const leaving: LeavingGuard[] = (
      await tx.query(
        `SELECT a.id, e.full_name, a.duty_on_at, a.duty_from_at, a.turn_given_at, a.relief_status
           FROM attendance a JOIN employees e ON e.id = a.employee_id
          WHERE a.site_id = $1 AND a.scheduled_end = $2 AND a.roster_status IS DISTINCT FROM 'not_rostered_here'`,
        [a.site_id, end],
      )
    ).rows.map((r) => ({
      attendanceId: r.id,
      name: r.full_name,
      dutyOnAt: new Date(r.duty_on_at),
      dutyFromAt: r.duty_from_at ? new Date(r.duty_from_at) : null,
      turnGivenAt: r.turn_given_at ? new Date(r.turn_given_at) : null,
      reliefStatus: r.relief_status,
    }));
    // The next shift's guards who have done Duty On here: a shift starting when this one ends (or up to 6 hours later).
    const relievers: Reliever[] = (
      await tx.query(
        `SELECT a.id, e.full_name, a.duty_on_at, a.late_minutes
           FROM attendance a JOIN employees e ON e.id = a.employee_id
          WHERE a.site_id = $1 AND a.scheduled_start >= $2 AND a.scheduled_start < $2 + interval '6 hours' AND a.duty_on_at <= $3`,
        [a.site_id, end, at],
      )
    ).rows.map((r) => ({ attendanceId: r.id, name: r.full_name, dutyOnAt: new Date(r.duty_on_at), lateMinutes: r.late_minutes ?? 0 }));
    return reliefCheck(at, a.id, end, leaving, relievers);
  }

  /**
   * "Let my partner go first": the guard whose turn it is gives it to the next guard in the
   * queue. Needs his PIN (checked by the caller). Recorded with both names.
   */
  async giveTurn(guard: GuardPrincipal) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      const a = (
        await tx.query(
          `SELECT id, site_id, scheduled_end, roster_status FROM attendance WHERE employee_id = $1 AND duty_from_at IS NULL FOR UPDATE`,
          [guard.employeeId],
        )
      ).rows[0];
      if (!a) throw new ConflictException('You are not on duty.');
      const now = new Date();
      const check = await this.reliefFor(tx, a, now);
      if (!check.canGiveTurn) throw new ConflictException('There is nobody to give your turn to right now.');
      await tx.query('UPDATE attendance SET turn_given_at = $2 WHERE id = $1', [a.id, now]);
      const after = await this.reliefFor(tx, { ...a }, now);
      await this.audit.record(tx, {
        actorType: 'employee',
        actorId: guard.employeeId,
        action: 'attendance.relief_turn_given',
        entityType: 'attendance',
        entityId: a.id,
        after: { relief: check.reliever?.name ?? null },
      });
      return { relief: after };
    });
  }

  private async attendanceSummary(tx: Tx, id: string) {
    const a = (
      await tx.query(
        `SELECT a.id, a.shift_name AS "shiftName", a.shift_date AS "shiftDate", a.scheduled_start AS "scheduledStart",
                a.scheduled_end AS "scheduledEnd", a.duty_on_at AS "dutyOnAt", a.duty_from_at AS "dutyFromAt",
                a.arrival_status AS "arrivalStatus", a.late_minutes AS "lateMinutes",
                a.departure_status AS "departureStatus", a.early_minutes AS "earlyMinutes", a.roster_status AS "rosterStatus", s.name AS "siteName"
           FROM attendance a JOIN sites s ON s.id = a.site_id WHERE a.id = $1`,
        [id],
      )
    ).rows[0];
    const decl = (await tx.query('SELECT kind FROM declarations WHERE attendance_id = $1', [id])).rows.map((r) => r.kind);
    return { ...a, declarations: { duty_on: decl.includes('duty_on'), duty_from: decl.includes('duty_from') } };
  }

  private declarationSummary(guard: GuardPrincipal, id: string) {
    return this.db.withTenant(guard.companyId, async (tx) => {
      const d = (
        await tx.query(
          `SELECT id, kind, wording_version AS "wordingVersion", official_at AS "officialAt", late_synced AS "lateSynced",
                  selfie_key IS NOT NULL AS "selfieReceived"
             FROM declarations WHERE id = $1`,
          [id],
        )
      ).rows[0];
      return d;
    });
  }
}
