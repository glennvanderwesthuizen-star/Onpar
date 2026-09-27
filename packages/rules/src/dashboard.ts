/** Management dashboard figures (brief section 6.11). */
import { sastInstant } from './attendance';
import type { Priority } from './reports';

/**
 * Days an open report may stay open before it counts as overdue, by priority.
 * The brief sets no deadline, so these are proposed defaults for the owner to confirm.
 */
export const DEFAULT_REPORT_OVERDUE_DAYS: Record<Priority, number> = { red: 1, amber: 3, green: 7 };

export function reportOverdue(
  priority: Priority,
  reportedAt: Date,
  now: Date,
  days: Record<Priority, number> = DEFAULT_REPORT_OVERDUE_DAYS,
): boolean {
  return now.getTime() - reportedAt.getTime() > days[priority] * 24 * 60 * 60 * 1000;
}

/**
 * Until rostering exists (milestone 21) nobody is scheduled by name, so absence is
 * counted per shift: once a shift is past its start plus the grace period, each
 * required post nobody has logged Duty On for counts as absent.
 */
export function unfilledPosts(
  guardsRequired: number,
  arrived: number,
  shiftDate: string,
  startTime: string,
  now: Date,
  graceMinutes: number,
): number {
  const due = sastInstant(shiftDate, startTime.slice(0, 5)).getTime() + graceMinutes * 60 * 1000;
  if (now.getTime() <= due) return 0;
  return Math.max(0, guardsRequired - arrived);
}

/** A whole percentage; null when there is nothing to measure. */
export function percent(part: number, whole: number): number | null {
  return whole ? Math.round((part / whole) * 100) : null;
}
