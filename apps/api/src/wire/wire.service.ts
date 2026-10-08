import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  addDays,
  completedYears,
  EMPTY_RUN,
  entryBarbs,
  insignia,
  isReadyForDuty,
  mergeWire,
  MonthFacts,
  monthBarbs,
  monthsTo,
  sastDate,
  shiftBarbs,
  ShiftFacts,
  simulateGuard,
  WireRule,
  WireRun,
  WireSettings,
} from '@onpar/rules';
import { DbService, Tx } from '../db/db.service';
import { RosterService } from '../roster/roster.service';

/** How far back each sweep looks again, so late corrections still earn what is now due. */
const LOOKBACK_DAYS = 35;

interface WorkedShift {
  attendanceId: string;
  employeeId: string;
  siteId: string;
  date: string;
  facts: ShiftFacts;
  taskIds: string[];
  tasksDone: number;
}

const monthOf = (date: string) => date.slice(0, 7);
const firstDay = (month: string) => `${month}-01`;
function lastDay(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
export function monthsFrom(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = nextMonth(m)) out.push(m);
  return out;
}

/**
 * The Wire's engine (owner's rule book, 8 Oct 2026). It reads what On Par already records
 * (attendance, tasks, reports, training, the roster) and writes barbs to an append-only ledger.
 * It never removes a barb: a correction after the fact can only add what is newly due.
 */
