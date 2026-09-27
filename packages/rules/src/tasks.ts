/** Task and recurrence rules (brief sections 6.4 and 25). */

import { sastInstant } from './attendance';

export const RECURRENCES = ['once', 'daily', 'weekly', 'monthly'] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export const RECURRENCE_LABELS: Record<Recurrence, string> = {
  once: 'Once',
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
};

/** Reasons a guard can give for "I could not complete this task" (section 6.4). */
export const COULD_NOT_COMPLETE_REASONS = {
  equipment_unavailable: 'Equipment unavailable',
  access_unavailable: 'Access unavailable',
  emergency: 'Emergency',
  supervisor_instruction: 'Supervisor instruction',
  other: 'Other',
} as const;
export type CouldNotCompleteReason = keyof typeof COULD_NOT_COMPLETE_REASONS;

/** How far ahead the server creates occurrences, so devices can cache upcoming tasks. */
export const GENERATE_AHEAD_DAYS = 7;

export interface RecurrenceRule {
  recurrence: Recurrence;
  /** First date, YYYY-MM-DD. Weekly repeats on its weekday; monthly on its day of the month. */
  startDate: string;
  /** Last date allowed, inclusive, or null for no end. */
  endDate?: string | null;
}

const DAY = 24 * 60 * 60 * 1000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const toDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(date: string, n: number): string {
  return toDate(toMs(date) + n * DAY);
}

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * Every occurrence date of a rule within [from, to], inclusive. Monthly tasks
 * on the 29th to 31st fall on the last day of shorter months. Occurrences
 * depend only on the rule and the calendar, never on whether earlier ones
 * were done, so a missed occurrence never stops the next one (scenario 9).
 */
export function occurrenceDates(rule: RecurrenceRule, from: string, to: string): string[] {
  const first = rule.startDate > from ? rule.startDate : from;
  const last = rule.endDate && rule.endDate < to ? rule.endDate : to;
  if (first > last) return [];
  const out: string[] = [];
  switch (rule.recurrence) {
    case 'once':
      if (rule.startDate >= first && rule.startDate <= last) out.push(rule.startDate);
      break;
    case 'daily':
      for (let d = first; d <= last; d = addDays(d, 1)) out.push(d);
      break;
    case 'weekly': {
      const offset = (((toMs(first) - toMs(rule.startDate)) / DAY) % 7 + 7) % 7;
      for (let d = addDays(first, offset === 0 ? 0 : 7 - offset); d <= last; d = addDays(d, 7)) out.push(d);
      break;
    }
    case 'monthly': {
      const wanted = Number(rule.startDate.slice(8, 10));
      let y = Number(first.slice(0, 4));
      let m = Number(first.slice(5, 7)) - 1;
      for (;;) {
        const day = Math.min(wanted, daysInMonth(y, m));
        const d = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (d > last) break;
        if (d >= first) out.push(d);
        if (++m === 12) {
          m = 0;
          y++;
        }
      }
      break;
    }
  }
  return out;
}

export interface Deadline {
  /** When the task is due, for tasks that need a specific time. Null means any time that day. */
  dueAt: Date | null;
  /** After this the occurrence is missed: the end of its day. */
  closesAt: Date;
}

/** Due time and closing time for one occurrence (sections 6.4 and 25). */
export function occurrenceDeadline(date: string, dueTime: string | null): Deadline {
  return {
    dueAt: dueTime ? sastInstant(date, dueTime) : null,
    closesAt: sastInstant(addDays(date, 1), '00:00'),
  };
}

export type OccurrenceState = 'open' | 'completed' | 'could_not_complete' | 'missed' | 'cancelled';
export type OccurrenceStatus = OccurrenceState | 'overdue' | 'upcoming';

/**
 * What to show for an occurrence at a moment in time. A stored `open` becomes
 * `overdue` after its due time and `missed` once its day has ended (the server
 * also records missed occurrences when it sweeps).
 */
export function occurrenceStatus(
  state: OccurrenceState,
  date: string,
  dueTime: string | null,
  now: Date,
): OccurrenceStatus {
  if (state !== 'open') return state;
  const { dueAt, closesAt } = occurrenceDeadline(date, dueTime);
  if (now.getTime() >= closesAt.getTime()) return 'missed';
  if (now.getTime() < sastInstant(date, '00:00').getTime()) return 'upcoming';
  if (dueAt && now.getTime() > dueAt.getTime()) return 'overdue';
  return 'open';
}

export interface TaskInput {
  title?: string;
  siteId?: string;
  assigneeType?: string;
  assigneeEmployeeId?: string | null;
  assigneeDeviceId?: string | null;
  recurrence?: string;
  startDate?: string;
  endDate?: string | null;
  timeRequired?: boolean;
  dueTime?: string | null;
}

/** Returns field → message. Untimed is the default (section 25). */
export function taskErrors(t: TaskInput): Record<string, string> {
  const e: Record<string, string> = {};
  if (!t.title?.trim()) e.title = 'Describe the task, for example "Check all fire extinguishers".';
  if (!t.siteId) e.siteId = 'Choose a site.';
  if (t.assigneeType === 'employee') {
    if (!t.assigneeEmployeeId) e.assigneeEmployeeId = 'Choose the officer.';
  } else if (t.assigneeType === 'post') {
    if (!t.assigneeDeviceId) e.assigneeDeviceId = 'Choose the post.';
  } else {
    e.assigneeType = 'Assign the task to an officer or a post.';
  }
  if (!t.recurrence || !(RECURRENCES as readonly string[]).includes(t.recurrence)) e.recurrence = 'Choose how often.';
  if (!t.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(t.startDate)) e.startDate = 'Choose a date.';
  if (t.endDate && t.startDate && t.endDate < t.startDate) e.endDate = 'The end date must be after the start date.';
  if (t.timeRequired && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t.dueTime ?? '')) e.dueTime = 'Enter the time, like 14:00.';
  return e;
}
