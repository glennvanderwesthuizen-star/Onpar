/**
 * Shift patterns and rostering (brief sections 31 and 36 to 43; decisions D-19, D-20, D-25).
 *
 * A pattern is a repeating cycle of Day, Night and Off. A guard is allocated to
 * one site with one pattern, a start date and a position; every date's shift is
 * computed from that, never stored. Single-day changes (once, or repeating
 * weekly) move a guard to another shift or site, or give the day off, without
 * touching the pattern.
 */

import { sastInstant } from './attendance';
import { minutesOfDay, ShiftKind } from './shifts';
import { saPublicHolidays } from './scoring';
import { addDays } from './tasks';

export type PatternSymbol = 'D' | 'N' | 'O';
export const PATTERN_SYMBOLS: readonly PatternSymbol[] = ['D', 'N', 'O'];
export const MAX_PATTERN_LENGTH = 56;

/** Day names in the order used for per-day guard requirements: Monday first, then public holiday. */
export const REQUIREMENT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Public holiday'] as const;
export const HOLIDAY_INDEX = 7;

/** "DDDNNNOOO", "D D D N N N O O O" or "D,D,N" → ['D','D',...]. Unknown letters are kept so they can be reported. */
export function parsePattern(text: string): string[] {
  return text.toUpperCase().replace(/[\s,/-]+/g, '').split('');
}

/** Positions (0-based) of every Night immediately followed by a Day, wrapping from the last day to the first. */
export function nightIntoDay(sequence: readonly string[]): number[] {
  const out: number[] = [];
  sequence.forEach((s, i) => {
    if (s === 'N' && sequence[(i + 1) % sequence.length] === 'D') out.push(i);
  });
  return out;
}

export interface PatternInput {
  name?: string;
  sequence?: string[];
}

/** Returns field → message. Empty object means the pattern is valid (scenario 23). */
export function patternErrors(p: PatternInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!p.name?.trim()) errors.name = 'Give the pattern a name, for example 3 day / 3 night / 3 off.';
  const seq = p.sequence ?? [];
  if (!seq.length) {
    errors.sequence = 'Add at least one day to the pattern.';
    return errors;
  }
  if (seq.length > MAX_PATTERN_LENGTH) errors.sequence = `A pattern can be at most ${MAX_PATTERN_LENGTH} days long.`;
  else if (seq.some((s) => !PATTERN_SYMBOLS.includes(s as PatternSymbol))) errors.sequence = 'Use only D (day), N (night) and O (off).';
  else if (!seq.some((s) => s !== 'O')) errors.sequence = 'The pattern needs at least one day or night shift.';
  else {
    const bad = nightIntoDay(seq);
    if (bad.length) {
      const i = bad[0];
      const next = (i + 1) % seq.length;
      errors.sequence =
        next === 0
          ? `Day ${i + 1} is a night shift and the pattern starts again with a day shift. A night shift may never be followed straight by a day shift.`
          : `Day ${i + 1} is a night shift followed straight by a day shift on day ${next + 1}. A night shift may never be followed straight by a day shift.`;
    }
  }
  return errors;
}

