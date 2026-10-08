/**
 * The Electronic Occurrence Book (brief section 27): one time-ordered list for a site and a day,
 * put together from what the rest of On Par already records. Nothing is entered twice. It is
 * not the official Occurrence Book.
 */
export const EOB_CATEGORIES = ['duty', 'task', 'patrol', 'report', 'reorder', 'panic', 'bolo', 'visitor', 'handover', 'roll_call', 'emergency_call', 'entry'] as const;
export type EobCategory = (typeof EOB_CATEGORIES)[number];
export const EOB_CATEGORY_LABELS: Record<EobCategory, string> = {
  duty: 'Duty',
  task: 'Task',
  patrol: 'Patrol',
  report: 'Report',
  reorder: 'Re-order',
  panic: 'Panic',
  bolo: 'BOLO',
  visitor: 'Visitor',
  handover: 'Handover',
  roll_call: 'Roll-call',
  emergency_call: 'Emergency call',
  entry: 'Written entry',
};

/** Shown above the book wherever it appears (brief section 27). */
export const EOB_BANNER =
  'This is not the official Occurrence Book. It does not replace the site’s paper or electronic OB, which continues as normal.';

/** What is wrong with a written entry; null when it can be saved. */
export function eobEntryError(text: string): string | null {
  const t = text.trim();
  if (t.length < 3) return 'Write what happened.';
  if (t.length > 2000) return 'Keep the entry under 2,000 characters.';
  return null;
}
