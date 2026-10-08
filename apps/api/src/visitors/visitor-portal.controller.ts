import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { maskIdNumber, VISIT_STATUS_LABELS, VisitStatus, vehicleLine, visitorName } from '@onpar/rules';
import { z } from 'zod';
import { assertSiteAccess, CurrentUser, RequirePermission, UserAuthGuard, UserPrincipal } from '../common/auth';
import { parseBody } from '../common/validation';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RetentionService } from '../privacy/retention.service';
import { StorageService } from '../storage/storage.service';
import { VisitOnSiteService } from './visit-onsite.service';
import { VisitPassService } from './visit-pass.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_BY = ['day', 'site', 'gate', 'unit', 'category', 'guard', 'status'] as const;
type ReportBy = (typeof REPORT_BY)[number];
/** The longest period one report covers. */
const MAX_DAYS = 366;
const LET_IN = `v.status IN ('on_site','exited','exited_exception','left_no_scan_out')`;
const TURNED_AWAY = `v.status IN ('denied','denied_no_response')`;
const LOCAL_DAY = `to_char(v.captured_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD')`;
const GROUP: Record<ReportBy, string> = {
  day: LOCAL_DAY,
  site: 's.name',
  gate: 'g.name',
  unit: `coalesce('Unit ' || u.name, 'The office')`,
  category: 'c.name',
  guard: 'e.full_name',
  status: 'v.status',
};

const StartBody = z.object({ reason: z.string().trim().max(200).default('') });
const MarkBody = z.object({ personKey: z.string().regex(/^(visit|guard):[0-9a-f-]{36}$/, 'Unknown person.'), status: z.enum(['safe', 'missing', 'clear']) });
const CloseBody = z.object({ note: z.string().trim().max(500).default('') });

interface SiteRow {
  siteId: string;
  site: string;
  onSite: number;
  overstays: number;
  needAction: number;
  expected: number;
  openExceptions: number;
  today: { visits: number; letIn: number; turnedAway: number; waiting: number; noSignal: number };
  rollCall: { id: string; startedAt: Date } | null;
}

/** A spreadsheet cell, safe from formulas. */
function cell(v: unknown): string {
  let t = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@]/.test(t)) t = `'${t}`;
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/**
 * The visitor portal (visitor specification: dashboard, reports and emergency roll-call; the
 * owner's step 5, 8 Oct 2026). Across the sites a manager may see, never more.
 */