@Injectable()
export class WireService implements OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: DbService,
    private readonly roster: RosterService,
  ) {}

  async settings(tx: Tx): Promise<{ settings: WireSettings; startedOn: string; saved: boolean }> {
    const r = (await tx.query(`SELECT config, to_char(started_on, 'YYYY-MM-DD') AS started FROM wire_settings`)).rows[0];
    if (r) return { settings: mergeWire(r.config), startedOn: r.started, saved: true };
    // The first look starts The Wire for the company today.
    const made = (
      await tx.query(
        `INSERT INTO wire_settings (company_id) VALUES (app_company_id()) ON CONFLICT (company_id) DO UPDATE SET company_id = excluded.company_id
         RETURNING to_char(started_on, 'YYYY-MM-DD') AS started`,
      )
    ).rows[0];
    return { settings: mergeWire({}), startedOn: made.started, saved: false };
  }

  // --- What happened ------------------------------------------------------------------------

  /** Worked shifts (on and off duty) between two dates, with what The Wire looks at for each. */
  async workedShifts(tx: Tx, s: WireSettings, from: string, to: string, employeeIds: string[] | null = null): Promise<WorkedShift[]> {
    const rows = (
      await tx.query(
        `SELECT a.id, a.employee_id, a.site_id, to_char(a.shift_date, 'YYYY-MM-DD') AS date, a.duty_on_at, a.duty_from_at, a.scheduled_start,
                coalesce(t.ids, '{}') AS task_ids, coalesce(t.done, 0) AS done, coalesce(t.open, 0) AS open,
                coalesce(r.raised, 0) AS raised, coalesce(r.unhandled, 0) AS unhandled
           FROM attendance a
           LEFT JOIN duty_events de ON de.attendance_id = a.id AND de.kind = 'duty_on'
           LEFT JOIN LATERAL (
             SELECT array_agg(o.id) AS ids,
                    count(*) FILTER (WHERE o.state = 'completed' OR (o.state = 'could_not_complete' AND o.review IS DISTINCT FROM 'not_accepted'))::int AS done,
                    count(*) FILTER (WHERE o.state IN ('open','missed') OR (o.state = 'could_not_complete' AND o.review = 'not_accepted'))::int AS open
               FROM task_occurrences o
              WHERE o.site_id = a.site_id AND o.occurrence_date = a.shift_date AND o.state <> 'cancelled'
                AND (o.assignee_employee_id = a.employee_id
                     OR (o.assignee_type = 'post' AND o.assignee_device_id = de.device_id
                         AND (o.due_time IS NULL OR ((o.occurrence_date + o.due_time) AT TIME ZONE 'Africa/Johannesburg')
                              BETWEEN coalesce(a.scheduled_start, a.duty_on_at) AND coalesce(a.scheduled_end, a.duty_from_at))))
           ) t ON true
           LEFT JOIN LATERAL (
             SELECT count(*)::int AS raised,
                    count(*) FILTER (WHERE rp.closed_at IS NULL AND rp.stage = 'reported' AND rp.assignee_person_id IS NULL)::int AS unhandled
               FROM reports rp WHERE rp.reported_by_employee = a.employee_id AND rp.reported_at BETWEEN a.duty_on_at AND a.duty_from_at
           ) r ON true
          WHERE a.duty_from_at IS NOT NULL AND a.shift_date BETWEEN $1 AND $2 AND ($3::uuid[] IS NULL OR a.employee_id = ANY($3::uuid[]))`,
        [from, to, employeeIds],
      )
    ).rows;
    return rows.map((r) => ({
      attendanceId: r.id,
      employeeId: r.employee_id,
      siteId: r.site_id,
      date: r.date,
      facts: {
        readyForDuty: isReadyForDuty(new Date(r.duty_on_at), r.scheduled_start ? new Date(r.scheduled_start) : null, s),
        dutiesComplete: r.open === 0,
        cleanHandover: r.unhandled === 0,
      },
      taskIds: r.task_ids,
      tasksDone: r.done,
    }));
  }

  /** Each guard's month, counted, for every guard who was rostered or worked in it. */
  async monthFacts(tx: Tx, s: WireSettings, startedOn: string, month: string, employeeIds: string[] | null = null) {
    const from = firstDay(month) < startedOn ? startedOn : firstDay(month);
    const to = lastDay(month);
    const shifts = await this.workedShifts(tx, s, from, to, employeeIds);
    const guards = (
      await tx.query(
        `SELECT e.id, e.home_site_id, to_char(coalesce(p.joined_on, e.created_at::date), 'YYYY-MM-DD') AS joined
           FROM employees e LEFT JOIN wire_profiles p ON p.employee_id = e.id
          WHERE ($1::uuid[] IS NULL OR e.id = ANY($1::uuid[]))
            AND (e.status = 'active' OR EXISTS (SELECT 1 FROM attendance a WHERE a.employee_id = e.id AND a.shift_date BETWEEN $2 AND $3))`,
        [employeeIds, from, to],
      )
    ).rows as { id: string; home_site_id: string; joined: string }[];
    if (!guards.length) return [];
    const ids = guards.map((g) => g.id);
    const days = await this.roster.days(tx, ids, from, to);
    const attended = new Set(
      (await tx.query(`SELECT employee_id || ':' || to_char(shift_date, 'YYYY-MM-DD') AS k FROM attendance WHERE employee_id = ANY($1::uuid[]) AND shift_date BETWEEN $2 AND $3`, [ids, from, to])).rows.map(
        (r) => r.k as string,
      ),
    );
    const reports = new Map(
      (
        await tx.query(
          `SELECT reported_by_employee AS id, count(*)::int AS raised,
                  count(*) FILTER (WHERE closed_at IS NOT NULL OR stage <> 'reported' OR assignee_person_id IS NOT NULL)::int AS handled
             FROM reports WHERE reported_by_employee = ANY($1::uuid[]) AND (reported_at AT TIME ZONE 'Africa/Johannesburg')::date BETWEEN $2 AND $3
            GROUP BY reported_by_employee`,
          [ids, from, to],
        )
      ).rows.map((r) => [r.id as string, r as { raised: number; handled: number }]),
    );
    const skills = new Map(
      (
        await tx.query(
          `SELECT employee_id AS id, count(*)::int AS n FROM qualifications WHERE employee_id = ANY($1::uuid[]) AND completion_date BETWEEN $2 AND $3 GROUP BY employee_id`,
          [ids, from, to],
        )
      ).rows.map((r) => [r.id as string, r.n as number]),
    );
    const out: { employeeId: string; siteId: string | null; facts: MonthFacts }[] = [];
    for (const g of guards) {
      const mine = shifts.filter((x) => x.employeeId === g.id);
      const working = (days.get(g.id) ?? []).filter((d) => d.status === 'working');
      const taskIds = new Set<string>();
      let tasksDone = 0;
      for (const x of mine) {
        // A post task shared by two shifts counts once, with the later shift's view of it.
        for (const id of x.taskIds) taskIds.add(id);
        tasksDone += x.tasksDone;
      }
      const rep = reports.get(g.id);
      const anniversaryDay = `${month}${g.joined.slice(7)}`;
      const facts: MonthFacts = {
        rostered: working.length,
        worked: new Set(mine.map((x) => x.date)).size,
        noShows: working.filter((d) => !attended.has(`${g.id}:${d.date}`)).length,
        ready: mine.filter((x) => x.facts.readyForDuty).length,
        dutiesComplete: mine.filter((x) => x.facts.dutiesComplete).length,
        cleanHandover: mine.filter((x) => x.facts.cleanHandover).length,
        tasksAllocated: taskIds.size,
        tasksDone: Math.min(tasksDone, taskIds.size),
        itemsRaised: rep?.raised ?? 0,
        itemsHandled: rep?.handled ?? 0,
        newSkills: skills.get(g.id) ?? 0,
        anniversary: g.joined.slice(5, 7) === month.slice(5, 7) && completedYears(g.joined, lastDay(month)) >= 1 && anniversaryDay >= startedOn,
      };
      if (facts.rostered || facts.worked || facts.newSkills || facts.anniversary) out.push({ employeeId: g.id, siteId: mine.at(-1)?.siteId ?? g.home_site_id, facts });
    }
    return out;
  }

  // --- Writing barbs ------------------------------------------------------------------------

  private async earn(tx: Tx, e: { employeeId: string; siteId: string | null; date: string; rule: WireRule; barbs: number; key: string; note?: string; by?: string | null }) {
    if (e.barbs <= 0) return false;
    const r = await tx.query(
      `INSERT INTO wire_entries (company_id, employee_id, site_id, entry_date, rule, barbs, source_key, note, created_by)
       VALUES (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (employee_id, rule, source_key) DO NOTHING`,
      [e.employeeId, e.siteId, e.date, e.rule, e.barbs, e.key, e.note ?? '', e.by ?? null],
    );
    return !!r.rowCount;
  }

  /** Shift barbs for worked shifts in the last weeks. Each shift pays each rule once, at the value in force when it is first paid. */
  async sweepShifts(tx: Tx, today: string) {
    const { settings, startedOn } = await this.settings(tx);
    const from = addDays(today, -LOOKBACK_DAYS) < startedOn ? startedOn : addDays(today, -LOOKBACK_DAYS);
    return this.payShifts(tx, settings, from, today);
  }

  private async payShifts(tx: Tx, settings: WireSettings, from: string, to: string) {
    let written = 0;
    for (const x of await this.workedShifts(tx, settings, from, to)) {
      for (const b of shiftBarbs(x.facts, settings)) {
        if (await this.earn(tx, { employeeId: x.employeeId, siteId: x.siteId, date: x.date, rule: b.rule, barbs: b.barbs, key: `shift:${x.attendanceId}` })) written++;
      }
    }
    return written;
  }

  /** The month-end run for every finished month since The Wire started that has not been run yet. */
  async monthEnd(tx: Tx, today: string) {
    const { settings, startedOn } = await this.settings(tx);
    const done = new Set((await tx.query('SELECT month FROM wire_month_runs')).rows.map((r) => r.month as string));
    const last = monthOf(addDays(firstDay(monthOf(today)), -1));
    let runs = 0;
    for (const month of monthsFrom(monthOf(startedOn), last)) {
      if (done.has(month)) continue;
      // Every worked shift of the month is paid before the month is closed, however long ago it was.
      await this.payShifts(tx, settings, firstDay(month) < startedOn ? startedOn : firstDay(month), lastDay(month));
      for (const g of await this.monthFacts(tx, settings, startedOn, month)) {
        const run = await this.runBefore(tx, g.employeeId, month);
        const r = monthBarbs(month, g.facts, run, settings);
        for (const e of r.entries) await this.earn(tx, { employeeId: g.employeeId, siteId: g.siteId, date: lastDay(month), rule: e.rule, barbs: e.barbs, key: `month:${month}` });
        await tx.query(
          `INSERT INTO wire_months (employee_id, month, company_id, site_id, attendance, job, overall, average, award, streak, grace_month, facts)
           VALUES ($1, $2, app_company_id(), $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING`,
          [g.employeeId, month, g.siteId, r.score?.attendance ?? null, r.score?.job ?? null, r.score?.overall ?? null, r.award?.average ?? null, r.award?.award ?? null, r.run.streak, r.run.graceMonth, JSON.stringify(g.facts)],
        );
      }
      await tx.query('INSERT INTO wire_month_runs (company_id, month) VALUES (app_company_id(), $1) ON CONFLICT DO NOTHING', [month]);
      runs++;
    }
    return runs;
  }

  /** A guard's run going into a month, from his locked months before it. */
  private async runBefore(tx: Tx, employeeId: string, month: string): Promise<WireRun> {
    const rows = (await tx.query('SELECT overall, streak, grace_month FROM wire_months WHERE employee_id = $1 AND month < $2 ORDER BY month', [employeeId, month])).rows;
    if (!rows.length) return EMPTY_RUN;
    const last = rows.at(-1);
    return { streak: last.streak, graceMonth: last.grace_month, history: rows.filter((r) => r.overall !== null).map((r) => Number(r.overall)) };
  }

  /** Entry barbs from his recruitment score, once. */
  async entry(tx: Tx, employeeId: string, by: string | null) {
    const { settings } = await this.settings(tx);
    const p = (await tx.query(`SELECT recruitment_score, (SELECT home_site_id FROM employees WHERE id = $1) AS site FROM wire_profiles WHERE employee_id = $1`, [employeeId])).rows[0];
    if (!p || p.recruitment_score === null) return false;
    return this.earn(tx, { employeeId, siteId: p.site, date: sastDate(new Date()), rule: 'entry', barbs: entryBarbs(p.recruitment_score, settings), key: 'once', note: `Recruitment score ${p.recruitment_score}%`, by });
  }

  /** Everything due, for one company. */
  async sweep(tx: Tx, now = new Date()) {
    const today = sastDate(now);
    const shifts = await this.sweepShifts(tx, today);
    const months = await this.monthEnd(tx, today);
    return { shifts, months };
  }

  startTimer(everyMs = 15 * 60_000) {
    const tick = async () => {
      try {
        for (const { scheduler_company_ids: id } of await this.db.query<{ scheduler_company_ids: string }>('SELECT * FROM scheduler_company_ids()')) {
          await this.db.withTenant(id, (tx) => this.sweep(tx));
        }
      } catch (e) {
        console.error(`The Wire sweep failed: ${(e as Error).message}`);
      }
    };
    void tick();
    this.timer = setInterval(tick, everyMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // --- Reading ------------------------------------------------------------------------------

  /** Launch credit: barbs for service before The Wire, on the Wire only, never available to hand in. */
  private launchCredit(joined: string, startedOn: string, s: WireSettings) {
    return completedYears(joined, startedOn) * s.launchCreditPerYear;
  }

  /** One guard's Wire, for his phone and for managers. Nothing negative is in it. */
  async guard(tx: Tx, employeeId: string, today = sastDate(new Date())) {
    const { settings, startedOn } = await this.settings(tx);
    const e = (
      await tx.query(
        `SELECT e.full_name, to_char(coalesce(p.joined_on, e.created_at::date), 'YYYY-MM-DD') AS joined, p.recruitment_score, coalesce(p.show_name, false) AS show_name
           FROM employees e LEFT JOIN wire_profiles p ON p.employee_id = e.id WHERE e.id = $1`,
        [employeeId],
      )
    ).rows[0];
    if (!e) return null;
    const entries = (
      await tx.query(
        `SELECT to_char(entry_date, 'YYYY-MM-DD') AS date, kind, rule, barbs, note FROM wire_entries WHERE employee_id = $1 ORDER BY entry_date DESC, id DESC`,
        [employeeId],
      )
    ).rows as { date: string; kind: string; rule: WireRule; barbs: number; note: string }[];
    const earned = entries.filter((x) => x.kind === 'earned').reduce((a, x) => a + x.barbs, 0);
    const handedIn = entries.filter((x) => x.kind === 'handed_in').reduce((a, x) => a + x.barbs, 0);
    const launch = this.launchCredit(e.joined, startedOn, settings);
    const wireTotal = earned + launch;
    const month = monthOf(today);
    const thisMonth: Partial<Record<WireRule, number>> = {};
    for (const x of entries) if (x.kind === 'earned' && monthOf(x.date) === month) thisMonth[x.rule] = (thisMonth[x.rule] ?? 0) + x.barbs;
    const months = (await tx.query(`SELECT month, overall, award, streak FROM wire_months WHERE employee_id = $1 ORDER BY month DESC LIMIT 12`, [employeeId])).rows;
    const byMonth = new Map<string, number>();
    for (const x of entries) if (x.kind === 'earned' && !['entry'].includes(x.rule)) byMonth.set(monthOf(x.date), (byMonth.get(monthOf(x.date)) ?? 0) + x.barbs);
    // Pace: the average of his finished months since The Wire started, up to the last three.
    const finished = [...byMonth.entries()].filter(([m]) => m < month).sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, 3);
    const pace = finished.length ? Math.round(finished.reduce((a, [, n]) => a + n, 0) / finished.length) : Math.round(byMonth.get(month) ?? 0);
    const level = insignia(wireTotal, settings);
    const next = level === 'black' ? { name: 'Silver barb', at: settings.silver } : level === 'silver' ? { name: 'Gold barb', at: settings.gold } : { name: 'Next 1,000', at: Math.floor(wireTotal / 1000) * 1000 + 1000 };
    return {
      employeeId,
      name: e.full_name as string,
      joinedOn: e.joined as string,
      recruitmentScore: e.recruitment_score as number | null,
      showName: e.show_name as boolean,
      insignia: level,
      wireTotal,
      launchCredit: launch,
      available: Math.max(0, earned - handedIn),
      thisMonth: { total: Object.values(thisMonth).reduce((a, b) => a + (b ?? 0), 0), bySource: thisMonth },
      streak: months[0]?.streak ?? 0,
      months: months.map((m) => ({ month: m.month as string, score: m.overall === null ? null : Number(m.overall), award: m.award as string | null, barbs: byMonth.get(m.month) ?? 0 })),
      pace,
      next: { ...next, toGo: Math.max(0, next.at - wireTotal), months: monthsTo(next.at, wireTotal, pace) },
      monthsToSilver: monthsTo(settings.silver, wireTotal, pace),
      monthsToGold: monthsTo(settings.gold, wireTotal, pace),
      entries,
    };
  }

  /**
   * The owner's "what if": the pilot's real months replayed under the current values and under
   * proposed ones. Nothing is written; the guards' barbs are not touched.
   */
  async simulate(tx: Tx, proposed: WireSettings, fromMonth: string, toMonth: string, siteIds: string[] | null) {
    const { settings, startedOn } = await this.settings(tx);
    const start = fromMonth < monthOf(startedOn) ? monthOf(startedOn) : fromMonth;
    const months = monthsFrom(start, toMonth).slice(0, 24);
    const locked = new Map<string, MonthFacts>(
      (await tx.query(`SELECT employee_id, month, facts FROM wire_months WHERE month = ANY($1)`, [months])).rows.map((r) => [`${r.employee_id}:${r.month}`, r.facts]),
    );
    const byGuard = new Map<string, { siteId: string | null; months: { month: string; facts: MonthFacts }[] }>();
    for (const month of months) {
      const ran = (await tx.query('SELECT 1 FROM wire_month_runs WHERE month = $1', [month])).rowCount;
      const list = ran
        ? (await tx.query(`SELECT employee_id, site_id FROM wire_months WHERE month = $1`, [month])).rows.map((r) => ({ employeeId: r.employee_id as string, siteId: r.site_id as string | null, facts: locked.get(`${r.employee_id}:${month}`)! }))
        : await this.monthFacts(tx, settings, startedOn, month);
      for (const g of list) {
        const b = byGuard.get(g.employeeId) ?? { siteId: g.siteId, months: [] };
        b.months.push({ month, facts: g.facts });
        b.siteId = g.siteId;
        byGuard.set(g.employeeId, b);
      }
    }
    const ids = [...byGuard.keys()];
    const people = (
      await tx.query(
        `SELECT e.id, e.full_name, s.name AS site, to_char(coalesce(p.joined_on, e.created_at::date), 'YYYY-MM-DD') AS joined, p.recruitment_score
           FROM employees e LEFT JOIN wire_profiles p ON p.employee_id = e.id LEFT JOIN sites s ON s.id = e.home_site_id WHERE e.id = ANY($1::uuid[])`,
        [ids],
      )
    ).rows;
    const guards = people
      .filter((p) => !siteIds || siteIds.includes(byGuard.get(p.id)!.siteId ?? ''))
      .map((p) => {
        const g = { employeeId: p.id, recruitmentScore: p.recruitment_score, launchYears: completedYears(p.joined, startedOn), months: byGuard.get(p.id)!.months };
        return { name: p.full_name as string, site: p.site as string | null, current: simulateGuard(g, settings), proposed: simulateGuard(g, proposed) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { months, guards };
  }
}
