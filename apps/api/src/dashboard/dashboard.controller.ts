import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import {
  can,
  complianceSummary,
  computeScore,
  occurrenceStatus,
  percent,
  reportOverdue,
  sastDate,
  unfilledPosts,
  ComplianceSummary,
  OccurrenceState,
  Priority,
  QualificationStatus,
  POSITION_LABELS,
  SCAN_RESULT_LABELS,
} from '@onpar/rules';
import { CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { DbService, Tx } from '../db/db.service';
import { ScoringService } from '../scoring/scoring.service';
import { currentItems } from '../training/training.controller';
import { RosterService } from '../roster/roster.service';

/** Groups rows by a key once, rather than searching the whole list for each key. */
function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/** A device counts as offline when it has not been in touch for an hour. */
const DEVICE_OFFLINE_MS = 60 * 60 * 1000;

export interface Figures {
  attendance: { scheduled: number; onTime: number; late: number; absent: number; onDuty: number } | null;
  tasks: { total: number; completed: number; outstanding: number; overdue: number; missed: number; couldNotComplete: number } | null;
  reports: { open: number; actionRequired: number; overdue: number; redOpen: number } | null;
  reorders: { open: number } | null;
  patrols: { alertsOpen: number; completed: number; due: number; compliancePercent: number | null } | null;
  training: ComplianceSummary | null;
  performance: { officers: number; needsAttention: number } | null;
  devices: { active: number; offline: number } | null;
}

interface Show {
  operations: boolean;
  training: boolean;
  performance: boolean;
  devices: boolean;
}

/** Which parts of the dashboard a role sees. A client or estate manager gets the operational summary only. */
function sections(user: UserPrincipal): Show {
  return {
    operations: can(user.role, 'attendance.view') || user.role === 'client_manager',
    training: can(user.role, 'training.view'),
    performance: can(user.role, 'scores.view'),
    devices: can(user.role, 'devices.view'),
  };
}

function validDate(date?: string) {
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : sastDate(new Date());
}

/** The management dashboard (section 6.11): figures, then drill-down from company to site to officer to event. */
@Controller('dashboard')
@UseGuards(UserAuthGuard)
export class DashboardController {
  constructor(
    private readonly db: DbService,
    private readonly scoring: ScoringService,
    private readonly roster: RosterService,
  ) {}

  /** Company figures for one day, with the same figures for each site. */
  @Get()
  @RequirePermission('dashboard.view')
  company(@CurrentUser() user: UserPrincipal, @Query('date') date?: string) {
    const day = validDate(date);
    return this.db.withTenant(user.companyId, async (tx) => {
      const sites = (
        await tx.query(`SELECT id, name FROM sites WHERE ($1::uuid[] IS NULL OR id = ANY($1::uuid[])) ORDER BY lower(name)`, [user.siteIds])
      ).rows;
      const bySite = await this.figures(tx, user, day, sites.map((s) => s.id));
      const alerts = can(user.role, 'patrols.view') ? await this.openAlerts(tx, sites.map((s) => s.id)) : [];
      return {
        date: day,
        today: sastDate(new Date()),
        totals: bySite.totals,
        sites: sites.map((s) => ({ siteId: s.id, siteName: s.name, figures: bySite.sites.get(s.id)! })),
        patrolCompliance: bySite.patrolCompliance,
        alerts,
      };
    });
  }

  /** One site: its figures, each officer's day, declarations, checkpoint readings and devices. */
  @Get('sites/:id')
  @RequirePermission('attendance.view')
  site(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Query('date') date?: string) {
    const day = validDate(date);
    return this.db.withTenant(user.companyId, async (tx) => {
      const site = (await tx.query('SELECT id, name, client, armed FROM sites WHERE id = $1', [id])).rows[0];
      if (!site || (user.siteIds && !user.siteIds.includes(id))) throw new NotFoundException('Site not found.');
      const f = await this.figures(tx, user, day, [id]);
      const show = sections(user);

      // Everyone based here, plus anyone who worked here that day.
      const officers = (
        await tx.query(
          `SELECT e.id, e.full_name AS name, e.employee_number AS "employeeNumber", e.home_site_id = $1 AS "homeSite"
             FROM employees e
            WHERE e.status = 'active' AND (e.home_site_id = $1 OR EXISTS (SELECT 1 FROM attendance a WHERE a.employee_id = e.id AND a.site_id = $1 AND a.shift_date = $2))
            ORDER BY lower(e.full_name)`,
          [id, day],
        )
      ).rows;
      const ids = officers.map((o) => o.id);
      const attendance = (
        await tx.query(
          `SELECT id, employee_id, shift_name AS "shiftName", arrival_status AS "arrivalStatus", late_minutes AS "lateMinutes",
                  duty_on_at AS "dutyOnAt", duty_from_at AS "dutyFromAt", departure_status AS "departureStatus",
                  early_minutes AS "earlyMinutes", exception_reason AS "exceptionReason"
             FROM attendance WHERE site_id = $1 AND shift_date = $2 ORDER BY duty_on_at`,
          [id, day],
        )
      ).rows;
      const tasks = (
        await tx.query(
          `SELECT o.state, o.occurrence_date AS date, to_char(o.due_time, 'HH24:MI') AS "dueTime", o.assignee_employee_id, o.done_by
             FROM task_occurrences o WHERE o.site_id = $1 AND o.occurrence_date = $2 AND o.state <> 'cancelled'`,
          [id, day],
        )
      ).rows;
      const patrols = (
        await tx.query(
          `SELECT employee_id, state FROM patrol_instances WHERE site_id = $1 AND window_start >= $2::date::timestamptz AND window_start < ($2::date + 1)::timestamptz`,
          [id, day],
        )
      ).rows;
      const reports = (
        await tx.query(
          `SELECT reported_by_employee FROM reports WHERE site_id = $1 AND reported_at >= $2::date::timestamptz AND reported_at < ($2::date + 1)::timestamptz`,
          [id, day],
        )
      ).rows;
      const training = show.training ? await currentItems(tx, null, null) : [];
      const scores = show.performance ? await this.scores(tx, ids, day) : new Map<string, { score: number; position: string }>();
      const now = new Date();
      const worst = (statuses: QualificationStatus[]) =>
        statuses.includes('EXPIRED') ? 'EXPIRED' : statuses.includes('EXPIRING') ? 'EXPIRING' : 'COMPLIANT';

      const rows = officers.map((o) => {
        const shifts = attendance.filter((a) => a.employee_id === o.id);
        const mine = tasks.filter((t) => t.done_by === o.id || t.assignee_employee_id === o.id);
        const pats = patrols.filter((p) => p.employee_id === o.id);
        const s = scores.get(o.id);
        return {
          ...o,
          shifts: shifts.map(({ employee_id: _e, ...a }) => a),
          tasks: {
            completed: mine.filter((t) => t.state === 'completed' && t.done_by === o.id).length,
            open: mine.filter((t) => ['open', 'overdue', 'upcoming'].includes(occurrenceStatus(t.state as OccurrenceState, t.date, t.dueTime, now))).length,
          },
          patrols: {
            completed: pats.filter((p) => p.state === 'completed').length,
            missed: pats.filter((p) => p.state === 'missed').length,
            total: pats.filter((p) => p.state !== 'active').length,
          },
          reportsMade: reports.filter((r) => r.reported_by_employee === o.id).length,
          training: show.training ? worst(training.filter((t) => t.employeeId === o.id).map((t) => t.status)) : null,
          score: s ? s.score : null,
          position: s ? s.position : null,
          positionLabel: s ? POSITION_LABELS[s.position as keyof typeof POSITION_LABELS] : null,
        };
      });

      const declarations = (
        await tx.query(
          `SELECT d.id, d.attendance_id AS "attendanceId", d.kind, d.comment, d.official_at AS "at", d.selfie_key IS NOT NULL AS "hasSelfie",
                  d.late_synced AS "lateSynced", e.full_name AS "employeeName",
                  (SELECT r.id FROM reports r WHERE r.source = 'declaration' AND r.source_id = d.id) AS "reportId"
             FROM declarations d JOIN attendance a ON a.id = d.attendance_id JOIN employees e ON e.id = d.employee_id
            WHERE a.site_id = $1 AND a.shift_date = $2 ORDER BY d.official_at DESC`,
          [id, day],
        )
      ).rows;
      const readings = (
        await tx.query(
          `SELECT r.id, r.patrol_id AS "patrolId", r.label, r.kind, r.value_num::float AS "valueNum", r.value_ok AS "valueOk", r.unit,
                  r.out_of_limit AS "outOfLimit", r.report_id AS "reportId", r.at, pt.name AS "pointName", e.full_name AS "employeeName"
             FROM patrol_readings r JOIN patrol_points pt ON pt.id = r.point_id JOIN patrol_instances p ON p.id = r.patrol_id
             JOIN employees e ON e.id = p.employee_id
            WHERE pt.site_id = $1 AND r.at >= $2::date::timestamptz AND r.at < ($2::date + 1)::timestamptz ORDER BY r.at DESC LIMIT 200`,
          [id, day],
        )
      ).rows;
      const scans = (
        await tx.query(
          `SELECT sc.id, sc.patrol_id AS "patrolId", sc.result, sc.official_at AS "at", sc.distance_m AS "distanceM", pt.name AS "pointName",
                  e.full_name AS "employeeName"
             FROM patrol_scans sc JOIN employees e ON e.id = sc.employee_id LEFT JOIN patrol_points pt ON pt.id = sc.point_id
            WHERE pt.site_id = $1 AND sc.result LIKE 'rejected%' AND sc.official_at >= $2::date::timestamptz AND sc.official_at < ($2::date + 1)::timestamptz
            ORDER BY sc.official_at DESC LIMIT 100`,
          [id, day],
        )
      ).rows.map((r) => ({ ...r, label: SCAN_RESULT_LABELS[r.result as keyof typeof SCAN_RESULT_LABELS] ?? r.result }));
      const devices = show.devices
        ? (
            await tx.query(
              `SELECT id, label, post_name AS "postName", status, kiosk_status AS "kioskStatus", app_version AS "appVersion",
                      last_seen_at AS "lastSeenAt", battery_pct AS "batteryPct"
                 FROM devices WHERE site_id = $1 AND status <> 'retired' ORDER BY label`,
              [id],
            )
          ).rows
        : null;

      return {
        date: day,
        today: sastDate(new Date()),
        site,
        figures: f.sites.get(id)!,
        patrolCompliance: f.patrolCompliance,
        alerts: await this.openAlerts(tx, [id]),
        officers: rows,
        declarations,
        readings,
        rejectedScans: scans,
        devices,
      };
    });
  }

  /** One officer's day: shifts and declarations, tasks, patrols, reports and follow-ups, training and performance events. */
  @Get('officers/:id')
  @RequirePermission('attendance.view')
  officer(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Query('date') date?: string) {
    const day = validDate(date);
    return this.db.withTenant(user.companyId, async (tx) => {
      const o = (
        await tx.query(
          `SELECT e.id, e.full_name AS name, e.employee_number AS "employeeNumber", e.home_site_id AS "homeSiteId", s.name AS "homeSiteName"
             FROM employees e JOIN sites s ON s.id = e.home_site_id WHERE e.id = $1`,
          [id],
        )
      ).rows[0];
      const visible =
        o &&
        (!user.siteIds ||
          user.siteIds.includes(o.homeSiteId) ||
          (await tx.query('SELECT 1 FROM attendance WHERE employee_id = $1 AND shift_date = $2 AND site_id = ANY($3::uuid[])', [id, day, user.siteIds]))
            .rowCount);
      if (!visible) throw new NotFoundException('Officer not found.');
      const scope = user.siteIds;
      const show = sections(user);
      const now = new Date();

      const shifts = (
        await tx.query(
          `SELECT a.id, a.shift_name AS "shiftName", a.scheduled_start AS "scheduledStart", a.scheduled_end AS "scheduledEnd",
                  a.duty_on_at AS "dutyOnAt", a.duty_from_at AS "dutyFromAt", a.arrival_status AS "arrivalStatus", a.late_minutes AS "lateMinutes",
                  a.departure_status AS "departureStatus", a.early_minutes AS "earlyMinutes", a.exception_reason AS "exceptionReason",
                  s.id AS "siteId", s.name AS "siteName",
                  coalesce((SELECT json_agg(json_build_object('id', d.id, 'kind', d.kind, 'comment', d.comment, 'at', d.official_at,
                                                              'hasSelfie', d.selfie_key IS NOT NULL) ORDER BY d.official_at)
                              FROM declarations d WHERE d.attendance_id = a.id), '[]') AS declarations
             FROM attendance a JOIN sites s ON s.id = a.site_id
            WHERE a.employee_id = $1 AND a.shift_date = $2 AND ($3::uuid[] IS NULL OR a.site_id = ANY($3::uuid[]))
            ORDER BY a.duty_on_at`,
          [id, day, scope],
        )
      ).rows;
      // His own tasks, and the post's tasks at a site where he was on duty that day (every guard on duty shares them).
      const tasks = (
        await tx.query(
          `SELECT o.id, o.title, o.state, o.occurrence_date AS date, to_char(o.due_time, 'HH24:MI') AS "dueTime", o.done_at AS "doneAt",
                  o.done_by = $1 AS "doneByMe", ex.full_name AS "doneByName", o.comment, o.cannot_reason AS "cannotReason", o.review,
                  s.name AS "siteName"
             FROM task_occurrences o JOIN sites s ON s.id = o.site_id LEFT JOIN employees ex ON ex.id = o.done_by
            WHERE o.occurrence_date = $2 AND o.state <> 'cancelled' AND ($3::uuid[] IS NULL OR o.site_id = ANY($3::uuid[]))
              AND (o.assignee_employee_id = $1 OR o.done_by = $1
                   OR (o.assignee_type = 'post' AND EXISTS (SELECT 1 FROM attendance a WHERE a.employee_id = $1 AND a.site_id = o.site_id AND a.shift_date = $2)))
            ORDER BY o.due_time NULLS LAST, o.title`,
          [id, day, scope],
        )
      ).rows.map((t) => ({ ...t, status: occurrenceStatus(t.state as OccurrenceState, t.date, t.dueTime, now) }));
      const patrols = (
        await tx.query(
          `SELECT p.id, p.state, p.window_start AS "windowStart", p.window_end AS "windowEnd", p.started_at AS "startedAt",
                  p.finished_at AS "finishedAt", p.points_earned::float AS "pointsEarned", p.partial_reason AS "partialReason", p.review,
                  t.code AS "typeCode", t.name AS "typeName", s.name AS "siteName"
             FROM patrol_instances p JOIN patrol_types t ON t.id = p.patrol_type_id JOIN sites s ON s.id = p.site_id
            WHERE p.employee_id = $1 AND p.window_start >= $2::date::timestamptz AND p.window_start < ($2::date + 1)::timestamptz
              AND ($3::uuid[] IS NULL OR p.site_id = ANY($3::uuid[]))
            ORDER BY p.window_start, t.code`,
          [id, day, scope],
        )
      ).rows;
      const reports = (
        await tx.query(
          `SELECT r.id, r.number, r.category, r.priority, r.stage, r.description, r.reported_at AS "reportedAt", s.name AS "siteName"
             FROM reports r JOIN sites s ON s.id = r.site_id
            WHERE r.reported_by_employee = $1 AND r.reported_at >= $2::date::timestamptz AND r.reported_at < ($2::date + 1)::timestamptz
              AND ($3::uuid[] IS NULL OR r.site_id = ANY($3::uuid[]))
            ORDER BY r.reported_at`,
          [id, day, scope],
        )
      ).rows;
      // Actions: his follow-ups and inspections on any report that day.
      const actions = (
        await tx.query(
          `SELECT h.id, h.report_id AS "reportId", r.number AS "reportNumber", h.action, h.outcome, h.note, h.at, h.stage_after AS "stageAfter"
             FROM report_history h JOIN reports r ON r.id = h.report_id
            WHERE h.actor_type = 'employee' AND h.actor_id = $1 AND h.action <> 'reported'
              AND h.at >= $2::date::timestamptz AND h.at < ($2::date + 1)::timestamptz AND ($3::uuid[] IS NULL OR r.site_id = ANY($3::uuid[]))
            ORDER BY h.at`,
          [id, day, scope],
        )
      ).rows;

      let performance = null;
      if (show.performance) {
        const c = await this.scoring.config(tx);
        const from = computeScore([], day, c).from;
        const all = (
          await tx.query(
            `SELECT id, event_date AS date, event_type AS type, impact::float AS impact, evidence, source_type AS "sourceType",
                    source_id AS "sourceId", created_by_label AS "by", created_at AS "createdAt"
               FROM performance_events WHERE employee_id = $1 AND event_date >= $2 AND event_date <= $3 ORDER BY created_at`,
            [id, from, day],
          )
        ).rows;
        const r = computeScore(all, day, c);
        performance = { score: r.score, position: r.position, positionLabel: POSITION_LABELS[r.position], events: all.filter((e) => e.date === day) };
      }
      const training = show.training ? (await currentItems(tx, null, null, id)).map(({ qualificationId, name, expiryDate, status }) => ({ qualificationId, name, expiryDate, status })) : null;

      return { date: day, today: sastDate(new Date()), officer: o, shifts, tasks, patrols, reports, actions, training, performance };
    });
  }

  /** Figures for each of the given sites, and the totals across them. */
  async figures(tx: Tx, user: UserPrincipal, day: string, siteIds: string[]) {
    const show = sections(user);
    const now = new Date();
    const blank = (): Figures => ({
      attendance: show.operations ? { scheduled: 0, onTime: 0, late: 0, absent: 0, onDuty: 0 } : null,
      tasks: show.operations ? { total: 0, completed: 0, outstanding: 0, overdue: 0, missed: 0, couldNotComplete: 0 } : null,
      reports: show.operations ? { open: 0, actionRequired: 0, overdue: 0, redOpen: 0 } : null,
      reorders: show.operations ? { open: 0 } : null,
      patrols: show.operations ? { alertsOpen: 0, completed: 0, due: 0, compliancePercent: null } : null,
      training: null,
      performance: show.performance ? { officers: 0, needsAttention: 0 } : null,
      devices: show.devices ? { active: 0, offline: 0 } : null,
    });
    const sites = new Map<string, Figures>(siteIds.map((id) => [id, blank()]));
    const totals = blank();
    const each = (siteId: string, fn: (f: Figures) => void) => {
      const f = sites.get(siteId);
      if (!f) return;
      fn(f);
      fn(totals);
    };
    const patrolCompliance: { siteId: string; siteName: string; typeCode: string; typeName: string; completed: number; due: number; compliancePercent: number | null }[] = [];

    if (show.operations) {
      const grace = (await tx.query('SELECT grace_minutes FROM companies')).rows[0].grace_minutes;
      const shifts = (
        await tx.query(`SELECT id, site_id, start_time::text AS start, guards_required FROM site_shifts WHERE site_id = ANY($1::uuid[])`, [siteIds])
      ).rows;
      const att = (
        await tx.query(
          `SELECT site_id, shift_id, arrival_status, duty_from_at IS NULL AS on_duty FROM attendance WHERE shift_date = $1 AND site_id = ANY($2::uuid[])`,
          [day, siteIds],
        )
      ).rows;
      // Rostered sites (milestone 21): each guard rostered here today is scheduled, and absent once
      // his shift is past its start plus the grace period with no Duty On at that site for that day.
      const rosteredIds = (
        await tx.query(
          `SELECT employee_id FROM roster_allocations WHERE site_id = ANY($1::uuid[]) AND start_date <= $2 AND (end_date IS NULL OR end_date > $2)
           UNION
           SELECT c.employee_id FROM roster_changes c JOIN site_shifts sh ON sh.id = c.shift_id
            WHERE sh.site_id = ANY($1::uuid[]) AND (c.date = $2 OR (c.date IS NULL AND c.from_date <= $2 AND (c.until_date IS NULL OR c.until_date >= $2)))`,
          [siteIds, day],
        )
      ).rows.map((r) => r.employee_id);
      const rosterDays = await this.roster.days(tx, rosteredIds, day, day);
      const came = new Set(
        (await tx.query('SELECT employee_id, site_id FROM attendance WHERE shift_date = $1 AND employee_id = ANY($2::uuid[])', [day, rosteredIds])).rows.map(
          (r) => `${r.employee_id}|${r.site_id}`,
        ),
      );
      const rosteredSites = new Set<string>();
      for (const [employeeId, [d]] of rosterDays) {
        if (d.status !== 'working' || !sites.has(d.siteId)) continue;
        rosteredSites.add(d.siteId);
        each(d.siteId, (f) => {
          f.attendance!.scheduled++;
          if (!came.has(`${employeeId}|${d.siteId}`)) f.attendance!.absent += unfilledPosts(1, 0, day, d.startTime, now, grace);
        });
      }
      // Sites with nobody rostered yet keep the interim count: each unfilled post is absent.
      for (const s of shifts) {
        if (rosteredSites.has(s.site_id)) continue;
        const arrived = att.filter((a) => a.shift_id === s.id).length;
        each(s.site_id, (f) => {
          f.attendance!.scheduled += s.guards_required;
          f.attendance!.absent += unfilledPosts(s.guards_required, arrived, day, s.start, now, grace);
        });
      }
      for (const a of att) {
        each(a.site_id, (f) => {
          if (a.arrival_status === 'ON_TIME') f.attendance!.onTime++;
          if (a.arrival_status === 'LATE') f.attendance!.late++;
          if (a.on_duty) f.attendance!.onDuty++;
        });
      }

      const occ = (
        await tx.query(
          `SELECT site_id, state, occurrence_date AS date, to_char(due_time, 'HH24:MI') AS "dueTime" FROM task_occurrences
            WHERE occurrence_date = $1 AND state <> 'cancelled' AND site_id = ANY($2::uuid[])`,
          [day, siteIds],
        )
      ).rows;
      for (const o of occ) {
        const st = occurrenceStatus(o.state as OccurrenceState, o.date, o.dueTime, now);
        each(o.site_id, (f) => {
          const t = f.tasks!;
          t.total++;
          if (st === 'completed') t.completed++;
          else if (st === 'open' || st === 'upcoming') t.outstanding++;
          else if (st === 'overdue') t.overdue++;
          else if (st === 'missed') t.missed++;
          else if (st === 'could_not_complete') t.couldNotComplete++;
        });
      }

      const reports = (
        await tx.query(`SELECT site_id, priority, stage, needs_attention, reported_at FROM reports WHERE stage <> 'closed' AND site_id = ANY($1::uuid[])`, [siteIds])
      ).rows;
      for (const r of reports) {
        each(r.site_id, (f) => {
          const x = f.reports!;
          x.open++;
          if (r.stage === 'reported' || r.needs_attention) x.actionRequired++;
          if (reportOverdue(r.priority as Priority, new Date(r.reported_at), now)) x.overdue++;
          if (r.priority === 'red') x.redOpen++;
        });
      }

      const reorders = (
        await tx.query(`SELECT site_id, count(*)::int AS n FROM reorders WHERE stage <> 'received' AND site_id = ANY($1::uuid[]) GROUP BY site_id`, [siteIds])
      ).rows;
      for (const r of reorders) each(r.site_id, (f) => (f.reorders!.open += r.n));

      const alerts = (
        await tx.query(`SELECT site_id, count(*)::int AS n FROM patrol_alerts WHERE cleared_at IS NULL AND site_id = ANY($1::uuid[]) GROUP BY site_id`, [siteIds])
      ).rows;
      for (const a of alerts) each(a.site_id, (f) => (f.patrols!.alertsOpen += a.n));

      // Compliance per type: completed out of the windows that have closed or finished (a patrol in progress is not yet due).
      const pats = (
        await tx.query(
          `SELECT p.site_id, p.state, t.code, t.name, s.name AS site_name
             FROM patrol_instances p JOIN patrol_types t ON t.id = p.patrol_type_id JOIN sites s ON s.id = p.site_id
            WHERE p.window_start >= $1::date::timestamptz AND p.window_start < ($1::date + 1)::timestamptz AND p.site_id = ANY($2::uuid[])
            ORDER BY s.name, t.code`,
          [day, siteIds],
        )
      ).rows;
      const byType = new Map<string, (typeof patrolCompliance)[number]>();
      for (const p of pats) {
        const k = `${p.site_id}:${p.code}`;
        const v = byType.get(k) ?? { siteId: p.site_id, siteName: p.site_name, typeCode: p.code, typeName: p.name, completed: 0, due: 0, compliancePercent: null };
        if (p.state !== 'active') v.due++;
        if (p.state === 'completed') v.completed++;
        byType.set(k, v);
        each(p.site_id, (f) => {
          if (p.state !== 'active') f.patrols!.due++;
          if (p.state === 'completed') f.patrols!.completed++;
        });
      }
      for (const v of byType.values()) patrolCompliance.push({ ...v, compliancePercent: percent(v.completed, v.due) });
      for (const f of [...sites.values(), totals]) f.patrols!.compliancePercent = percent(f.patrols!.completed, f.patrols!.due);
    }

    if (show.training) {
      const items = (await currentItems(tx, null, null)).filter((i) => sites.has(i.siteId));
      for (const [id, f] of sites) f.training = complianceSummary(items.filter((i) => i.siteId === id).map((i) => i.status));
      totals.training = complianceSummary(items.map((i) => i.status));
    }

    if (show.performance) {
      const officers = (await tx.query(`SELECT id, home_site_id FROM employees WHERE status = 'active' AND home_site_id = ANY($1::uuid[])`, [siteIds])).rows;
      const scores = await this.scores(tx, officers.map((o) => o.id), day);
      for (const o of officers) {
        each(o.home_site_id, (f) => {
          f.performance!.officers++;
          if (scores.get(o.id)?.position === 'NEEDS_ATTENTION') f.performance!.needsAttention++;
        });
      }
    }

    if (show.devices) {
      const devices = (
        await tx.query(`SELECT site_id, status, last_seen_at FROM devices WHERE status = 'active' AND site_id = ANY($1::uuid[])`, [siteIds])
      ).rows;
      for (const d of devices) {
        each(d.site_id, (f) => {
          f.devices!.active++;
          if (!d.last_seen_at || now.getTime() - new Date(d.last_seen_at).getTime() > DEVICE_OFFLINE_MS) f.devices!.offline++;
        });
      }
    }

    return { sites, totals, patrolCompliance };
  }

  /** Current scores for the given officers, as of the given day. */
  private async scores(tx: Tx, employeeIds: string[], day: string) {
    const c = await this.scoring.config(tx);
    const from = computeScore([], day, c).from;
    const events = (
      await tx.query(
        `SELECT employee_id, event_date AS date, impact::float AS impact FROM performance_events
          WHERE event_date >= $1 AND event_date <= $2 AND employee_id = ANY($3::uuid[])`,
        [from, day, employeeIds],
      )
    ).rows;
    const byEmployee = groupBy(events, (e) => e.employee_id as string);
    return new Map(
      employeeIds.map((id) => {
        const r = computeScore(byEmployee.get(id) ?? [], day, c);
        return [id, { score: r.score, position: r.position as string }];
      }),
    );
  }

  private async openAlerts(tx: Tx, siteIds: string[]) {
    return (
      await tx.query(
        `SELECT al.id, al.patrol_id AS "patrolId", al.raised_at AS "raisedAt", al.acknowledged_at AS "acknowledgedAt", al.escalated_at AS "escalatedAt",
                e.full_name AS "employeeName", s.name AS "siteName", t.name AS "typeName"
           FROM patrol_alerts al JOIN patrol_instances p ON p.id = al.patrol_id JOIN patrol_types t ON t.id = p.patrol_type_id
           JOIN employees e ON e.id = al.employee_id JOIN sites s ON s.id = al.site_id
          WHERE al.cleared_at IS NULL AND al.site_id = ANY($1::uuid[]) ORDER BY al.raised_at`,
        [siteIds],
      )
    ).rows;
  }
}