@Controller()
@UseGuards(UserAuthGuard)
export class VisitorPortalController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly onSite: VisitOnSiteService,
    private readonly passes: VisitPassService,
    private readonly storage: StorageService,
    private readonly retention: RetentionService,
  ) {}

  private async sites(tx: Tx, user: UserPrincipal) {
    return (
      await tx.query(
        `SELECT s.id, s.name FROM sites s WHERE ($1::uuid[] IS NULL OR s.id = ANY($1::uuid[])) AND EXISTS (SELECT 1 FROM site_gates g WHERE g.site_id = s.id AND g.active) ORDER BY lower(s.name)`,
        [user.siteIds],
      )
    ).rows as { id: string; name: string }[];
  }

  private async site(tx: Tx, user: UserPrincipal, siteId: string) {
    assertSiteAccess(user, siteId);
    const s = (await tx.query('SELECT id, name FROM sites WHERE id = $1', [siteId])).rows[0];
    if (!s) throw new NotFoundException('Site not found.');
    return s as { id: string; name: string };
  }

  /** Every gate site at a glance: on site now, overstays, expected today, open exceptions and today's visits. */
  @Get('visitors/dashboard')
  @RequirePermission('visitors.view')
  dashboard(@CurrentUser() user: UserPrincipal) {
    return this.db.withTenant(user.companyId, async (tx) => {
      const now = new Date();
      const sites = await this.sites(tx, user);
      const today = (
        await tx.query(
          `SELECT v.site_id, count(*)::int AS visits, count(*) FILTER (WHERE ${LET_IN})::int AS "letIn", count(*) FILTER (WHERE ${TURNED_AWAY})::int AS "turnedAway",
                  count(*) FILTER (WHERE v.status = 'awaiting_approval')::int AS waiting, count(*) FILTER (WHERE v.captured_offline)::int AS "noSignal"
             FROM visits v WHERE ${LOCAL_DAY} = to_char(now() AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') GROUP BY v.site_id`,
        )
      ).rows;
      const exceptions = (await tx.query(`SELECT site_id, count(*)::int AS n FROM visit_exceptions WHERE cleared_at IS NULL GROUP BY site_id`)).rows;
      const calls = (await tx.query(`SELECT site_id, id, started_at FROM roll_calls WHERE closed_at IS NULL`)).rows;
      const rows: SiteRow[] = [];
      for (const s of sites) {
        const counts = await this.onSite.counts(tx, s.id, now);
        const t = today.find((r) => r.site_id === s.id);
        const call = calls.find((r) => r.site_id === s.id);
        rows.push({
          siteId: s.id,
          site: s.name,
          ...counts,
          expected: (await this.passes.expectedToday(tx, s.id)).length,
          openExceptions: exceptions.find((r) => r.site_id === s.id)?.n ?? 0,
          today: { visits: t?.visits ?? 0, letIn: t?.letIn ?? 0, turnedAway: t?.turnedAway ?? 0, waiting: t?.waiting ?? 0, noSignal: t?.noSignal ?? 0 },
          rollCall: call ? { id: call.id, startedAt: call.started_at } : null,
        });
      }
      const sum = (f: (r: SiteRow) => number) => rows.reduce((n, r) => n + f(r), 0);
      return {
        sites: rows,
        totals: { onSite: sum((r) => r.onSite), overstays: sum((r) => r.overstays), needAction: sum((r) => r.needAction), expected: sum((r) => r.expected), openExceptions: sum((r) => r.openExceptions), visits: sum((r) => r.today.visits) },
      };
    });
  }

  private range(from?: string, to?: string) {
    const today = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
    const t = to && DAY.test(to) ? to : today;
    const f = from && DAY.test(from) ? from : new Date(Date.parse(`${t}T12:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
    if (f > t) throw new BadRequestException('The first day must be before the last.');
    if ((Date.parse(t) - Date.parse(f)) / 86_400_000 >= MAX_DAYS) throw new BadRequestException('Choose a period of a year or less.');
    return { from: f, to: t };
  }

  private where(user: UserPrincipal, siteId: string | undefined) {
    if (siteId) assertSiteAccess(user, siteId);
    return { sql: `${LOCAL_DAY} BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR v.site_id = $3::uuid) AND ($4::uuid[] IS NULL OR v.site_id = ANY($4::uuid[]))`, site: siteId ?? null };
  }

  /** Visits counted by day, site, gate, unit, kind of visitor, guard or outcome. */
  @Get('visitors/report')
  @RequirePermission('visitors.view')
  report(@CurrentUser() user: UserPrincipal, @Query('from') from?: string, @Query('to') to?: string, @Query('siteId') siteId?: string, @Query('by') by?: string) {
    const r = this.range(from, to);
    const group: ReportBy = (REPORT_BY as readonly string[]).includes(by ?? '') ? (by as ReportBy) : 'day';
    if (siteId && !/^[0-9a-f-]{36}$/.test(siteId)) throw new BadRequestException('Unknown site.');
    const w = this.where(user, siteId);
    return this.db.withTenant(user.companyId, async (tx) => {
      const rows = (
        await tx.query(
          `SELECT ${GROUP[group]} AS key, count(*)::int AS visits, count(*) FILTER (WHERE ${LET_IN})::int AS "letIn", count(*) FILTER (WHERE ${TURNED_AWAY})::int AS "turnedAway",
                  count(*) FILTER (WHERE v.announced)::int AS expected, count(*) FILTER (WHERE v.captured_offline)::int AS "noSignal",
                  coalesce(sum(v.pax_in), 0)::int AS passengers, count(DISTINCT x.visit_id)::int AS exceptions
             FROM visits v JOIN sites s ON s.id = v.site_id JOIN site_gates g ON g.id = v.gate_id LEFT JOIN site_units u ON u.id = v.unit_id
             JOIN visitor_categories c ON c.id = v.category_id JOIN employees e ON e.id = v.entry_guard
             LEFT JOIN visit_exceptions x ON x.visit_id = v.id
            WHERE ${w.sql}
            GROUP BY 1 ORDER BY 1`,
          [r.from, r.to, w.site, user.siteIds],
        )
      ).rows.map((x) => ({ ...x, label: group === 'status' ? VISIT_STATUS_LABELS[x.key as VisitStatus] : x.key }));
      const total = rows.reduce(
        (t, x) => ({ visits: t.visits + x.visits, letIn: t.letIn + x.letIn, turnedAway: t.turnedAway + x.turnedAway, expected: t.expected + x.expected, noSignal: t.noSignal + x.noSignal, passengers: t.passengers + x.passengers, exceptions: t.exceptions + x.exceptions }),
        { visits: 0, letIn: 0, turnedAway: 0, expected: 0, noSignal: 0, passengers: 0, exceptions: 0 },
      );
      return { ...r, by: group, rows, total };
    });
  }

  /** Every visit in the period as a spreadsheet. ID numbers show their last four characters only. Each download is recorded. */
  @Get('visitors/report.csv')
  @RequirePermission('visitors.view')
  async reportFile(@CurrentUser() user: UserPrincipal, @Res() res: Response, @Query('from') from?: string, @Query('to') to?: string, @Query('siteId') siteId?: string) {
    const r = this.range(from, to);
    if (siteId && !/^[0-9a-f-]{36}$/.test(siteId)) throw new BadRequestException('Unknown site.');
    const w = this.where(user, siteId);
    const rows = await this.db.withTenant(user.companyId, async (tx) => {
      const list = (
        await tx.query(
          `SELECT ${LOCAL_DAY} AS day, to_char(v.captured_at AT TIME ZONE 'Africa/Johannesburg', 'HH24:MI') AS time, s.name AS site, g.name AS gate, p.surname, p.names, p.id_number,
                  ve.registration, ve.colour, ve.make, ve.model, v.pax_in, coalesce('Unit ' || u.name, 'The office') AS visiting, c.name AS category, v.status, v.announced, v.captured_offline,
                  e.full_name AS guard, to_char(v.exit_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD HH24:MI') AS left_at, v.pax_out,
                  (SELECT a.method FROM visit_approvals a WHERE a.visit_id = v.id AND a.outcome <> 'no_answer' ORDER BY a.at DESC LIMIT 1) AS how,
                  (SELECT count(*)::int FROM visit_exceptions x WHERE x.visit_id = v.id) AS exceptions
             FROM visits v JOIN sites s ON s.id = v.site_id JOIN site_gates g ON g.id = v.gate_id JOIN visitor_people p ON p.id = v.person_id LEFT JOIN visitor_vehicles ve ON ve.id = v.vehicle_id
             LEFT JOIN site_units u ON u.id = v.unit_id JOIN visitor_categories c ON c.id = v.category_id JOIN employees e ON e.id = v.entry_guard
            WHERE ${w.sql} ORDER BY v.captured_at LIMIT 50000`,
          [r.from, r.to, w.site, user.siteIds],
        )
      ).rows;
      await this.audit.byUser(tx, user, { action: 'visitors.report_download', entityType: 'company', entityId: user.companyId, after: { ...r, siteId: w.site, rows: list.length } });
      return list;
    });
    const how = (m: string | null, announced: boolean) => (announced ? 'Expected' : m === 'push' ? 'In the app' : m === 'phone' ? 'By phone' : m === 'pass' ? 'Expected' : '');
    const lines = [
      ['Date', 'Time', 'Site', 'Gate', 'Visitor', 'ID (last 4)', 'Vehicle', 'Passengers in', 'Visiting', 'Kind', 'Outcome', 'How decided', 'No signal', 'Guard', 'Left', 'Passengers out', 'Exceptions'].join(','),
      ...rows.map((x) =>
        [
          x.day,
          x.time,
          x.site,
          x.gate,
          visitorName(x.surname, x.names),
          maskIdNumber(x.id_number),
          x.registration ? vehicleLine({ registration: x.registration, colour: x.colour, make: x.make, model: x.model }) : 'On foot',
          x.pax_in,
          x.visiting,
          x.category,
          VISIT_STATUS_LABELS[x.status as VisitStatus],
          how(x.how, x.announced),
          x.captured_offline ? 'Yes' : '',
          x.guard,
          x.left_at,
          x.pax_out,
          x.exceptions,
        ]
          .map(cell)
          .join(','),
      ),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="visitors-${r.from}-to-${r.to}.csv"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send('﻿' + lines.join('\r\n') + '\r\n');
  }

  // --- Photos for the supervisor ---------------------------------------------------------------

  /** The photo a guard took with an exception. Each look is recorded. */
  @Get('sites/:siteId/visit-exceptions/:id/photo')
  @RequirePermission('visitors.view')
  async exceptionPhoto(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const photo = await this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      const r = (await tx.query(`SELECT photo_key AS key, photo_type AS type FROM visit_exceptions WHERE id = $1 AND site_id = $2`, [id, siteId])).rows[0];
      if (!r?.key) throw new NotFoundException('There is no photo with this exception.');
      await this.retention.assertNotRemoved(tx, r.key);
      await this.audit.byUser(tx, user, { action: 'visit.exception_photo_view', entityType: 'visit_exception', entityId: id });
      return r as { key: string; type: string };
    });
    res.setHeader('Content-Type', photo.type ?? 'image/jpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(photo.key));
  }

  /** The face photo of a visitor on foot, as taken at the gate. Each look is recorded. */
  @Get('sites/:siteId/visits/:id/face')
  @RequirePermission('visitors.view')
  async face(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const photo = await this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      const r = (await tx.query(`SELECT face_photo_key AS key, face_photo_type AS type FROM visits WHERE id = $1 AND site_id = $2`, [id, siteId])).rows[0];
      if (!r?.key) throw new NotFoundException('There is no photo for this visitor.');
      await this.retention.assertNotRemoved(tx, r.key);
      await this.audit.byUser(tx, user, { action: 'visit.face_view', entityType: 'visit', entityId: id });
      return r as { key: string; type: string };
    });
    res.setHeader('Content-Type', photo.type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(await this.storage.get(photo.key));
  }

  // --- Emergency roll-call ---------------------------------------------------------------------

  /** Everyone on site since the roll-call started: visitors (with their passengers) and the guards on duty. */
  private async people(tx: Tx, call: { id: string; site_id: string; started_at: Date; closed_at: Date | null }) {
    const until = call.closed_at ?? new Date();
    const visits = (
      await tx.query(
        `SELECT v.id, v.type, p.surname, p.names, ve.registration, ve.colour, ve.make, ve.model, v.pax_in AS pax, coalesce('Unit ' || u.name, 'The office') AS visiting,
                c.name AS category, st.full_name AS "staffName", v.exit_at AS "leftAt", coalesce(v.entry_at, v.captured_at) AS "enteredAt"
           FROM visits v JOIN visitor_people p ON p.id = v.person_id LEFT JOIN visitor_vehicles ve ON ve.id = v.vehicle_id LEFT JOIN site_units u ON u.id = v.unit_id
           JOIN visitor_categories c ON c.id = v.category_id LEFT JOIN unit_staff st ON st.id = v.staff_id
          WHERE v.site_id = $1 AND coalesce(v.entry_at, v.captured_at) <= $3
            AND (v.status = 'on_site' OR (v.exit_at IS NOT NULL AND v.exit_at > $2))
          ORDER BY coalesce('Unit ' || u.name, 'The office'), p.surname`,
        [call.site_id, call.started_at, until],
      )
    ).rows;
    const guards = (
      await tx.query(
        `SELECT a.employee_id AS id, e.full_name AS name, a.shift_name AS shift, a.duty_from_at AS "leftAt"
           FROM attendance a JOIN employees e ON e.id = a.employee_id
          WHERE a.site_id = $1 AND a.duty_on_at <= $3 AND (a.duty_from_at IS NULL OR a.duty_from_at > $2)
          ORDER BY e.full_name`,
        [call.site_id, call.started_at, until],
      )
    ).rows;
    const marks = (
      await tx.query(
        `SELECT DISTINCT ON (m.person_key) m.person_key, m.status, m.marked_at, u.full_name AS by
           FROM roll_call_marks m JOIN users u ON u.id = m.marked_by WHERE m.roll_call_id = $1 ORDER BY m.person_key, m.marked_at DESC, m.id DESC`,
        [call.id],
      )
    ).rows;
    const mark = (key: string) => {
      const m = marks.find((x) => x.person_key === key);
      return m && m.status !== 'clear' ? { status: m.status as 'safe' | 'missing', markedBy: m.by as string, markedAt: m.marked_at as Date } : { status: null, markedBy: null, markedAt: null };
    };
    return [
      ...visits.map((v) => ({
        key: `visit:${v.id}`,
        kind: v.staffName ? ('staff' as const) : ('visitor' as const),
        name: v.staffName ?? visitorName(v.surname, v.names),
        detail: [v.registration ? vehicleLine({ registration: v.registration, colour: v.colour, make: v.make, model: v.model }) : 'On foot', `to see ${v.visiting === 'The office' ? 'the office' : v.visiting}`, v.category].join(' · '),
        // The driver and his passengers are ticked as one group.
        headcount: 1 + (v.type === 'vehicle' ? (v.pax ?? 0) : 0),
        leftAt: v.leftAt as Date | null,
        ...mark(`visit:${v.id}`),
      })),
      ...guards.map((g) => ({
        key: `guard:${g.id}`,
        kind: 'guard' as const,
        name: g.name as string,
        detail: `Guard on duty${g.shift ? ` · ${g.shift}` : ''}`,
        headcount: 1,
        leftAt: g.leftAt as Date | null,
        ...mark(`guard:${g.id}`),
      })),
    ];
  }

  private async view(tx: Tx, call: Record<string, any>) {
    const people = await this.people(tx, call as { id: string; site_id: string; started_at: Date; closed_at: Date | null });
    const heads = (f: (p: (typeof people)[number]) => boolean) => people.filter(f).reduce((n, p) => n + p.headcount, 0);
    return {
      id: call.id as string,
      reason: call.reason as string,
      startedAt: call.started_at as Date,
      startedBy: call.started_by_name as string,
      closedAt: (call.closed_at ?? null) as Date | null,
      closedBy: (call.closed_by_name ?? null) as string | null,
      closeNote: call.close_note as string,
      people,
      counts: {
        people: heads(() => true),
        safe: heads((p) => p.status === 'safe'),
        missing: heads((p) => p.status === 'missing'),
        // Scanned out or off duty since it started, and not ticked: they have left the site.
        left: heads((p) => p.status === null && p.leftAt !== null),
        waiting: heads((p) => p.status === null && p.leftAt === null),
      },
    };
  }

  private async load(tx: Tx, where: string, params: unknown[]) {
    return (
      await tx.query(
        `SELECT r.*, a.full_name AS started_by_name, b.full_name AS closed_by_name FROM roll_calls r JOIN users a ON a.id = r.started_by LEFT JOIN users b ON b.id = r.closed_by WHERE ${where}`,
        params,
      )
    ).rows;
  }

  /** The roll-call going on at the site, if any, and the last ones. */
  @Get('sites/:siteId/roll-calls')
  @RequirePermission('visitors.view')
  rollCalls(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string) {
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      const open = (await this.load(tx, 'r.site_id = $1 AND r.closed_at IS NULL', [siteId]))[0];
      const past = await this.load(tx, 'r.site_id = $1 AND r.closed_at IS NOT NULL ORDER BY r.started_at DESC LIMIT 10', [siteId]);
      return {
        current: open ? await this.view(tx, open) : null,
        past: await Promise.all(past.map(async (p) => {
          const v = await this.view(tx, p);
          return { id: v.id, reason: v.reason, startedAt: v.startedAt, startedBy: v.startedBy, closedAt: v.closedAt, closedBy: v.closedBy, closeNote: v.closeNote, counts: v.counts };
        })),
      };
    });
  }

  /** Starts an emergency roll-call. The site's supervisors and managers are alerted at once. */
  @Post('sites/:siteId/roll-calls')
  @RequirePermission('visitors.exceptions')
  start(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Body() body: unknown) {
    const b = parseBody(StartBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      const site = await this.site(tx, user, siteId);
      if ((await this.load(tx, 'r.site_id = $1 AND r.closed_at IS NULL', [siteId])).length) throw new ConflictException('A roll-call is already going on at this site.');
      const id = (await tx.query(`INSERT INTO roll_calls (company_id, site_id, reason, started_by) VALUES (app_company_id(), $1, $2, $3) RETURNING id`, [siteId, b.reason, user.userId])).rows[0].id as string;
      await this.audit.byUser(tx, user, { action: 'roll_call.start', entityType: 'roll_call', entityId: id, after: { siteId, reason: b.reason } });
      await this.notifications.recordForSite(tx, siteId, {
        kind: 'roll_call',
        title: `Emergency roll-call at ${site.name}`,
        body: `${user.name} started a roll-call${b.reason ? `: ${b.reason}` : ''}. Open the list and tick everyone off at the assembly point.`,
        lockScreen: 'An emergency roll-call has started at one of your sites.',
        url: `/sites/${siteId}/roll-call`,
        entityType: 'roll_call',
        entityId: id,
      });
      return this.view(tx, (await this.load(tx, 'r.id = $1', [id]))[0]);
    });
  }

  /** Ticks a person (or a vehicle with its passengers) safe or missing, or takes the tick back. Every tick is kept. */
  @Post('sites/:siteId/roll-calls/:id/mark')
  @HttpCode(200)
  @RequirePermission('visitors.exceptions')
  mark(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(MarkBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      const call = (await this.load(tx, 'r.id = $1 AND r.site_id = $2 FOR UPDATE OF r', [id, siteId]))[0];
      if (!call) throw new NotFoundException('Roll-call not found.');
      if (call.closed_at) throw new ConflictException('This roll-call has been closed.');
      const people = await this.people(tx, call);
      if (!people.some((p) => p.key === b.personKey)) throw new NotFoundException('That person is not on this roll-call.');
      await tx.query(`INSERT INTO roll_call_marks (company_id, roll_call_id, person_key, status, marked_by) VALUES (app_company_id(), $1, $2, $3, $4)`, [id, b.personKey, b.status, user.userId]);
      return this.view(tx, call);
    });
  }

  /** Closes the roll-call. Anyone still not ticked is listed in the note kept with it. */
  @Post('sites/:siteId/roll-calls/:id/close')
  @HttpCode(200)
  @RequirePermission('visitors.exceptions')
  close(@CurrentUser() user: UserPrincipal, @Param('siteId', ParseUUIDPipe) siteId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parseBody(CloseBody, body);
    return this.db.withTenant(user.companyId, async (tx) => {
      await this.site(tx, user, siteId);
      const call = (await this.load(tx, 'r.id = $1 AND r.site_id = $2 FOR UPDATE OF r', [id, siteId]))[0];
      if (!call) throw new NotFoundException('Roll-call not found.');
      if (call.closed_at) throw new ConflictException('This roll-call has already been closed.');
      const before = await this.view(tx, call);
      if ((before.counts.waiting > 0 || before.counts.missing > 0) && b.note.length < 3) {
        throw new BadRequestException({ message: 'Not everyone is ticked safe. Say what happened before you close the roll-call.', errors: { note: 'Say what happened.' } });
      }
      await tx.query(`UPDATE roll_calls SET closed_at = now(), closed_by = $2, close_note = $3 WHERE id = $1`, [id, user.userId, b.note]);
      await this.audit.byUser(tx, user, { action: 'roll_call.close', entityType: 'roll_call', entityId: id, after: { counts: before.counts, note: b.note } });
      return this.view(tx, (await this.load(tx, 'r.id = $1', [id]))[0]);
    });
  }
}