/** "3 day / 3 night / 3 off" from DDDNNNOOO. */
export function describePattern(sequence: readonly string[]): string {
  const words: Record<string, string> = { D: 'day', N: 'night', O: 'off' };
  const parts: string[] = [];
  let i = 0;
  while (i < sequence.length) {
    let j = i;
    while (j < sequence.length && sequence[j] === sequence[i]) j++;
    parts.push(`${j - i} ${words[sequence[i]] ?? sequence[i]}`);
    i = j;
  }
  return parts.join(' / ');
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `a` to `b` (both YYYY-MM-DD); negative when b is earlier. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(date: string): number {
  return (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
}

/**
 * The pattern symbol for a date: `(position - 1 + days since start) modulo length`
 * (section 31). Null before the start date.
 */
export function patternSymbolOn(sequence: readonly string[], startDate: string, position: number, date: string): PatternSymbol | null {
  const days = daysBetween(startDate, date);
  if (days < 0) return null;
  const n = sequence.length;
  return sequence[(((position - 1 + days) % n) + n) % n] as PatternSymbol;
}

// ---------------------------------------------------------------------------
// Resolving one guard's day

export interface RosterShift {
  id: string;
  siteId: string;
  name: string;
  kind: ShiftKind;
  startTime: string;
  endTime: string;
  sortOrder?: number;
}

export interface RosterAllocation {
  id: string;
  siteId: string;
  sequence: readonly string[];
  startDate: string;
  /** The first date the allocation no longer applies; null while active. */
  endDate: string | null;
  position: number;
  /** The site shift a D means, when the site has several day shifts; otherwise the first by sort order. */
  dayShiftId?: string | null;
  /** The site shift an N means, when the site has several night shifts. */
  nightShiftId?: string | null;
}

export interface RosterChange {
  id: string;
  /** A one-off change for this date, or null for a weekly change. */
  date: string | null;
  /** 0 = Monday … 6 = Sunday, for a weekly change. */
  weekday: number | null;
  /** A weekly change applies from this date … */
  fromDate: string | null;
  /** … until this date, inclusive, or for good when null. */
  untilDate: string | null;
  /** The shift worked instead, or null for a day off. */
  shiftId: string | null;
  note?: string;
}

export type RosterSource = 'pattern' | 'change' | 'weekly';

export type RosterDay =
  | {
      date: string;
      status: 'working';
      source: RosterSource;
      changeId: string | null;
      siteId: string;
      shiftId: string;
      shiftName: string;
      kind: ShiftKind;
      startTime: string;
      endTime: string;
    }
  | { date: string; status: 'off'; source: RosterSource; changeId: string | null; siteId: string | null }
  /** The pattern says Day or Night, but the site has no shift of that kind. */
  | { date: string; status: 'unmapped'; source: 'pattern'; changeId: null; siteId: string; kind: ShiftKind }
  | { date: string; status: 'not_rostered'; source: null; changeId: null; siteId: null };

/** The allocation that applies on a date, if any. */
export function allocationOn(allocations: readonly RosterAllocation[], date: string): RosterAllocation | null {
  return allocations.find((a) => a.startDate <= date && (a.endDate === null || date < a.endDate)) ?? null;
}

/** The change that applies on a date: a one-off change beats a weekly one; among weekly ones the latest start wins. */
export function changeOn(changes: readonly RosterChange[], date: string): { change: RosterChange; source: 'change' | 'weekly' } | null {
  const once = changes.find((c) => c.date === date);
  if (once) return { change: once, source: 'change' };
  const wd = weekdayIndex(date);
  const weekly = changes
    .filter((c) => c.date === null && c.weekday === wd && (c.fromDate ?? '') <= date && (c.untilDate === null || date <= c.untilDate))
    .sort((a, b) => (b.fromDate ?? '').localeCompare(a.fromDate ?? ''))[0];
  return weekly ? { change: weekly, source: 'weekly' } : null;
}

/** Shift of a kind at a site: the first by sort order, as a pattern's D and N map onto the site's Day- and Night-tagged shifts. */
export function siteShiftOfKind(shifts: readonly RosterShift[], siteId: string, kind: ShiftKind): RosterShift | null {
  return (
    shifts
      .filter((s) => s.siteId === siteId && s.kind === kind)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))[0] ?? null
  );
}

/**
 * One guard's roster for one date: a change for that date if there is one,
 * otherwise the computed pattern value (scenario 25), otherwise not rostered.
 */
