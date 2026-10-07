import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { can, REPORT_CATEGORIES, ReportCategory } from '@onpar/rules';
import { CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { DbService, Tx } from '../db/db.service';
import { DutyService } from '../attendance/duty.service';

/** One thing needing a supervisor's attention, whatever kind it is. */
export interface OpenAlert {
  type: 'panic' | 'bolo' | 'patrol_overdue' | 'post_uncovered' | 'red_report';
  id: string;
  siteId: string | null;
  siteName: string;
  at: string;
  title: string;
  detail: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  /** The phone-sized page for it. */
  url: string;
  /** The guard's own cell number, when there is a guard, for the Call button. */
  guardCell: string | null;
}

const PANIC_SELECT = `SELECT p.id, p.site_id, coalesce(s.name, 'No site') AS site_name, p.raised_at, p.late_synced, p.lat, p.lng, p.accuracy_m,
    p.location_mock, p.call_started, p.acknowledged_at, ua.full_name AS acknowledged_by, p.resolved_at, ur.full_name AS resolved_by,
    p.resolution_note, d.label AS device_label, d.post_name, e.full_name AS guard, e.employee_number, e.cell_number AS guard_cell,
    (SELECT phone FROM site_contacts c WHERE c.site_id = p.site_id AND c.kind = 'control_room') AS control_room
  FROM panic_alerts p JOIN devices d ON d.id = p.device_id LEFT JOIN sites s ON s.id = p.site_id
  LEFT JOIN employees e ON e.id = p.employee_id LEFT JOIN users ua ON ua.id = p.acknowledged_by LEFT JOIN users ur ON ur.id = p.resolved_by`;

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const short = (text: string, max = 140) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * The supervisor app (plan of 6 Oct 2026, phase 2): what a supervisor needs on a phone, in one
 * request. It only reads; every action uses the same endpoints as the website, so the rules
 * and the audit trail are the same on both.
 */
@Controller('supervisor')
@UseGuards(UserAuthGuard)
export class SupervisorController {
  constructor(
    private readonly db: DbService,
    private readonly duty: DutyService,
  ) {}

  /** The supervisor's sites with who is on duty now, and everything open that needs attention. */
  @Get('home')
  @RequirePermission('attendance.view')
  home(@CurrentUser() user: UserPrincipal) {
    const now = new Date();
    return this.db.withTenant(user.companyId, async (tx) => {
      const sites = (await tx.query(`SELECT id, name FROM sites WHERE ($1::uuid[] IS NULL OR id = ANY($1::uuid[])) ORDER BY lower(name)`, [user.siteIds])).rows;
      const contacts = (await tx.query(`SELECT site_id, kind, name, phone FROM site_contacts WHERE kind IN ('supervisor','site_manager','control_room') AND ($1::uuid[] IS NULL OR site_id = ANY($1::uuid[]))`, [user.siteIds])).rows;
      const onDuty = (
        await tx.query(
          `SELECT a.id, a.site_id, a.employee_id, e.full_name, e.employee_number, e.cell_number, a.shift_name, a.scheduled_start, a.scheduled_end,
                  a.duty_on_at, a.arrival_status, a.late_minutes
             FROM attendance a JOIN employees e ON e.id = a.employee_id
            WHERE a.duty_from_at IS NULL AND ($1::uuid[] IS NULL OR a.site_id = ANY($1::uuid[]))
            ORDER BY a.duty_on_at`,
          [user.siteIds],
        )
      ).rows;
      const overdue = await this.duty.overdueShifts(tx, now, user.siteIds);
      const relief = new Map(overdue.map((o) => [o.attendanceId, o]));
      const alerts = await this.openAlerts(tx, user, overdue);
      return {
        now: now.toISOString(),
        sites: sites.map((s) => ({
          id: s.id,
          name: s.name,
          contacts: contacts.filter((c) => c.site_id === s.id).map((c) => ({ kind: c.kind, name: c.name, phone: c.phone })),
          openAlerts: alerts.filter((a) => a.siteId === s.id).length,
          onDuty: onDuty
            .filter((a) => a.site_id === s.id)
            .map((a) => {
              const r = relief.get(a.id);
              return {
                attendanceId: a.id,
                employeeId: a.employee_id,
                name: a.full_name,
                employeeNumber: a.employee_number,
                cell: a.cell_number,
                shiftName: a.shift_name,
                scheduledStart: iso(a.scheduled_start),
                scheduledEnd: iso(a.scheduled_end),
                dutyOnAt: iso(a.duty_on_at),
                late: a.arrival_status === 'LATE' ? (a.late_minutes as number) : 0,
                // Past the end of his shift: still waiting for his relief, or the post is uncovered.
                relief: !r ? null : r.outcome === 'no_relief' ? 'uncovered' : r.outcome === 'wait' ? 'waiting' : r.outcome === 'relieved' ? 'relieved' : null,
                reliefUnlocksAt: r ? iso(r.unlocksAt) : null,
              };
            }),
        })),
        alerts,
      };
    });
  }

  /** One panic in full, open or resolved, with the numbers to call. */
  @Get('panic/:id')
  @RequirePermission('panic.view')
  panic(@CurrentUser() user: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const p = (await tx.query(`${PANIC_SELECT} WHERE p.id = $1`, [id])).rows[0];
      if (!p || (user.siteIds && !user.siteIds.includes(p.site_id))) throw new NotFoundException('Panic alert not found.');
      return {
        id: p.id,
        siteId: p.site_id,
        siteName: p.site_name,
        postName: p.post_name || p.device_label,
        raisedAt: iso(p.raised_at),
        lateSynced: p.late_synced,
        lat: p.lat,
        lng: p.lng,
        accuracyM: p.accuracy_m,
        locationMock: p.location_mock,
        callStarted: p.call_started,
        emergencyCalls: (
          await tx.query(
            `SELECT c.service, c.national, c.called_at AS "calledAt", e.full_name AS by FROM emergency_calls c LEFT JOIN employees e ON e.id = c.employee_id WHERE c.panic_id = $1 ORDER BY c.called_at`,
            [id],
          )
        ).rows,
        guard: p.guard,
        employeeNumber: p.employee_number,
        guardCell: p.guard_cell,
        controlRoom: p.control_room,
        acknowledgedAt: iso(p.acknowledged_at),
        acknowledgedBy: p.acknowledged_by,
        resolvedAt: iso(p.resolved_at),
        resolvedBy: p.resolved_by,
        resolutionNote: p.resolution_note,
        canManage: can(user.role, 'panic.manage'),
      };
    });
  }

  /** Everything open, most urgent kind first, newest first within a kind. Each kind only for roles that may see it. */
  private async openAlerts(tx: Tx, user: UserPrincipal, overdue: Awaited<ReturnType<DutyService['overdueShifts']>>): Promise<OpenAlert[]> {
    const out: OpenAlert[] = [];
    const sites = [user.siteIds];
    if (can(user.role, 'panic.view')) {
      for (const p of (await tx.query(`${PANIC_SELECT} WHERE p.resolved_at IS NULL AND ($1::uuid[] IS NULL OR p.site_id = ANY($1::uuid[])) ORDER BY p.raised_at DESC`, sites)).rows) {
        out.push({
          type: 'panic',
          id: p.id,
          siteId: p.site_id,
          siteName: p.site_name,
          at: iso(p.raised_at)!,
          title: `Panic at ${p.site_name}`,
          detail: [p.post_name || p.device_label, p.guard].filter(Boolean).join(' · '),
          acknowledgedAt: iso(p.acknowledged_at),
          acknowledgedBy: p.acknowledged_by,
          url: `/m/panic/${p.id}`,
          guardCell: p.guard_cell,
        });
      }
    }
    if (can(user.role, 'attendance.view')) {
      for (const o of overdue.filter((x) => x.outcome === 'no_relief')) {
        out.push({
          type: 'post_uncovered',
          id: o.attendanceId,
          siteId: o.siteId,
          siteName: o.siteName,
          at: iso(o.unlocksAt ?? o.scheduledEnd)!,
          title: `Post uncovered at ${o.siteName}`,
          detail: `${o.name}'s relief has not arrived.`,
          acknowledgedAt: null,
          acknowledgedBy: null,
          url: '/m/duty',
          guardCell: null,
        });
      }
    }
    if (can(user.role, 'patrols.view')) {
      const rows = (
        await tx.query(
          `SELECT al.id, al.site_id, s.name AS site_name, al.raised_at, al.acknowledged_at, u.full_name AS acknowledged_by,
                  e.full_name AS guard, e.cell_number AS guard_cell, t.name AS type_name
             FROM patrol_alerts al JOIN patrol_instances p ON p.id = al.patrol_id JOIN patrol_types t ON t.id = p.patrol_type_id
             JOIN employees e ON e.id = al.employee_id JOIN sites s ON s.id = al.site_id LEFT JOIN users u ON u.id = al.acknowledged_by
            WHERE al.cleared_at IS NULL AND ($1::uuid[] IS NULL OR al.site_id = ANY($1::uuid[])) ORDER BY al.raised_at DESC`,
          sites,
        )
      ).rows;
      for (const a of rows) {
        out.push({
          type: 'patrol_overdue',
          id: a.id,
          siteId: a.site_id,
          siteName: a.site_name,
          at: iso(a.raised_at)!,
          title: `Patrol overdue at ${a.site_name}`,
          detail: `${a.type_name} · ${a.guard}`,
          acknowledgedAt: iso(a.acknowledged_at),
          acknowledgedBy: a.acknowledged_by,
          url: '/m/alerts',
          guardCell: a.guard_cell,
        });
      }
    }
    if (can(user.role, 'reports.view')) {
      const bolos = (
        await tx.query(
          `SELECT b.id, b.site_id, coalesce(s.name, 'No site') AS site_name, b.reported_at, b.note, b.acknowledged_at, u.full_name AS acknowledged_by,
                  e.full_name AS guard, e.cell_number AS guard_cell
             FROM bolos b LEFT JOIN sites s ON s.id = b.site_id LEFT JOIN employees e ON e.id = b.employee_id LEFT JOIN users u ON u.id = b.acknowledged_by
            WHERE b.resolved_at IS NULL AND ($1::uuid[] IS NULL OR b.site_id = ANY($1::uuid[])) ORDER BY b.reported_at DESC`,
          sites,
        )
      ).rows;
      for (const b of bolos) {
        out.push({
          type: 'bolo',
          id: b.id,
          siteId: b.site_id,
          siteName: b.site_name,
          at: iso(b.reported_at)!,
          title: `BOLO at ${b.site_name}`,
          detail: [b.guard, short(b.note)].filter(Boolean).join(' · '),
          acknowledgedAt: iso(b.acknowledged_at),
          acknowledgedBy: b.acknowledged_by,
          url: '/reports/bolo',
          guardCell: b.guard_cell,
        });
      }
      const reports = (
        await tx.query(
          `SELECT r.id, r.number, r.site_id, s.name AS site_name, r.reported_at, r.category, r.description, r.stage
             FROM reports r JOIN sites s ON s.id = r.site_id
            WHERE r.priority = 'red' AND r.stage <> 'closed' AND ($1::uuid[] IS NULL OR r.site_id = ANY($1::uuid[])) ORDER BY r.reported_at DESC`,
          sites,
        )
      ).rows;
      for (const r of reports) {
        out.push({
          type: 'red_report',
          id: r.id,
          siteId: r.site_id,
          siteName: r.site_name,
          at: iso(r.reported_at)!,
          title: `Red report #${r.number} at ${r.site_name}`,
          detail: `${REPORT_CATEGORIES[r.category as ReportCategory]}: ${short(r.description)}`,
          // A report counts as picked up once it has moved past "reported".
          acknowledgedAt: r.stage === 'reported' ? null : iso(r.reported_at),
          acknowledgedBy: null,
          url: `/m/reports/${r.id}`,
          guardCell: null,
        });
      }
    }
    return out;
  }
}
