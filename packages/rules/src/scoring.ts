/**
 * The scoring engine's rules (brief sections 6.8 and 10).
 *
 * Points inform a conversation. Nothing here triggers discipline, deductions
 * or dismissal. Every value is a company setting; these are the defaults.
 */

import { addDays } from './tasks';

/** Every kind of performance event. Points per type are company settings. */
export const EVENT_TYPES = {
  on_time: { label: 'On time', sign: 1 },
  late: { label: 'Late arrival', sign: -1 },
  task_completed: { label: 'Task completed', sign: 1 },
  missed_task: { label: 'Missed task', sign: -1 },
  training_completed: { label: 'Training completed', sign: 1 },
  report_closed: { label: 'Report closed', sign: 1 },
  missed_shift: { label: 'Missed shift', sign: -1 },
  missed_patrol: { label: 'Missed patrol', sign: -1 },
  outstanding: { label: 'Outstanding performance', sign: 1 },
} as const;
export type EventType = keyof typeof EVENT_TYPES;

export interface ScoringConfig {
  points: Record<EventType, number>;
  base: number;
  min: number;
  max: number;
  windowDays: number;
  dailyCap: number;
  aboveParFrom: number;
  onParFrom: number;
  /** The most a supervisor may award at once. Larger awards need a manager. */
  supervisorAwardLimit: number;
  /** The most a manager may award at once. */
  managerAwardLimit: number;
  /** Days an employee has to query a negative event. */
  queryWindowDays: number;
  /** Working days a supervisor has to answer a query. */
  answerWorkingDays: number;
}

export const DEFAULT_SCORING: ScoringConfig = {
  points: {
    on_time: 1,
    late: -1,
    task_completed: 1,
    missed_task: -1,
    training_completed: 1,
    report_closed: 1,
    missed_shift: -2,
    missed_patrol: 0,
    outstanding: 2,
  },
  base: 80,
  min: 0,
  max: 120,
  windowDays: 30,
  dailyCap: 5,
  aboveParFrom: 90,
  onParFrom: 70,
  supervisorAwardLimit: 2,
  managerAwardLimit: 5,
  queryWindowDays: 7,
  answerWorkingDays: 3,
};

/** A company's stored settings on top of the defaults. */
export function mergeScoring(stored: Partial<ScoringConfig> | null | undefined): ScoringConfig {
  return { ...DEFAULT_SCORING, ...(stored ?? {}), points: { ...DEFAULT_SCORING.points, ...(stored?.points ?? {}) } };
}

/** Returns field → message for a settings change. */
export function scoringErrors(c: ScoringConfig): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [type, meta] of Object.entries(EVENT_TYPES) as [EventType, (typeof EVENT_TYPES)[EventType]][]) {
    const p = c.points[type];
    if (typeof p !== 'number' || !Number.isFinite(p) || Math.abs(p) > 10) e[`points.${type}`] = 'Between −10 and 10.';
    else if (meta.sign > 0 && p < 0) e[`points.${type}`] = 'This is a positive event; use 0 or more.';
    else if (meta.sign < 0 && p > 0) e[`points.${type}`] = 'This is a negative event; use 0 or less.';
  }
  if (!(c.min < c.onParFrom && c.onParFrom < c.aboveParFrom && c.aboveParFrom <= c.max)) {
    e.aboveParFrom = 'Positions must be in order: lowest score < On Par < Above Par ≤ highest score.';
  }
  if (c.base < c.min || c.base > c.max) e.base = 'The starting score must be within the range.';
  if (!Number.isInteger(c.windowDays) || c.windowDays < 7 || c.windowDays > 365) e.windowDays = 'Between 7 and 365 days.';
  if (!(c.dailyCap > 0)) e.dailyCap = 'Must be more than 0.';
  if (!(c.supervisorAwardLimit > 0 && c.supervisorAwardLimit <= c.managerAwardLimit)) {
    e.supervisorAwardLimit = 'Must be more than 0 and no more than the manager limit.';
  }
  if (!Number.isInteger(c.queryWindowDays) || c.queryWindowDays < 1) e.queryWindowDays = 'At least 1 day.';
  if (!Number.isInteger(c.answerWorkingDays) || c.answerWorkingDays < 1) e.answerWorkingDays = 'At least 1 working day.';
  return e;
}

export type Position = 'ABOVE_PAR' | 'ON_PAR' | 'NEEDS_ATTENTION';
export const POSITION_LABELS: Record<Position, string> = {
  ABOVE_PAR: 'Above Par',
  ON_PAR: 'On Par',
  NEEDS_ATTENTION: 'Needs Attention',
};

export function position(score: number, c: ScoringConfig = DEFAULT_SCORING): Position {
  if (score >= c.aboveParFrom) return 'ABOVE_PAR';
  if (score >= c.onParFrom) return 'ON_PAR';
  return 'NEEDS_ATTENTION';
}

export interface ScoredEvent {
  /** The SAST date the event belongs to. */
  date: string;
  impact: number;
}

export interface ScoreResult {
  score: number;
  position: Position;
  /** Points counted from the window, after the daily cap. */
  counted: number;
  /** Points that fell outside the cap on busy days. */
  cappedOff: number;
  from: string;
  to: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Score = base + the points from the last `windowDays` days (today included),
 * with each day's total held within ±dailyCap, and the result kept between
 * min and max.
 */
export function computeScore(events: ScoredEvent[], today: string, c: ScoringConfig = DEFAULT_SCORING): ScoreResult {
  const from = addDays(today, -(c.windowDays - 1));
  const byDay = new Map<string, number>();
  for (const e of events) {
    if (e.date < from || e.date > today) continue;
    byDay.set(e.date, (byDay.get(e.date) ?? 0) + e.impact);
  }
  let counted = 0;
  let raw = 0;
  for (const total of byDay.values()) {
    raw += total;
    counted += Math.max(-c.dailyCap, Math.min(c.dailyCap, total));
  }
  const score = round2(Math.max(c.min, Math.min(c.max, c.base + counted)));
  return { score, position: position(score, c), counted: round2(counted), cappedOff: round2(raw - counted), from, to: today };
}

/**
 * South African public holidays for a year: the fixed dates, Good Friday and
 * Family Day, and the Monday after any that fall on a Sunday. Holidays the
 * President declares ad hoc (for example election days) are not included.
 */
export function saPublicHolidays(year: number): Set<string> {
  // Easter Sunday (anonymous Gregorian algorithm).
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  const fixed = ['01-01', '03-21', '04-27', '05-01', '06-16', '08-09', '09-24', '12-16', '12-25', '12-26'].map((md) => `${year}-${md}`);
  const days = new Set([...fixed, addDays(easter, -2), addDays(easter, 1)]);
  for (const dte of fixed) {
    if (new Date(`${dte}T12:00:00Z`).getUTCDay() === 0) days.add(addDays(dte, 1));
  }
  return days;
}

export function isWorkingDay(date: string): boolean {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !saPublicHolidays(Number(date.slice(0, 4))).has(date);
}

/** The date `n` working days after `date`. */
export function addWorkingDays(date: string, n: number): string {
  let d = date;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (isWorkingDay(d)) left--;
  }
  return d;
}

/** The last date a negative event can be queried: `queryWindowDays` after the event. */
export function queryDeadline(eventDate: string, c: ScoringConfig = DEFAULT_SCORING): string {
  return addDays(eventDate, c.queryWindowDays);
}