export function resolveRosterDay(
  date: string,
  allocations: readonly RosterAllocation[],
  changes: readonly RosterChange[],
  shifts: readonly RosterShift[],
): RosterDay {
  const c = changeOn(changes, date);
  const alloc = allocationOn(allocations, date);
  if (c) {
    if (c.change.shiftId === null) return { date, status: 'off', source: c.source, changeId: c.change.id, siteId: alloc?.siteId ?? null };
    const s = shifts.find((x) => x.id === c.change.shiftId);
    if (s) return working(date, s, c.source, c.change.id);
  }
  if (!alloc) return { date, status: 'not_rostered', source: null, changeId: null, siteId: null };
  const sym = patternSymbolOn(alloc.sequence, alloc.startDate, alloc.position, date);
  if (sym === 'O' || sym === null) return { date, status: 'off', source: 'pattern', changeId: null, siteId: alloc.siteId };
  const kind: ShiftKind = sym === 'D' ? 'day' : 'night';
  const chosen = kind === 'day' ? alloc.dayShiftId : alloc.nightShiftId;
  const s = (chosen && shifts.find((x) => x.id === chosen && x.siteId === alloc.siteId)) || siteShiftOfKind(shifts, alloc.siteId, kind);
  if (!s) return { date, status: 'unmapped', source: 'pattern', changeId: null, siteId: alloc.siteId, kind };
  return working(date, s, 'pattern', null);
}

function working(date: string, s: RosterShift, source: RosterSource, changeId: string | null): RosterDay {
  return {
    date,
    status: 'working',
    source,
    changeId,
    siteId: s.siteId,
    shiftId: s.id,
    shiftName: s.name,
    kind: s.kind,
    startTime: s.startTime,
    endTime: s.endTime,
  };
}

/** Every date from `from` to `to`, inclusive. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The real start and end of a shift that starts on `date`. A shift ending at or before its start runs past midnight. */
export function shiftWindow(date: string, startTime: string, endTime: string): { start: Date; end: Date } {
  const overnight = minutesOfDay(endTime) <= minutesOfDay(startTime);
  return { start: sastInstant(date, startTime), end: sastInstant(overnight ? addDays(date, 1) : date, endTime) };
}

export interface RosterClash {
  date: string;
  message: string;
}

/**
 * Rest checks on a guard's worked days (section 31, decided D-25: always blocked).
 * A Night shift is never followed straight by a Day shift the next day, and no
 * shift may start before the previous one ends, using each site's real times.
 */
