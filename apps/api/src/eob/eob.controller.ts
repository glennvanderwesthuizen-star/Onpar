import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import {
  EOB_BANNER,
  EOB_CATEGORY_LABELS,
  EobCategory,
  eobEntryError,
  EXCEPTION_LABELS,
  ExceptionType,
  REORDER_STAGE_LABELS,
  ReorderStage,
  REPORT_CATEGORIES,
  REPORT_COLOURS,
  ReportCategory,
  STAGE_LABELS,
  Stage,
  VISIT_STATUS_LABELS,
  VisitStatus,
  visitorName,
} from '@onpar/rules';
import { z } from 'zod';
import { assertSiteAccess, CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { RetentionService } from '../privacy/retention.service';
import { StorageService } from '../storage/storage.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The South African day `$2` (YYYY-MM-DD) as a time window on a column. */
const IN_DAY = (col: string) => `${col} >= ($2::date)::timestamp AT TIME ZONE 'Africa/Johannesburg' AND ${col} < ($2::date + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg'`;

const EntryBody = z.object({
  text: z.string(),
  // When it happened; now if not given.
  at: z.string().datetime({ offset: true }).nullable().default(null),
  corrects: z.string().uuid().nullable().default(null),
});

const PHOTO_KINDS = ['selfie', 'task', 'patrol', 'report', 'report_step', 'bolo', 'visit_face', 'exception'] as const;
type PhotoKind = (typeof PHOTO_KINDS)[number];

export interface EobEntry {
  /** Unique within the book, for the screen. */
  key: string;
  at: Date;
  category: EobCategory;
  categoryLabel: string;
  /** Report rows only: the priority, shown as a small traffic light. */
  alert: 'green' | 'amber' | 'red' | null;
  /** Report rows only: the report's colour badge and number. */
  colour: string | null;
  reportNumber: number | null;
  /** The photo taken with this entry, to fetch from the book's photo address. */
  photo: string | null;
  text: string;
  by: string;
  /** Sent from a phone that had no signal at the time. */
  lateSynced: boolean;
}

const TASK_ACTIONS: Record<string, string> = {
  completed: 'Task done',
  could_not_complete: 'Could not complete',
  missed: 'Task missed',
  review_accepted: 'Reason accepted',
  review_not_accepted: 'Reason not accepted',
  cancelled: 'Task cancelled',
};
const SCAN_RESULTS: Record<string, string> = {
  rejected_not_open: 'refused: the patrol was not open',
  rejected_unknown_code: 'refused: unknown code',
  rejected_wrong_type: 'refused: a point of another patrol',
};
const SERVICES: Record<string, string> = { police: 'Police', fire: 'Fire brigade', ambulance: 'Ambulance', armed_response: 'Armed response' };

/**
 * The Electronic Occurrence Book (brief section 27; owner's step 6, 8 Oct 2026): one site, one
 * day, in time order, assembled from what the rest of On Par records. Not the official OB.
 */
@Controller('sites/:siteId/occurrence-book')
@UseGuards(UserAuthGuard)
export class EobController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly retention: RetentionService,
  ) {}

  private async site(tx: Tx, user: UserPrincipal, siteId: string) {
    assertSiteAccess(user, siteId);
    const s = (await tx.query('SELECT id, name FROM sites WHERE id = $1', [siteId])).rows[0];
    if (!s) throw new NotFoundException('Site not found.');
    return s as { id: string; name: string };
  }

  @Get()
  @RequirePermission('eob.view')
  book(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Query('date') date?: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const site = await this.site(tx, user, siteId);
      const day = date && DAY.test(date) ? date : ((await tx.query(`SELECT to_char(now() AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS d`)).rows[0].d as string);
      const entries = await this.entries(tx, siteId, day);
      const counts: Partial<Record<EobCategory, number>> = {};
      for (const e of entries) counts[e.category] = (counts[e.category] ?? 0) + 1;
      return { site: site.name, date: day, banner: EOB_BANNER, entries, counts };
    });
  }

  /** Writes an entry in the book by hand. It can never be changed; a correction is a new entry that points to it. */
  @Post()
  @RequirePermission('eob.write')
  write(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Body() body: unknown) {
    const b = parseBody(EntryBody, body);
    const problem = eobEntryError(b.text);
    if (problem) throw new BadRequestException({ message: problem, errors: { text: problem } });
    const at = b.at ? new Date(b.at) : new Date();
    if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException({ message: 'The time cannot be in the future.', errors: { at: 'The time cannot be in the future.' } });
    if (at.getTime() < Date.now() - 31 * 86_400_000) throw new BadRequestException({ message: 'Write entries within a month of what happened.', errors: { at: 'Too long ago.' } });
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      if (b.corrects && !(await tx.query('SELECT 1 FROM ob_entries WHERE id = $1 AND site_id = $2', [b.corrects, siteId])).rowCount) throw new NotFoundException('The entry being corrected was not found.');
      const id = (
        await tx.query(`INSERT INTO ob_entries (company_id, site_id, occurred_at, text, corrects, written_by) VALUES (app_company_id(), $1, $2, $3, $4, $5) RETURNING id`, [
          siteId,
          at,
          b.text.trim(),
          b.corrects,
          user.userId,
        ])
      ).rows[0].id as string;
      await this.audit.byUser(tx, user, { action: 'eob.write', entityType: 'ob_entry', entityId: id, after: { siteId, at, corrects: b.corrects } });
      return { id };
    });
  }

  /** The photo taken with an entry. Only photos of this site; each look is recorded. */
  @Get('photo/:kind/:id')
  @RequirePermission('eob.view')
  async photo(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Param('kind') kind: string, @Param('id') id: string, @Res() res: Response, @Query('point') point?: string) {
    if (!(PHOTO_KINDS as readonly string[]).includes(kind)) throw new NotFoundException('Photo not found.');
    const uuid = /^[0-9a-f-]{36}$/;
    if (kind === 'report_step' ? !/^\d+$/.test(id) : !uuid.test(id)) throw new NotFoundException('Photo not found.');
    if (kind === 'patrol' && !uuid.test(point ?? '')) throw new NotFoundException('Photo not found.');
    const found = await this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      const q: Record<PhotoKind, [string, unknown[]]> = {
        selfie: [`SELECT d.selfie_key AS key, d.selfie_content_type AS type FROM declarations d JOIN attendance a ON a.id = d.attendance_id WHERE d.id = $1 AND a.site_id = $2`, [id, siteId]],
        task: [`SELECT photo_key AS key, photo_content_type AS type FROM task_occurrences WHERE id = $1 AND site_id = $2`, [id, siteId]],
        patrol: [`SELECT v.photo_key AS key, v.photo_content_type AS type FROM patrol_visits v JOIN patrol_instances i ON i.id = v.patrol_id WHERE v.patrol_id = $1 AND i.site_id = $2 AND v.point_id = $3`, [id, siteId, point]],
        report: [`SELECT photo_key AS key, photo_content_type AS type FROM reports WHERE id = $1 AND site_id = $2`, [id, siteId]],
        report_step: [`SELECT h.photo_key AS key, h.photo_content_type AS type FROM report_history h JOIN reports r ON r.id = h.report_id WHERE h.id = $1 AND r.site_id = $2`, [id, siteId]],
        bolo: [`SELECT photo_key AS key, photo_content_type AS type FROM bolos WHERE id = $1 AND site_id = $2`, [id, siteId]],
        visit_face: [`SELECT face_photo_key AS key, face_photo_type AS type FROM visits WHERE id = $1 AND site_id = $2`, [id, siteId]],
        exception: [`SELECT photo_key AS key, photo_type AS type FROM visit_exceptions WHERE id = $1 AND site_id = $2`, [id, siteId]],
      };
      const [sql, params] = q[kind as PhotoKind];
      const r = (await tx.query(sql, params)).rows[0];
      if (!r?.key) throw new NotFoundException('Photo not found.');
      await this.retention.assertNotRemoved(tx, r.key);
      await this.audit.byUser(tx, user, { action: 'eob.photo_view', entityType: kind, entityId: kind === 'report_step' ? siteId : id, after: { kind, id } });
      return r as { key: string; type: string | null };
    });
    res.setHeader('Content-Type', found.type ?? 'image/jpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(found.key));
  }

  /** Everything recorded at the site on the day, oldest first. */
  async entries(tx: Tx, siteId: string, day: string): Promise<EobEntry[]> {
    const out: EobEntry[] = [];
    const add = (e: Omit<EobEntry, 'categoryLabel' | 'alert' | 'colour' | 'reportNumber' | 'photo' | 'lateSynced'> & Partial<EobEntry>) =>
      out.push({ alert: null, colour: null, reportNumber: null, photo: null, lateSynced: false, ...e, categoryLabel: EOB_CATEGORY_LABELS[e.category] });
    const p = [siteId, day];
    const rows = async (sql: string) => (await tx.query(sql, p)).rows;

    // Duty On and Duty From, with the declaration's selfie and comment.
    for (const d of await rows(
      `SELECT d.id, d.kind, d.official_at AS at, e.full_name AS by, a.shift_name, a.arrival_status, a.late_minutes, a.departure_status, a.early_minutes, d.comment, d.raise_equipment_report,
              d.selfie_key IS NOT NULL AS photo, d.late_synced
         FROM declarations d JOIN attendance a ON a.id = d.attendance_id JOIN employees e ON e.id = d.employee_id
        WHERE a.site_id = $1 AND ${IN_DAY('d.official_at')}`,
    )) {
      const on = d.kind === 'duty_on';
      const timing = on ? (d.arrival_status === 'LATE' ? ` (${d.late_minutes} minutes late)` : '') : d.departure_status === 'EARLY_DEPARTURE' ? ` (left ${d.early_minutes} minutes early)` : '';
      add({
        key: `duty:${d.id}`,
        at: d.at,
        category: 'duty',
        text: `${on ? 'Duty On' : 'Duty From'}${d.shift_name ? `, ${d.shift_name} shift` : ''}${timing}. Declaration signed.${d.raise_equipment_report ? ' Equipment problem reported.' : ''}${d.comment ? ` Comment: ${d.comment}` : ''}`,
        by: d.by,
        photo: d.photo ? `selfie/${d.id}` : null,
        lateSynced: d.late_synced,
      });
    }

    // Tasks: done, could not be done, missed, and the supervisor's review.
    for (const t of await rows(
      `SELECT h.id, h.at, h.action, h.note, coalesce(h.actor_label, 'On Par') AS by, o.id AS oid, o.title, (o.photo_key IS NOT NULL AND h.action = 'completed') AS photo, coalesce(h.late_synced, false) AS late
         FROM task_history h JOIN task_occurrences o ON o.id = h.occurrence_id
        WHERE o.site_id = $1 AND ${IN_DAY('h.at')} AND h.action = ANY('{completed,could_not_complete,missed,review_accepted,review_not_accepted,cancelled}')`,
    )) {
      add({ key: `task:${t.id}`, at: t.at, category: 'task', text: `${TASK_ACTIONS[t.action]}: ${t.title}${t.note ? `. ${t.note}` : ''}`, by: t.by, photo: t.photo ? `task/${t.oid}` : null, lateSynced: t.late });
    }

    // Patrols: started, finished or missed, and every checkpoint scan.
    for (const i of await rows(
      `SELECT i.id, t.name, i.started_at, i.finished_at, i.window_end, i.state, i.partial_reason, coalesce(e.full_name, '') AS by
         FROM patrol_instances i JOIN patrol_types t ON t.id = i.patrol_type_id LEFT JOIN employees e ON e.id = i.employee_id
        WHERE i.site_id = $1 AND (${IN_DAY('i.started_at')} OR ${IN_DAY('i.finished_at')} OR (i.state = 'missed' AND i.started_at IS NULL AND ${IN_DAY('i.window_end')}))`,
    )) {
      const inDay = (d: Date | null) => d && this.sameDay(d, day);
      if (inDay(i.started_at)) add({ key: `patrol-start:${i.id}`, at: i.started_at, category: 'patrol', text: `Patrol started: ${i.name}`, by: i.by });
      if (inDay(i.finished_at)) {
        const how = i.state === 'completed' ? 'completed' : i.state === 'partial' ? `finished partly${i.partial_reason ? ` (${i.partial_reason})` : ''}` : i.state;
        add({ key: `patrol-end:${i.id}`, at: i.finished_at, category: 'patrol', text: `Patrol ${how}: ${i.name}`, by: i.by });
      }
      if (i.state === 'missed' && !i.started_at && inDay(i.window_end)) add({ key: `patrol-missed:${i.id}`, at: i.window_end, category: 'patrol', text: `Patrol missed: ${i.name}`, by: 'On Par' });
    }
    for (const s of await rows(
      `SELECT s.id, s.official_at AS at, s.result, s.distance_m, pt.name AS point, coalesce(e.full_name, '') AS by, s.patrol_id, s.point_id, v.note, v.photo_key IS NOT NULL AS photo, s.late_synced
         FROM patrol_scans s LEFT JOIN patrol_instances i ON i.id = s.patrol_id LEFT JOIN patrol_points pt ON pt.id = s.point_id LEFT JOIN employees e ON e.id = s.employee_id
         LEFT JOIN patrol_visits v ON v.patrol_id = s.patrol_id AND v.point_id = s.point_id
        WHERE coalesce(i.site_id, pt.site_id) = $1 AND ${IN_DAY('s.official_at')}`,
    )) {
      const ok = s.result === 'accepted';
      add({
        key: `scan:${s.id}`,
        at: s.at,
        category: 'patrol',
        text: ok ? `Checkpoint scanned: ${s.point ?? 'unknown point'}${s.note ? `. ${s.note}` : ''}` : `Scan ${SCAN_RESULTS[s.result] ?? s.result}${s.point ? ` (${s.point})` : ''}`,
        by: s.by,
        photo: ok && s.photo ? `patrol/${s.patrol_id}?point=${s.point_id}` : null,
        lateSynced: s.late_synced,
      });
    }

    // Reports: every stage, with the report's colour badge and priority.
    for (const r of await rows(
      `SELECT h.id, h.at, h.action, h.stage_after, h.note, coalesce(h.actor_label, '') AS by, r.id AS rid, r.number, r.category, r.priority, r.colour_slot, r.description,
              (CASE WHEN h.action = 'reported' THEN r.photo_key ELSE h.photo_key END) IS NOT NULL AS photo, coalesce(h.late_synced, false) AS late
         FROM report_history h JOIN reports r ON r.id = h.report_id
        WHERE r.site_id = $1 AND ${IN_DAY('h.at')}`,
    )) {
      const reported = r.action === 'reported';
      add({
        key: `report:${r.id}`,
        at: r.at,
        category: 'report',
        alert: r.priority,
        colour: REPORT_COLOURS[r.colour_slot % REPORT_COLOURS.length],
        reportNumber: r.number,
        text: reported
          ? `${REPORT_CATEGORIES[r.category as ReportCategory] ?? r.category} report: ${r.description}`
          : `${STAGE_LABELS[r.stage_after as Stage] ?? r.stage_after ?? r.action}${r.note ? `. ${r.note}` : ''}`,
        by: r.by,
        photo: r.photo ? (reported ? `report/${r.rid}` : `report_step/${r.id}`) : null,
        lateSynced: r.late,
      });
    }

    // Re-orders: every stage.
    for (const r of await rows(
      `SELECT h.id, h.at, h.stage_after, h.note, coalesce(h.actor_label, '') AS by, r.number, r.item, r.size, r.quantity, coalesce(h.late_synced, false) AS late
         FROM reorder_history h JOIN reorders r ON r.id = h.reorder_id WHERE r.site_id = $1 AND ${IN_DAY('h.at')}`,
    )) {
      add({
        key: `reorder:${r.id}`,
        at: r.at,
        category: 'reorder',
        text: `Re-order #${r.number}, ${r.item}${r.size ? ` (${r.size})` : ''}${r.quantity ? ` × ${r.quantity}` : ''}: ${REORDER_STAGE_LABELS[r.stage_after as ReorderStage] ?? r.stage_after}${r.note ? `. ${r.note}` : ''}`,
        by: r.by,
        lateSynced: r.late,
      });
    }

    // Panic and BOLO, and the emergency numbers phoned.
    for (const x of await rows(
      `SELECT x.id, x.raised_at, x.acknowledged_at, x.resolved_at, x.resolution_note, x.late_synced, e.full_name AS guard, ua.full_name AS ack_by, ur.full_name AS res_by
         FROM panic_alerts x LEFT JOIN employees e ON e.id = x.employee_id LEFT JOIN users ua ON ua.id = x.acknowledged_by LEFT JOIN users ur ON ur.id = x.resolved_by
        WHERE x.site_id = $1 AND (${IN_DAY('x.raised_at')} OR ${IN_DAY('x.acknowledged_at')} OR ${IN_DAY('x.resolved_at')})`,
    )) {
      if (this.sameDay(x.raised_at, day)) add({ key: `panic:${x.id}`, at: x.raised_at, category: 'panic', alert: 'red', text: 'PANIC pressed.', by: x.guard ?? '', lateSynced: x.late_synced });
      if (x.acknowledged_at && this.sameDay(x.acknowledged_at, day)) add({ key: `panic-ack:${x.id}`, at: x.acknowledged_at, category: 'panic', text: 'Panic acknowledged.', by: x.ack_by ?? '' });
      if (x.resolved_at && this.sameDay(x.resolved_at, day)) add({ key: `panic-res:${x.id}`, at: x.resolved_at, category: 'panic', text: `Panic resolved${x.resolution_note ? `: ${x.resolution_note}` : '.'}`, by: x.res_by ?? '' });
    }
    for (const x of await rows(
      `SELECT x.id, x.reported_at, x.note, x.photo_key IS NOT NULL AS photo, x.resolved_at, x.resolution_note, x.late_synced, e.full_name AS guard, ur.full_name AS res_by
         FROM bolos x LEFT JOIN employees e ON e.id = x.employee_id LEFT JOIN users ur ON ur.id = x.resolved_by
        WHERE x.site_id = $1 AND (${IN_DAY('x.reported_at')} OR ${IN_DAY('x.resolved_at')})`,
    )) {
      if (this.sameDay(x.reported_at, day)) add({ key: `bolo:${x.id}`, at: x.reported_at, category: 'bolo', text: `BOLO${x.note ? `: ${x.note}` : ' sent.'}`, by: x.guard ?? '', photo: x.photo ? `bolo/${x.id}` : null, lateSynced: x.late_synced });
      if (x.resolved_at && this.sameDay(x.resolved_at, day)) add({ key: `bolo-res:${x.id}`, at: x.resolved_at, category: 'bolo', text: `BOLO resolved${x.resolution_note ? `: ${x.resolution_note}` : '.'}`, by: x.res_by ?? '' });
    }
    for (const c of await rows(
      `SELECT c.id, c.called_at, c.service, c.late_synced, e.full_name AS guard FROM emergency_calls c LEFT JOIN employees e ON e.id = c.employee_id WHERE c.site_id = $1 AND ${IN_DAY('c.called_at')}`,
    )) {
      add({ key: `call:${c.id}`, at: c.called_at, category: 'emergency_call', text: `Emergency number phoned: ${SERVICES[c.service] ?? c.service}.`, by: c.guard ?? '', lateSynced: c.late_synced });
    }

    // Visitors at the gates: in, out, and exceptions.
    for (const v of await rows(
      `SELECT v.id, v.captured_at, v.exit_at, v.status, v.type, p.surname, p.names, ve.registration, coalesce('unit ' || u.name, 'the office') AS visiting, g.name AS gate,
              e.full_name AS guard, x.full_name AS exit_guard, v.face_photo_key IS NOT NULL AS photo, v.late_synced, v.captured_offline
         FROM visits v JOIN visitor_people p ON p.id = v.person_id LEFT JOIN visitor_vehicles ve ON ve.id = v.vehicle_id LEFT JOIN site_units u ON u.id = v.unit_id
         JOIN site_gates g ON g.id = v.gate_id JOIN employees e ON e.id = v.entry_guard LEFT JOIN employees x ON x.id = v.exit_guard
        WHERE v.site_id = $1 AND (${IN_DAY('v.captured_at')} OR ${IN_DAY('v.exit_at')})`,
    )) {
      const who = `${visitorName(v.surname, v.names)}${v.registration ? `, ${v.registration}` : ', on foot'}`;
      if (this.sameDay(v.captured_at, day))
        add({
          key: `visit:${v.id}`,
          at: v.captured_at,
          category: 'visitor',
          text: `Visitor at ${v.gate}: ${who}, to see ${v.visiting}. ${VISIT_STATUS_LABELS[v.status as VisitStatus]}${v.captured_offline ? ' (no signal at the gate)' : ''}.`,
          by: v.guard,
          photo: v.photo ? `visit_face/${v.id}` : null,
          lateSynced: v.late_synced,
        });
      if (v.exit_at && this.sameDay(v.exit_at, day)) add({ key: `visit-out:${v.id}`, at: v.exit_at, category: 'visitor', text: `Visitor left: ${who}.`, by: v.exit_guard ?? '' });
    }
    for (const x of await rows(
      `SELECT x.id, x.raised_at, x.type, x.note, x.allowed, x.photo_key IS NOT NULL AS photo, e.full_name AS guard
         FROM visit_exceptions x JOIN employees e ON e.id = x.raised_by WHERE x.site_id = $1 AND ${IN_DAY('x.raised_at')}`,
    )) {
      add({
        key: `exception:${x.id}`,
        at: x.raised_at,
        category: 'visitor',
        text: `Visitor exception: ${EXCEPTION_LABELS[x.type as ExceptionType] ?? x.type}${x.note ? `. ${String(x.note).replace(/[.\s]+$/, '')}` : ''}. ${x.allowed ? 'Let go.' : 'Not let go.'}`,
        by: x.guard,
        photo: x.photo ? `exception/${x.id}` : null,
      });
    }

    // Shift handovers and emergency roll-calls.
    for (const h of await rows(
      `SELECT h.id, h.signed_at, h.received_at, h.note, h.received_note, h.report_id IS NOT NULL AS problem, h.received_report IS NOT NULL AS difference, f.full_name AS from_name, t.full_name AS to_name
         FROM shift_handovers h JOIN employees f ON f.id = h.from_employee LEFT JOIN employees t ON t.id = h.to_employee
        WHERE h.site_id = $1 AND (${IN_DAY('h.signed_at')} OR ${IN_DAY('h.received_at')})`,
    )) {
      if (this.sameDay(h.signed_at, day)) add({ key: `handover:${h.id}`, at: h.signed_at, category: 'handover', text: `Shift handed over${h.problem ? ', with missing or damaged equipment reported' : ''}.${h.note ? ` Note: ${h.note}` : ''}`, by: h.from_name });
      if (h.received_at && this.sameDay(h.received_at, day)) add({ key: `handover-in:${h.id}`, at: h.received_at, category: 'handover', text: `Handover received${h.difference ? ', with a difference reported' : ''}.${h.received_note ? ` Note: ${h.received_note}` : ''}`, by: h.to_name ?? '' });
    }
    for (const r of await rows(
      `SELECT r.id, r.started_at, r.closed_at, r.reason, r.close_note, a.full_name AS started_by, b.full_name AS closed_by
         FROM roll_calls r JOIN users a ON a.id = r.started_by LEFT JOIN users b ON b.id = r.closed_by
        WHERE r.site_id = $1 AND (${IN_DAY('r.started_at')} OR ${IN_DAY('r.closed_at')})`,
    )) {
      if (this.sameDay(r.started_at, day)) add({ key: `roll:${r.id}`, at: r.started_at, category: 'roll_call', alert: 'red', text: `Emergency roll-call started${r.reason ? `: ${r.reason}` : '.'}`, by: r.started_by });
      if (r.closed_at && this.sameDay(r.closed_at, day)) add({ key: `roll-end:${r.id}`, at: r.closed_at, category: 'roll_call', text: `Roll-call closed${r.close_note ? `: ${r.close_note}` : '.'}`, by: r.closed_by ?? '' });
    }

    // Written by hand in the book.
    for (const o of await rows(
      `SELECT o.id, o.occurred_at, o.text, o.corrects, o.written_at, u.full_name AS by FROM ob_entries o JOIN users u ON u.id = o.written_by WHERE o.site_id = $1 AND ${IN_DAY('o.occurred_at')}`,
    )) {
      add({ key: `entry:${o.id}`, at: o.occurred_at, category: 'entry', text: `${o.corrects ? 'Correction: ' : ''}${o.text}`, by: o.by });
    }

    return out.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime() || a.key.localeCompare(b.key));
  }

  /** Whether a moment falls on the South African day. */
  private sameDay(d: Date | string, day: string) {
    return new Date(new Date(d).getTime() + 2 * 3600_000).toISOString().slice(0, 10) === day;
  }
}
