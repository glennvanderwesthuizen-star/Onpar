/** Reports and close-out (brief sections 6.6 and 24). */

export const REPORT_CATEGORIES = {
  security: 'Security',
  safety: 'Safety',
  injury: 'Injury',
  maintenance: 'Maintenance',
  equipment: 'Equipment',
  client_issue: 'Client issue',
  staff_issue: 'Staff issue',
  observation: 'Observation',
  other: 'Other',
} as const;
export type ReportCategory = keyof typeof REPORT_CATEGORIES;

export const PRIORITIES = ['green', 'amber', 'red'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = { green: 'Green', amber: 'Amber', red: 'Red' };

export const STAGES = ['reported', 'assigned', 'actioned', 'attendance_checked', 'job_inspected', 'closed'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABELS: Record<Stage, string> = {
  reported: 'Reported',
  assigned: 'Assigned',
  actioned: 'Actioned',
  attendance_checked: 'Attendance checked',
  job_inspected: 'Job inspected',
  closed: 'Closed',
};

/** What the higher level can do, and the stage each action needs. */
export const MANAGEMENT_ACTIONS = {
  assign: { from: ['reported', 'assigned'], to: 'assigned', label: 'Assign' },
  actioned: { from: ['assigned'], to: 'actioned', label: 'Record the work as done' },
  attendance_checked: { from: ['actioned'], to: 'attendance_checked', label: 'Confirm the assignee attended' },
  close: { from: ['job_inspected'], to: 'closed', label: 'Close and sign off' },
} as const satisfies Record<string, { from: readonly Stage[]; to: Stage; label: string }>;
export type ManagementAction = keyof typeof MANAGEMENT_ACTIONS;

/** What an officer on site can record when following up (section 6.6). */
export const FOLLOW_UP_OUTCOMES = {
  not_started: 'Not started yet',
  in_progress: 'Work in progress',
  done_ok: 'Repair done, all OK',
  not_fixed: 'Not fixed',
} as const;
export type FollowUpOutcome = keyof typeof FOLLOW_UP_OUTCOMES;

export type FollowUpEffect =
  | { kind: 'note_only' }
  | { kind: 'move'; to: Stage; history: string }
  | { kind: 'refused'; reason: string };

/**
 * What a follow-up does to the report.
 * - "Repair done, all OK" after attendance has been checked completes Job inspected.
 * - "Not fixed" after the work was actioned sends the report back to Assigned.
 * - Anything else is added to the history and flagged for the higher level.
 * Follow-ups are possible any time once the report is assigned, and not once closed.
 */
export function followUpEffect(stage: Stage, outcome: FollowUpOutcome): FollowUpEffect {
  if (stage === 'reported') return { kind: 'refused', reason: 'You can follow up once the report has been assigned.' };
  if (stage === 'closed') return { kind: 'refused', reason: 'This report is closed.' };
  if (outcome === 'done_ok' && stage === 'attendance_checked') return { kind: 'move', to: 'job_inspected', history: 'Job inspected: done.' };
  if (outcome === 'not_fixed' && (stage === 'actioned' || stage === 'attendance_checked' || stage === 'job_inspected')) {
    return { kind: 'move', to: 'assigned', history: 'Not fixed: sent back to Assigned.' };
  }
  return { kind: 'note_only' };
}

/** Who a report goes to, by priority, unless a site sets its own (section 6.6). */
export interface Routing {
  green: string[];
  amber: string[];
  red: string[];
}
export const DEFAULT_ROUTING: Routing = {
  green: ['site_supervisor'],
  amber: ['site_supervisor'],
  red: ['site_supervisor', 'site_manager'],
};

/** Colours for report badges (section 24). Each open report holds one; closing frees it. */
export const REPORT_COLOURS = ['#2563eb', '#db2777', '#0d9488', '#7c3aed', '#ea580c', '#65a30d', '#0891b2', '#b45309', '#4f46e5', '#be123c'] as const;

/**
 * The colour for a new report: the lowest slot no open report holds. If every
 * colour is in use, cycle by report number so neighbours still differ.
 */
export function pickColourSlot(openSlots: number[], reportNumber: number): number {
  const taken = new Set(openSlots);
  for (let i = 0; i < REPORT_COLOURS.length; i++) if (!taken.has(i)) return i;
  return reportNumber % REPORT_COLOURS.length;
}
