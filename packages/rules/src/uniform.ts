/**
 * Uniform: catalogue, site lists, the annual issue and the order flow (owner's decision
 * D-33, docs/NEXT_ROUND.md item 9). Equipment (radio, torch) and site supplies stay in
 * re-orders.
 *
 * Flow: the guard orders on the post phone → a manager or administrator decides each line
 * (company account, guard's account, or not issued) → stores marks it ready → the
 * supervisor collects it, and stores confirms the hand-over → the guard signs for it on
 * the phone with his PIN, and agrees to pay for any guard's-account items.
 *
 * The app never deducts anything from pay (L-08): a guard's-account amount is a record,
 * signed by the guard, for payroll to act on under the company's own process.
 */

/** The whole site uniform list becomes available again this long after it was last issued. */
export const DEFAULT_RENEWAL_MONTHS = 12;

export const UNIFORM_STATUSES = ['requested', 'approved', 'ready', 'with_supervisor', 'received', 'declined'] as const;
export type UniformStatus = (typeof UNIFORM_STATUSES)[number];
export const UNIFORM_STATUS_LABELS: Record<UniformStatus, string> = {
  requested: 'Waiting for approval',
  approved: 'Approved: with stores',
  ready: 'Ready for collection at stores',
  with_supervisor: 'With the supervisor, to deliver',
  received: 'Received by the guard',
  declined: 'Not issued',
};

export const LINE_DECISIONS = ['company', 'guard', 'declined'] as const;
export type LineDecision = (typeof LINE_DECISIONS)[number];
export const LINE_DECISION_LABELS: Record<LineDecision, string> = {
  company: 'Issue: company account',
  guard: "Issue: guard's account",
  declined: 'Do not issue',
};

/** The date an item is next due: its last issue date plus the renewal period. */
export function nextDueDate(lastIssued: string | null, renewalMonths: number = DEFAULT_RENEWAL_MONTHS): string | null {
  if (!lastIssued) return null;
  const d = new Date(`${lastIssued}T12:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + renewalMonths);
  // Keep the day of the month, or the last day if the month is shorter (31 Jan + 1 month = 28/29 Feb).
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

/** Due now: never issued, or the renewal date has come. */
export function isDue(lastIssued: string | null, today: string, renewalMonths: number = DEFAULT_RENEWAL_MONTHS): boolean {
  const next = nextDueDate(lastIssued, renewalMonths);
  return next === null || next <= today;
}

export interface OrderLineForTotals {
  quantity: number;
  decision: LineDecision | null;
  unitPriceCents: number;
}

/** What the company pays and what the guard has agreed to pay. Declined lines count for neither. */
export function orderTotals(lines: OrderLineForTotals[]): { companyCents: number; guardCents: number } {
  let companyCents = 0;
  let guardCents = 0;
  for (const l of lines) {
    const v = l.quantity * l.unitPriceCents;
    if (l.decision === 'company') companyCents += v;
    if (l.decision === 'guard') guardCents += v;
  }
  return { companyCents, guardCents };
}

/** Rand amounts as South Africans write them: R1 234.50. */
export function formatRand(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const rands = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}R${rands}.${String(abs % 100).padStart(2, '0')}`;
}

/** The statement the guard signs with his PIN when guard's-account items are handed to him (L-08: to be checked by a labour lawyer). */
export function guardPaysStatement(totalCents: number): string {
  return `I received the items marked "guard's account" and I agree to pay ${formatRand(totalCents)} for them.`;
}

/** The status after stores and supervisor steps; a single step can never skip ahead. */
export const UNIFORM_NEXT: Record<'ready' | 'collected' | 'received', { from: readonly UniformStatus[]; to: UniformStatus }> = {
  ready: { from: ['approved'], to: 'ready' },
  collected: { from: ['ready'], to: 'with_supervisor' },
  received: { from: ['with_supervisor'], to: 'received' },
};

/** A reasonable earliest date a guard is next on duty, for planning delivery (from roster days). */
export function nextWorkingDay(days: { date: string; working: boolean }[], from: string): string | null {
  const next = days.find((d) => d.working && d.date >= from);
  return next ? next.date : null;
}


export const UNIFORM_CONDITIONS = {
  torn: 'Torn or damaged',
  dirty: 'Dirty',
  badly_kept: 'Badly kept',
  missing_items: 'Items missing',
  other: 'Other',
} as const;
export type UniformCondition = keyof typeof UNIFORM_CONDITIONS;
