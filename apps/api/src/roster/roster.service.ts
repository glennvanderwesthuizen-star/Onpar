import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  addDays,
  coverStatus,
  currentQualifications,
  dateRange,
  describePattern,
  EARLY_ARRIVAL_WINDOW_MINUTES,
  guardsRequiredOn,
  holidaysBetween,
  resolveRosterDay,
  rosterClashes,
  RosterAllocation,
  RosterChange,
  RosterDay,
  RosterShift,
  sastDate,
  shiftWindow,
  siteFitWarnings,
  PsiraGrade,
} from '@onpar/rules';
import { assertSiteAccess, UserPrincipal } from '../common/auth';
import { Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';

export interface AllocateInput {
  employeeId: string;
  siteId: string;
  patternId: string;
  startDate: string;
  position: number;
  dayShiftId?: string | null;
  nightShiftId?: string | null;
  reason?: string;
}

export interface ChangeInput {
  employeeId: string;
  date?: string | null;
  weekday?: number | null;
  fromDate?: string | null;
  untilDate?: string | null;
  shiftId: string | null;
  note?: string;
}

/** A shift a guard is rostered on, with its real start and end. */
export interface RosteredShift {
  siteId: string;
  shiftId: string;
  shiftName: string;
  shiftDate: string;
  scheduledStart: Date;
  scheduledEnd: Date;
}

export type DutyRosterMatch =
  | { status: 'rostered'; shift: RosteredShift }
  | { status: 'not_rostered_here' }
  | { status: 'no_roster' };

/** How far ahead an allocation or weekly change is checked for rest clashes. */
const CHECK_AHEAD_DAYS = 182;

/**
 * Shared rostering operations (sections 31 and 38). Every path that allocates a
 * guard goes through `allocate`, which ends any other allocation first, so a
 * person only ever has one.
 */
@Injectable()
export class RosterService {
  constructor(private readonly audit: AuditService) {}

  // ---------------------------------------------------------------------------
  // Loading

  async shifts(tx: Tx): Promise<RosterShift[]> {
    return (
      await tx.query(
        `SELECT id, site_id AS "siteId", name, kind, to_char(start_time, 'HH24:MI') AS "startTime",
                to_char(end_time, 'HH24:MI') AS "endTime", sort_order AS "sortOrder"
           FROM site_shifts`,
      )
    ).rows;
  }

  async allocations(tx: Tx, employeeIds: string[]): Promise<Map<string, RosterAllocation[]>> {
    const rows = (
      await tx.query(
        `SELECT a.id, a.employee_id, a.site_id AS "siteId", p.sequence, a.start_date AS "startDate",
                a.end_date AS "endDate", a.position, a.day_shift_id AS "dayShiftId", a.night_shift_id AS "nightShiftId"
           FROM roster_allocations a JOIN shift_patterns p ON p.id = a.pattern_id
          WHERE a.employee_id = ANY($1::uuid[]) ORDER BY a.created_at`,
        [employeeIds],
      )
    ).rows;
    return group<RosterAllocation>(employeeIds, rows);
  }

  async changes(tx: Tx, employeeIds: string[], from: string, to: string): Promise<Map<string, RosterChange[]>> {
    const rows = (
      await tx.query(
        `SELECT id, employee_id, date, weekday, from_date AS "fromDate", until_date AS "untilDate", shift_id AS "shiftId", note
           FROM roster_changes
          WHERE employee_id = ANY($1::uuid[])
            AND ((date BETWEEN $2 AND $3) OR (date IS NULL AND from_date <= $3 AND (until_date IS NULL OR until_date >= $2)))`,
        [employeeIds, from, to],
      )
    ).rows;
    return group<RosterChange>(employeeIds, rows);
  }

  /** Each guard's roster for every date from `from` to `to`. */
  async days(tx: Tx, employeeIds: string[], from: string, to: string, shifts?: RosterShift[]): Promise<Map<string, RosterDay[]>> {
    const all = shifts ?? (await this.shifts(tx));
    const allocs = await this.allocations(tx, employeeIds);
    const changes = await this.changes(tx, employeeIds, from, to);
    const dates = dateRange(from, to);
    return new Map(employeeIds.map((id) => [id, dates.map((d) => resolveRosterDay(d, allocs.get(id)!, changes.get(id)!, all))]));
  }

  // ---------------------------------------------------------------------------
  // Allocation (sections 31, 38, 39)

  /** What staffing a site with this person would mean: grade and firearm warnings, and any move off another site. */
  async allocationCheck(tx: Tx, employeeId: string, siteId: string) {
    const e = await this.employee(tx, employeeId);
    const site = (await tx.query('SELECT id, name, minimum_grade, armed FROM sites WHERE id = $1', [siteId])).rows[0];
    if (!site) throw new NotFoundException('Site not found.');
    const quals = currentQualifications(
      (await tx.query(`SELECT id, type, name, expiry_date AS "expiryDate" FROM qualifications WHERE employee_id = $1`, [employeeId])).rows,
    );
    const warnings = siteFitWarnings(
      { psiraGrade: e.psira_grade as PsiraGrade, qualifications: quals.map((q) => ({ type: q.type, expiryDate: q.expiryDate })) },
      { name: site.name, minimumGrade: site.minimum_grade, armed: site.armed },
      sastDate(new Date()),
    );
    const current = (
      await tx.query(
        `SELECT a.id, s.id AS "siteId", s.name AS "siteName" FROM roster_allocations a JOIN sites s ON s.id = a.site_id
          WHERE a.employee_id = $1 AND a.end_date IS NULL`,
        [employeeId],
      )
    ).rows;
    const elsewhere = current.filter((c) => c.siteId !== siteId);
    if (elsewhere.length) {
      warnings.unshift(
        `Currently rostered at ${elsewhere.map((c) => c.siteName).join(' and ')}. Allocating here will move them off that roster.`,
      );
    }
    return { employee: { id: e.id, name: e.full_name }, warnings, current };
  }

  /**
   * The one allocate operation (section 38): ends any existing allocation for
   * the person, at any site, then adds the new one. Clash-checked before commit.
   */
  async allocate(tx: Tx, user: UserPrincipal, input: AllocateInput) {
    assertSiteAccess(user, input.siteId);
    // Lock the person so two allocations at once cannot both pass the check.
    const e = await this.employee(tx, input.employeeId, true);
    const pattern = (await tx.query('SELECT id, name, number, sequence, active FROM shift_patterns WHERE id = $1', [input.patternId])).rows[0];
    if (!pattern) throw new NotFoundException('Pattern not found.');
    if (!pattern.active) throw new ConflictException('This pattern is no longer in use. Choose another.');
    if (input.position < 1 || input.position > pattern.sequence.length) {
      throw new ConflictException(`The position must be between 1 and ${pattern.sequence.length} for this pattern.`);
    }
    for (const [id, kind] of [[input.dayShiftId, 'day'], [input.nightShiftId, 'night']] as const) {
      if (!id) continue;
      const sh = (await tx.query('SELECT site_id, kind FROM site_shifts WHERE id = $1', [id])).rows[0];
      if (!sh || sh.site_id !== input.siteId || sh.kind !== kind) throw new ConflictException(`Choose a ${kind} shift at this site.`);
    }
    const check = await this.allocationCheck(tx, input.employeeId, input.siteId);
    for (const c of check.current) {
      if (user.siteIds && !user.siteIds.includes(c.siteId)) {
        throw new ForbiddenException(`${e.full_name} is rostered at ${c.siteName}, which is not one of your sites. Ask a manager to move them.`);
      }
    }
    const ended = (
      await tx.query(
        // Earlier allocations stop where the new one starts, so no two ever cover the same date.
        `UPDATE roster_allocations SET end_date = GREATEST(start_date, $2::date), ended_by = coalesce(ended_by, $3), ended_at = coalesce(ended_at, now())
          WHERE employee_id = $1 AND (end_date IS NULL OR end_date > $2::date) RETURNING id, site_id, start_date, end_date`,
        [input.employeeId, input.startDate, user.userId],
      )
    ).rows;
    const id = (
      await tx.query(
        `INSERT INTO roster_allocations (company_id, employee_id, site_id, pattern_id, start_date, position, exception_reason, created_by,
                                         day_shift_id, night_shift_id)
         VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [input.employeeId, input.siteId, input.patternId, input.startDate, input.position, input.reason?.trim() || null, user.userId,
          input.dayShiftId ?? null, input.nightShiftId ?? null],
      )
    ).rows[0].id;
    await this.assertRested(tx, input.employeeId, addDays(input.startDate, -1), addDays(input.startDate, Math.max(CHECK_AHEAD_DAYS, 2 * pattern.sequence.length)));
    const after = {
      officer: e.full_name,
      siteId: input.siteId,
      pattern: `${String(pattern.number).padStart(2, '0')} ${pattern.name}`,
      startDate: input.startDate,
      position: input.position,
      warnings: check.warnings,
    };
    await this.audit.byUser(tx, user, {
      action: 'roster.allocate',
      entityType: 'roster_allocation',
      entityId: id,
      before: ended.length ? { ended } : undefined,
      after,
      reason: input.reason?.trim() || null,
    });
    return { id, warnings: check.warnings };
  }

  /** Takes a guard off the roster from a date. */
  async endAllocation(tx: Tx, user: UserPrincipal, allocationId: string, endDate: string) {
    const a = (await tx.query('SELECT id, site_id, start_date, end_date FROM roster_allocations WHERE id = $1 FOR UPDATE', [allocationId])).rows[0];
    if (!a) throw new NotFoundException('Allocation not found.');
    assertSiteAccess(user, a.site_id);
    if (a.end_date) throw new ConflictException('This allocation has already ended.');
    await tx.query('UPDATE roster_allocations SET end_date = GREATEST(start_date, $2::date), ended_by = $3, ended_at = now() WHERE id = $1', [
      allocationId,
      endDate,
      user.userId,
    ]);
    await this.audit.byUser(tx, user, { action: 'roster.end_allocation', entityType: 'roster_allocation', entityId: allocationId, after: { endDate } });
  }

  // ---------------------------------------------------------------------------
  // Day changes (D-25)

  async addChange(tx: Tx, user: UserPrincipal, input: ChangeInput) {
    const e = await this.employee(tx, input.employeeId, true);
    const once = !!input.date;
    const firstDate = once ? input.date! : input.fromDate!;
    await this.assertChangeScope(tx, user, input.employeeId, input.shiftId, firstDate);
    if (once) {
      // Replacing a one-off change for the same date is allowed; the old one is kept in the audit log.
      const old = (await tx.query('DELETE FROM roster_changes WHERE employee_id = $1 AND date = $2 RETURNING *', [input.employeeId, input.date])).rows[0];
      if (old) await this.audit.byUser(tx, user, { action: 'roster.change_replaced', entityType: 'roster_change', entityId: old.id, before: old });
    } else {
      const overlap = await tx.query(
        `SELECT 1 FROM roster_changes WHERE employee_id = $1 AND weekday = $2
            AND from_date <= coalesce($4::date, 'infinity') AND coalesce(until_date, 'infinity') >= $3::date`,
        [input.employeeId, input.weekday, input.fromDate, input.untilDate ?? null],
      );
      if (overlap.rowCount) throw new ConflictException('There is already a weekly change on that day of the week for these dates. Remove it first.');
    }
    const id = (
      await tx.query(
        `INSERT INTO roster_changes (company_id, employee_id, date, weekday, from_date, until_date, shift_id, note, created_by)
         VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          input.employeeId,
          once ? input.date : null,
          once ? null : input.weekday,
          once ? null : input.fromDate,
          once ? null : (input.untilDate ?? null),
          input.shiftId,
          input.note?.trim() ?? '',
          user.userId,
        ],
      )
    ).rows[0].id;
    const to = once ? addDays(input.date!, 1) : input.untilDate ? addDays(input.untilDate, 1) : addDays(input.fromDate!, CHECK_AHEAD_DAYS);
    await this.assertRested(tx, input.employeeId, addDays(firstDate, -1), to);
    const shift = input.shiftId
      ? (await tx.query('SELECT s.name AS site, sh.name AS shift FROM site_shifts sh JOIN sites s ON s.id = sh.site_id WHERE sh.id = $1', [input.shiftId])).rows[0]
      : null;
    await this.audit.byUser(tx, user, {
      action: 'roster.change',
      entityType: 'roster_change',
      entityId: id,
      after: { officer: e.full_name, ...input, worked: shift ? `${shift.shift} at ${shift.site}` : 'Day off' },
      reason: input.note?.trim() || null,
    });
    return { id };
  }

  async removeChange(tx: Tx, user: UserPrincipal, id: string) {
    const c = (await tx.query('SELECT * FROM roster_changes WHERE id = $1', [id])).rows[0];
    if (!c) throw new NotFoundException('Change not found.');
    await this.employee(tx, c.employee_id, true);
    await this.assertChangeScope(tx, user, c.employee_id, c.shift_id, c.date ?? c.from_date);
    await tx.query('DELETE FROM roster_changes WHERE id = $1', [id]);
    const from = c.date ?? c.from_date;
    const to = c.date ? addDays(c.date, 1) : c.until_date ? addDays(c.until_date, 1) : addDays(c.from_date, CHECK_AHEAD_DAYS);
    // Going back to the pattern can itself put a night next to a changed day.
    await this.assertRested(tx, c.employee_id, addDays(from, -1), to);
    await this.audit.byUser(tx, user, { action: 'roster.change_removed', entityType: 'roster_change', entityId: id, before: c });
  }

  /** A site-scoped user may only move people into their own sites, or give a day off at one. */
  private async assertChangeScope(tx: Tx, user: UserPrincipal, employeeId: string, shiftId: string | null, date: string) {
    if (shiftId) {
      const s = (await tx.query('SELECT site_id FROM site_shifts WHERE id = $1', [shiftId])).rows[0];
      if (!s) throw new NotFoundException('Shift not found.');
      assertSiteAccess(user, s.site_id);
    }
    if (!user.siteIds) return;
    if (!shiftId) {
      const [day] = (await this.days(tx, [employeeId], date, date)).get(employeeId)!;
      const e = await this.employee(tx, employeeId);
      const site = day.siteId ?? e.home_site_id;
      if (!user.siteIds.includes(site)) throw new ForbiddenException('This officer is not rostered at one of your sites.');
    }
  }

  /** Rolls the change back (the caller's transaction fails) if it breaks a rest rule. */
  private async assertRested(tx: Tx, employeeId: string, from: string, to: string) {
    const days = (await this.days(tx, [employeeId], from, to)).get(employeeId)!;
    const clashes = rosterClashes(days);
    if (clashes.length) {
      throw new ConflictException({ message: `This would break the rest rule. ${clashes[0].message}`, clashes });
    }
  }

  private async employee(tx: Tx, id: string, lock = false) {
    const e = (
      await tx.query(`SELECT id, full_name, psira_grade, home_site_id, status FROM employees WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id])
    ).rows[0];
    if (!e) throw new NotFoundException('Officer not found.');
    if (e.status !== 'active') throw new ConflictException(`${e.full_name} is not active.`);
    return e;
  }

  // ---------------------------------------------------------------------------
  // Clash detection, the second safety net (section 38)

  /** People with more than one active allocation. Should never happen; surfaced if it ever does. */
  async allocationClashes(tx: Tx, employeeIds: string[] | null = null) {
    return (
      await tx.query(
        `SELECT e.id AS "employeeId", e.full_name AS "employeeName", array_agg(s.name ORDER BY s.name) AS "siteNames",
                array_agg(s.id ORDER BY s.name) AS "siteIds"
           FROM roster_allocations a JOIN employees e ON e.id = a.employee_id JOIN sites s ON s.id = a.site_id
          WHERE a.end_date IS NULL AND ($1::uuid[] IS NULL OR a.employee_id = ANY($1::uuid[]))
          GROUP BY e.id, e.full_name HAVING count(*) > 1`,
        [employeeIds],
      )
    ).rows.map((r) => ({
      ...r,
      message: `${r.employeeName} is allocated to more than one site at once: ${r.siteNames.join(' and ')}. Allocate them again to keep only one.`,
    }));
  }

  // ---------------------------------------------------------------------------
  // The site table (section 31)

  async siteWeek(tx: Tx, user: UserPrincipal, siteId: string, from: string, days = 7) {
    assertSiteAccess(user, siteId);
    const to = addDays(from, days - 1);
    const dates = dateRange(from, to);
    const site = (
      await tx.query('SELECT id, name, client, address, minimum_grade AS "minimumGrade", armed, payroll_start_day AS "payrollStartDay" FROM sites WHERE id = $1', [siteId])
    ).rows[0];
    if (!site) throw new NotFoundException('Site not found.');
    const all = await this.shifts(tx);
    const siteShifts = (
      await tx.query(
        `SELECT id, name, kind, to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime",
                guards_required AS "guardsRequired", guards_by_day AS "guardsByDay"
           FROM site_shifts WHERE site_id = $1 ORDER BY sort_order`,
        [siteId],
      )
    ).rows;
    const reqChanges = (
      await tx.query(
        `SELECT shift_id AS "shiftId", date, guards, note FROM site_requirement_changes
          WHERE shift_id = ANY($1::uuid[]) AND date BETWEEN $2 AND $3`,
        [siteShifts.map((s) => s.id), from, to],
      )
    ).rows;
    const holidays = await this.holidays(tx, from, to);

    // Everyone allocated here during the period, or moved here for a day of it.
    const ids = (
      await tx.query(
        `SELECT employee_id FROM roster_allocations WHERE site_id = $1 AND start_date <= $3 AND (end_date IS NULL OR end_date > $2)
         UNION
         SELECT c.employee_id FROM roster_changes c JOIN site_shifts sh ON sh.id = c.shift_id
          WHERE sh.site_id = $1 AND ((c.date BETWEEN $2 AND $3) OR (c.date IS NULL AND c.from_date <= $3 AND (c.until_date IS NULL OR c.until_date >= $2)))`,
        [siteId, from, to],
      )
    ).rows.map((r) => r.employee_id);
    const people = (
      await tx.query(
        `SELECT e.id, e.full_name AS name, e.employee_number AS "employeeNumber", e.psira_grade AS grade,
                e.home_site_id AS "homeSiteId", hs.name AS "homeSiteName"
           FROM employees e JOIN sites hs ON hs.id = e.home_site_id WHERE e.id = ANY($1::uuid[]) ORDER BY lower(e.full_name)`,
        [ids],
      )
    ).rows;
    const allocs = (
      await tx.query(
        `SELECT a.id, a.employee_id AS "employeeId", a.start_date AS "startDate", a.end_date AS "endDate", a.position,
                a.day_shift_id AS "dayShiftId", a.night_shift_id AS "nightShiftId", p.id AS "patternId", p.number AS "patternNumber", p.name AS "patternName", p.sequence
           FROM roster_allocations a JOIN shift_patterns p ON p.id = a.pattern_id
          WHERE a.site_id = $1 AND a.employee_id = ANY($2::uuid[]) AND a.start_date <= $4 AND (a.end_date IS NULL OR a.end_date > $3)
          ORDER BY a.start_date`,
        [siteId, ids, from, to],
      )
    ).rows;
    const siteNames = new Map((await tx.query('SELECT id, name FROM sites')).rows.map((s) => [s.id, s.name]));
    // One day either side, so rest clashes at the edges of the period show too.
    const computed = await this.days(tx, ids, addDays(from, -1), addDays(to, 1), all);

    const rows = people.map((p) => {
      const d = computed.get(p.id)!;
      const inPeriod = d.slice(1, -1);
      return {
        ...p,
        allocation: allocs.filter((a) => a.employeeId === p.id).map((a) => ({ ...a, pattern: describePattern(a.sequence) })).pop() ?? null,
        cells: inPeriod.map((c) => ({ ...c, siteName: c.siteId ? siteNames.get(c.siteId) : null, elsewhere: !!c.siteId && c.siteId !== siteId })),
        clashes: rosterClashes(d),
      };
    });

    const requirement = siteShifts.map((s) => ({
      shiftId: s.id,
      name: s.name,
      kind: s.kind,
      startTime: s.startTime,
      endTime: s.endTime,
      guardsRequired: s.guardsRequired,
      guardsByDay: s.guardsByDay,
      days: dates.map((date) => {
        const change = reqChanges.find((r) => r.shiftId === s.id && r.date === date);
        const required = guardsRequiredOn(s, date, holidays, change?.guards);
        const actual = rows.filter((r) => r.cells.some((c: { date: string; status: string; shiftId?: string }) => c.date === date && c.status === 'working' && c.shiftId === s.id)).length;
        return { date, required, actual, status: coverStatus(required, actual), changed: !!change, note: change?.note ?? '', holiday: holidays.has(date) };
      }),
    }));
    const unmapped = rows.some((r) => r.cells.some((c: { status: string; siteId: string | null }) => c.status === 'unmapped' && c.siteId === siteId));
    return {
      site,
      from,
      to,
      dates: dates.map((date) => ({ date, holiday: holidays.has(date) })),
      shifts: requirement,
      rows,
      clashes: await this.allocationClashes(tx, ids),
      warnings: unmapped ? ['Some pattern days have no matching Day or Night shift at this site. Add the shift, or change those guards’ pattern.'] : [],
    };
  }

  async holidays(tx: Tx, from: string, to: string): Promise<Set<string>> {
    const extra = (await tx.query('SELECT date FROM company_holidays WHERE date BETWEEN $1 AND $2', [from, to])).rows.map((r) => r.date);
    return holidaysBetween(from, to, extra);
  }

  // ---------------------------------------------------------------------------
  // The guard's own roster (section 40) and Duty On matching

  /** Today and the coming days for one guard, with site names. */
  async guardRoster(tx: Tx, employeeId: string, today: string, days = 14) {
    const list = (await this.days(tx, [employeeId], today, addDays(today, days - 1))).get(employeeId)!;
    const siteNames = new Map((await tx.query('SELECT id, name FROM sites')).rows.map((s) => [s.id, s.name]));
    const view = list.map((d) => ({
      date: d.date,
      status: d.status,
      siteName: d.siteId ? (siteNames.get(d.siteId) ?? null) : null,
      shiftName: d.status === 'working' ? d.shiftName : null,
      kind: d.status === 'working' || d.status === 'unmapped' ? d.kind : null,
      startTime: d.status === 'working' ? d.startTime : null,
      endTime: d.status === 'working' ? d.endTime : null,
    }));
    const rostered = view.some((d) => d.status !== 'not_rostered');
    return { rostered, today: view[0], comingUp: view.slice(1).filter((d) => d.status === 'working') };
  }

  /**
   * The rostered shift a Duty On at `siteId` belongs to: one the guard is
   * rostered on whose window (2 hours before its start until its end) contains
   * the time. `no_roster` when the guard has no roster around that date at all,
   * so the interim site-shift matching still applies.
   */
  async dutyMatch(tx: Tx, employeeId: string, siteId: string, at: Date): Promise<DutyRosterMatch> {
    const today = sastDate(at);
    const days = (await this.days(tx, [employeeId], addDays(today, -1), addDays(today, 1))).get(employeeId)!;
    if (days.every((d) => d.status === 'not_rostered')) return { status: 'no_roster' };
    let best: RosteredShift | null = null;
    for (const d of days) {
      if (d.status !== 'working') continue;
      const w = shiftWindow(d.date, d.startTime, d.endTime);
      if (at.getTime() < w.start.getTime() - EARLY_ARRIVAL_WINDOW_MINUTES * 60_000 || at.getTime() >= w.end.getTime()) continue;
      if (!best || Math.abs(w.start.getTime() - at.getTime()) < Math.abs(best.scheduledStart.getTime() - at.getTime())) {
        best = { siteId: d.siteId, shiftId: d.shiftId, shiftName: d.shiftName, shiftDate: d.date, scheduledStart: w.start, scheduledEnd: w.end };
      }
    }
    return best && best.siteId === siteId ? { status: 'rostered', shift: best } : { status: 'not_rostered_here' };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function group<T>(ids: string[], rows: any[]): Map<string, T[]> {
  const m = new Map<string, T[]>(ids.map((id) => [id, []]));
  for (const { employee_id, ...rest } of rows) m.get(employee_id)?.push(rest);
  return m;
}