export function rosterClashes(days: readonly RosterDay[]): RosterClash[] {
  const worked = days
    .filter((d): d is Extract<RosterDay, { status: 'working' }> => d.status === 'working')
    .sort((a, b) => a.date.localeCompare(b.date));
  const out: RosterClash[] = [];
  for (let i = 1; i < worked.length; i++) {
    const prev = worked[i - 1];
    const next = worked[i];
    const consecutive = daysBetween(prev.date, next.date) === 1;
    if (consecutive && prev.kind === 'night' && next.kind === 'day') {
      out.push({
        date: next.date,
        message: `${next.date}: a day shift straight after the night shift of ${prev.date}. A night shift may never be followed straight by a day shift.`,
      });
      continue;
    }
    const a = shiftWindow(prev.date, prev.startTime, prev.endTime);
    const b = shiftWindow(next.date, next.startTime, next.endTime);
    if (b.start.getTime() < a.end.getTime()) {
      out.push({
        date: next.date,
        message: `${next.date}: the ${next.shiftName} shift starts before the ${prev.shiftName} shift of ${prev.date} has ended.`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Guards needed per day (D-20, D-25)

export interface RequirementShift {
  guardsRequired: number;
  /** Mon … Sun, then public holiday; null means the same every day. */
  guardsByDay: readonly number[] | null;
}

/** Returns an error message for a per-day requirement list, or null when valid. */
export function guardsByDayError(byDay: readonly number[] | null | undefined): string | null {
  if (byDay == null) return null;
  if (byDay.length !== REQUIREMENT_DAYS.length) return 'Give a number for each day, Monday to Sunday, and for public holidays.';
  if (byDay.some((n) => !Number.isInteger(n) || n < 0 || n > 999)) return 'Each day needs 0 or more guards.';
  if (!byDay.some((n) => n > 0)) return 'At least one day needs a guard.';
  return null;
}

/** Guards needed on one shift on one date: a single-date change, else the public holiday figure, else the weekday figure. */
export function guardsRequiredOn(shift: RequirementShift, date: string, holidays: ReadonlySet<string>, dateOverride?: number | null): number {
  if (dateOverride != null) return dateOverride;
  if (!shift.guardsByDay) return shift.guardsRequired;
  return holidays.has(date) ? shift.guardsByDay[HOLIDAY_INDEX] : shift.guardsByDay[weekdayIndex(date)];
}

/** South African public holidays across the years a date range touches, plus any the company added. */
export function holidaysBetween(from: string, to: string, extra: readonly string[] = []): Set<string> {
  const out = new Set(extra);
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) for (const d of saPublicHolidays(y)) out.add(d);
  return out;
}

export type CoverStatus = 'pass' | 'short' | 'over';

export function coverStatus(required: number, actual: number): CoverStatus {
  return actual < required ? 'short' : actual > required ? 'over' : 'pass';
}

// ---------------------------------------------------------------------------
// Payroll month (section 41)

export interface PayrollPeriod {
  start: string;
  end: string;
  days: number;
}

/** The payroll period containing `date` for a site whose month starts on `startDay` (scenario 32). */
export function payrollPeriod(date: string, startDay: number): PayrollPeriod {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1;
  const d = Number(date.slice(8, 10));
  const startMonth = d >= startDay ? m : m - 1;
  const start = new Date(Date.UTC(y, startMonth, startDay)).toISOString().slice(0, 10);
  const end = addDays(new Date(Date.UTC(y, startMonth + 1, startDay)).toISOString().slice(0, 10), -1);
  return { start, end, days: daysBetween(start, end) + 1 };
}

export function nextPayrollPeriod(p: PayrollPeriod, startDay: number): PayrollPeriod {
  return payrollPeriod(addDays(p.end, 1), startDay);
}

export function previousPayrollPeriod(p: PayrollPeriod, startDay: number): PayrollPeriod {
  return payrollPeriod(addDays(p.start, -1), startDay);
}

/** The Monday of the week containing `date`. */
export function weekStart(date: string): string {
  return addDays(date, -weekdayIndex(date));
}

// ---------------------------------------------------------------------------
// Attendance register (section 32): never invents a time (scenario 26).

export type RegisterStatus = 'complete' | 'on_duty' | 'absent' | 'rest_day' | 'no_record' | 'unscheduled' | 'upcoming';

export const REGISTER_STATUS_LABELS: Record<RegisterStatus, string> = {
  complete: 'Complete',
  on_duty: 'On duty, no Duty From yet',
  absent: 'Absent: no Duty On logged',
  rest_day: 'Rest day',
  no_record: 'No record',
  unscheduled: 'Worked, not on the roster',
  upcoming: 'Still to come',
};

/**
 * The status of one register day. `scheduled` is whether the roster had a shift;
 * `dutyOnAt`/`dutyFromAt` are real logged times only; `shiftEnded` says the
 * scheduled shift is over (so a missing Duty On means absent, not "still to come").
 */
export function registerStatus(
  rosterStatus: RosterDay['status'],
  dutyOnAt: Date | null,
  dutyFromAt: Date | null,
  shiftStarted: boolean,
): RegisterStatus {
  if (dutyOnAt) {
    if (rosterStatus !== 'working') return dutyFromAt ? 'unscheduled' : 'on_duty';
    return dutyFromAt ? 'complete' : 'on_duty';
  }
  if (rosterStatus === 'working' || rosterStatus === 'unmapped') return shiftStarted ? 'absent' : 'upcoming';
  if (rosterStatus === 'off') return 'rest_day';
  return 'no_record';
}

/** Hours between two times, to two decimals. */
export function hoursBetween(a: Date, b: Date): number {
  return Math.round(((b.getTime() - a.getTime()) / 3_600_000) * 100) / 100;
}
