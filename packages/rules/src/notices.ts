/**
 * HR notices (brief sections 6.16 and 28; owner's step 7, 8 Oct 2026). The app supports the
 * process and produces proof; it never decides anything and never creates a warning by itself.
 * Every template here is a DRAFT: a labour lawyer must approve the wording, the ladder, validity
 * periods and the process before real use (L-03).
 */

export const NOTICE_TYPES = [
  'verbal_warning',
  'written_warning',
  'severe_written_warning',
  'final_written_warning',
  'end_of_line_memo',
  'notice_to_appear',
  'hearing_outcome',
  'general_message',
] as const;
export type NoticeType = (typeof NOTICE_TYPES)[number];

export const NOTICE_TYPE_LABELS: Record<NoticeType, string> = {
  verbal_warning: 'Verbal warning record',
  written_warning: 'Written warning',
  severe_written_warning: 'Severe written warning',
  final_written_warning: 'Final written warning',
  end_of_line_memo: 'End of line memorandum',
  notice_to_appear: 'Notice to appear for a disciplinary inquiry',
  hearing_outcome: 'Hearing outcome',
  general_message: 'General message',
};

/** The warnings, in order: the template counts how many of each are already on file. */
export const WARNING_LADDER: NoticeType[] = ['verbal_warning', 'written_warning', 'severe_written_warning', 'final_written_warning'];

/** The employee's rights at a disciplinary inquiry, as the brief lists them (section 28). For the lawyer to approve. */
export const INQUIRY_RIGHTS = [
  'To be told of the charge in a language and terms you understand.',
  'To have reasonable time to prepare.',
  'To be represented by a fellow employee or a shop steward.',
  'To have an interpreter if you need one (owner, 9 Oct 2026; tell HR before the inquiry).',
  'To state your case and to question the witnesses.',
  'To receive the outcome in writing, with reasons, and to appeal.',
];

/** Shown on every notice, and on the button: acknowledging receipt is not admitting anything. */
export const ACK_TEXT = 'I acknowledge that I have received this notice. This does not mean I agree with it or admit anything.';

/** The one line the shared post phone may show. Never the content (brief section 6.14). */
export const POST_DEVICE_LINE = 'You have a personal message. Open it on your own phone or see your supervisor.';
/** The same line when the company lets the signed-in guard open his notices on the post phone (owner, 9 Oct 2026, D-52). */
export const POST_PHONE_LINE = 'You have a message from HR. Open MY MESSAGES to read it.';

export const DEFAULT_ACK_HOURS = 48;

export interface NoticeDetails {
  /** What the employee is charged with or warned about. */
  charge?: string;
  incidentDate?: string;
  hearingDate?: string;
  hearingTime?: string;
  venue?: string;
  chairperson?: string;
  witnesses?: string[];
  representative?: string;
  outcome?: string;
  sanction?: string;
  /** The warnings on file, for an end of line memorandum or a notice to appear. */
  warnings?: WarningLine[];
  /** The documents that go with a notice to appear (listed in it). */
  attachments?: string[];
}

/** One warning on file, as it is quoted in later notices. */
export interface WarningLine {
  label: string;
  /** When it was issued, YYYY-MM-DD. */
  date: string;
  charge: string;
}

const warningList = (ws: WarningLine[]) => ws.map((w, i) => `${i + 1}. ${w.label}, ${w.date}: ${w.charge}`).join('\n');

export interface NoticeContext {
  companyName: string;
  employeeName: string;
  employeeNumber: string;
  siteName: string | null;
  /** Today, YYYY-MM-DD. */
  date: string;
  issuedBy: string;
  /** How many notices of this type are already on file for the employee. */
  prior: number;
  details: NoticeDetails;
}

const ordinal = (n: number) => (n === 1 ? 'first' : n === 2 ? 'second' : n === 3 ? 'third' : `${n}th`);

/** A draft subject and text for the notice, filled from the employee's record. HR edits it before sending. */
export function noticeTemplate(type: NoticeType, c: NoticeContext): { subject: string; body: string } {
  const d = c.details;
  const head = `${c.companyName}\nTo: ${c.employeeName} (employee number ${c.employeeNumber})${c.siteName ? `, ${c.siteName}` : ''}\nDate: ${c.date}\n\n`;
  const charge = d.charge?.trim() || '[describe what happened]';
  const when = d.incidentDate ? ` on ${d.incidentDate}` : '';
  const prior = c.prior ? `\n\nThere ${c.prior === 1 ? 'is' : 'are'} already ${c.prior} ${NOTICE_TYPE_LABELS[type].toLowerCase()}${c.prior === 1 ? '' : 's'} on your file. This is your ${ordinal(c.prior + 1)}.` : '';
  const sign = `\n\n${c.issuedBy}`;
  const warning = (what: string, validity: string) => ({
    subject: `${NOTICE_TYPE_LABELS[type]}: ${d.charge?.trim() || 'conduct'}`,
    body: `${head}This is a ${what} about the following${when}: ${charge}.${prior}\n\n${validity} You may add your side in writing within five working days; it will be kept with this notice.${sign}`,
  });
  switch (type) {
    case 'verbal_warning':
      return warning('record of a verbal warning', 'This record stays on your file for [validity period].');
    case 'written_warning':
      return warning('written warning', 'This warning is valid for [validity period]. A further offence of this kind may lead to a more serious warning.');
    case 'severe_written_warning':
      return warning('severe written warning', 'This warning is valid for [validity period]. A further offence may lead to a final written warning.');
    case 'final_written_warning':
      return warning('final written warning', 'This warning is valid for [validity period]. A further offence may lead to a disciplinary inquiry and dismissal.');
    case 'end_of_line_memo':
      return {
        subject: `End of line memorandum: ${d.charge?.trim() || 'conduct'}`,
        body: d.warnings?.length
          ? `${head}You have received the following warnings:\n${warningList(d.warnings)}\n\nYou have reached the end of the line with us. Any further misconduct will lead to a disciplinary inquiry, which may result in your dismissal. If you would like help to improve, speak to your supervisor or HR.${sign}`
          : `${head}You have reached the end of the warning ladder for the following${when}: ${charge}.${prior}\n\nThe next step is a disciplinary inquiry. You will receive a separate notice to appear.${sign}`,
      };
    case 'notice_to_appear': {
      const witnesses = (d.witnesses ?? []).filter((w) => w.trim());
      return {
        subject: `Notice to appear for a disciplinary inquiry on ${d.hearingDate || '[date]'}`,
        body:
          `${head}You are required to attend a disciplinary inquiry.\n\n` +
          `Charge: ${charge}${when}.\n` +
          `Date: ${d.hearingDate || '[date]'}\nTime: ${d.hearingTime || '[time]'}\nVenue: ${d.venue || '[venue]'}\n` +
          (d.chairperson ? `Chairperson: ${d.chairperson}\n` : '') +
          (d.warnings?.length ? `\nWarnings on your file:\n${warningList(d.warnings)}\n` : '') +
          `\nYour rights:\n${INQUIRY_RIGHTS.map((r) => `- ${r}`).join('\n')}\n` +
          (d.attachments?.length ? `\nAttached, to read before the inquiry:\n${d.attachments.map((a) => `- ${a}`).join('\n')}\n` : '') +
          (witnesses.length ? `\nWitnesses the company intends to call:\n${witnesses.map((w) => `- ${w}`).join('\n')}\n` : '') +
          `\nYour representative: ${d.representative?.trim() || 'please tell HR before the inquiry'}.${sign}`,
      };
    }
    case 'hearing_outcome':
      return {
        subject: `Outcome of the disciplinary inquiry${d.hearingDate ? ` of ${d.hearingDate}` : ''}`,
        body: `${head}Charge: ${charge}.\n\nFinding: ${d.outcome?.trim() || '[finding, with reasons]'}\nSanction: ${d.sanction?.trim() || '[sanction]'}\n\nYou may appeal in writing within [appeal period].${sign}`,
      };
    case 'general_message':
      return { subject: d.charge?.trim() || 'A message from HR', body: `${head}[Your message]${sign}` };
  }
}

/** What is wrong with a notice before it is sent; null when it can be sent. */
export function noticeErrors(type: NoticeType, subject: string, body: string, d: NoticeDetails): Record<string, string> | null {
  const e: Record<string, string> = {};
  if (subject.trim().length < 3) e.subject = 'Write a subject.';
  if (body.trim().length < 20) e.body = 'Write the notice.';
  if (/\[(describe what happened|validity period|date|time|venue|finding, with reasons|sanction|appeal period|Your message)\]/.test(body)) e.body = 'Fill in or remove every part in [square brackets] before sending.';
  if (type === 'notice_to_appear') {
    if (!d.hearingDate) e.hearingDate = 'Choose the date of the inquiry.';
    if (!d.hearingTime) e.hearingTime = 'Enter the time.';
    if (!d.venue?.trim()) e.venue = 'Enter the venue.';
    if (!d.charge?.trim()) e.charge = 'Write the charge.';
  }
  if (type !== 'general_message' && type !== 'hearing_outcome' && !d.charge?.trim()) e.charge = 'Write what the notice is about.';
  if (type === 'hearing_outcome' && !d.outcome?.trim()) e.outcome = 'Write the finding.';
  return Object.keys(e).length ? e : null;
}

export const NOTICE_EVENTS = ['sent', 'delivered', 'opened', 'acknowledged', 'hand_delivery_requested', 'hand_delivered'] as const;
export type NoticeEventKind = (typeof NOTICE_EVENTS)[number];
export const NOTICE_EVENT_LABELS: Record<NoticeEventKind, string> = {
  sent: 'Sent',
  delivered: 'Delivered',
  opened: 'Opened',
  acknowledged: 'Acknowledged',
  hand_delivery_requested: 'Hand delivery needed',
  hand_delivered: 'Delivered by hand',
};

/** Where a notice stands, from its events: the furthest it has gone. */
export function noticeStatus(events: { kind: NoticeEventKind }[]): NoticeEventKind {
  const has = (k: NoticeEventKind) => events.some((e) => e.kind === k);
  if (has('acknowledged')) return 'acknowledged';
  if (has('hand_delivered')) return 'hand_delivered';
  if (has('hand_delivery_requested')) return 'hand_delivery_requested';
  if (has('opened')) return 'opened';
  if (has('delivered')) return 'delivered';
  return 'sent';
}

/** Whether HR must now arrange hand delivery: sent more than the period ago and not acknowledged or delivered by hand. */
export function needsHandDelivery(sentAt: Date, events: { kind: NoticeEventKind }[], ackHours: number, now: Date): boolean {
  const status = noticeStatus(events);
  if (status === 'acknowledged' || status === 'hand_delivered' || status === 'hand_delivery_requested') return false;
  return now.getTime() - sentAt.getTime() >= ackHours * 3600_000;
}

/**
 * Patterns HR may want to look at (brief section 28). A suggestion only pre-fills the notice
 * form; it never issues, sends or creates anything. The thresholds are drafts for the owner.
 */
export interface SuggestionFacts {
  lateArrivals30: number;
  missedTasks30: number;
  /** Any warning on file in the last 90 days. */
  recentWarning: boolean;
}
export const SUGGESTION_RULES = { lateArrivals: 3, missedTasks: 5, days: 30 } as const;

export function suggestedActions(f: SuggestionFacts): { pattern: string; suggest: NoticeType; charge: string }[] {
  if (f.recentWarning) return [];
  const out: { pattern: string; suggest: NoticeType; charge: string }[] = [];
  if (f.lateArrivals30 >= SUGGESTION_RULES.lateArrivals)
    out.push({ pattern: `${f.lateArrivals30} late arrivals in the last ${SUGGESTION_RULES.days} days and no warning on file`, suggest: 'verbal_warning', charge: `Late for duty ${f.lateArrivals30} times in the last ${SUGGESTION_RULES.days} days` });
  if (f.missedTasks30 >= SUGGESTION_RULES.missedTasks)
    out.push({ pattern: `${f.missedTasks30} tasks missed in the last ${SUGGESTION_RULES.days} days and no warning on file`, suggest: 'verbal_warning', charge: `${f.missedTasks30} duties not done in the last ${SUGGESTION_RULES.days} days` });
  return out;
}


// --- Repeated warnings and the disciplinary inquiry (owner, 9 Oct 2026; D-53) --------------------

/** Draft defaults for the owner and the labour lawyer: how many warnings call for action, over how long, and the notice for an inquiry. */
export const DEFAULT_DISCIPLINE = { warningThreshold: 3, warningMonths: 12, hearingMinDays: 3 } as const;

/** Whether this many warnings in the period calls for the manager to act (an alert and a choice; never automatic). */
export function warningsNeedAction(count: number, threshold: number): boolean {
  return count >= threshold;
}

/** The inquiry must be at least the set number of days after the notice is sent. Dates YYYY-MM-DD. */
export function hearingDateError(hearingDate: string | undefined, today: string, minDays: number): string | null {
  if (!hearingDate) return 'Choose the date of the inquiry.';
  const days = (Date.parse(`${hearingDate}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000;
  if (days < minDays) return `The inquiry must be at least ${minDays} days from today, so the employee has time to prepare.`;
  return null;
}

export interface CaseContext {
  companyName: string;
  employeeName: string;
  employeeNumber: string;
  date: string;
  charge: string;
  hearingDate: string;
  hearingTime: string;
  venue: string;
  chairperson?: string;
}

/**
 * The documents that go with a notice to appear (owner, 9 Oct 2026): the employee's rights at a
 * disciplinary inquiry, his right to call witnesses, and his right to an interpreter. Drafts for
 * the labour lawyer, filled in from the case.
 */
export function inquiryDocuments(c: CaseContext): { title: string; body: string }[] {
  const head = `${c.companyName}\nEmployee: ${c.employeeName} (employee number ${c.employeeNumber})\nInquiry: ${c.hearingDate} at ${c.hearingTime}, ${c.venue}\nCharge: ${c.charge}\n\n`;
  return [
    {
      title: 'Your rights as an employee facing a disciplinary inquiry',
      body:
        head +
        'At the inquiry you have the right:\n' +
        INQUIRY_RIGHTS.map((r, i) => `${i + 1}. ${r}`).join('\n') +
        `\n\nThe inquiry will be chaired by ${c.chairperson?.trim() || 'a person who was not involved in the matter'}. If you do not attend without a good reason, the inquiry may go ahead without you.`,
    },
    {
      title: 'Your right to call witnesses',
      body:
        head +
        'You may call witnesses to support your side. Give HR their names before the inquiry so that they can be released from duty to attend. ' +
        'You or your representative may question the company\'s witnesses, and the company may question yours. A witness only tells what he or she saw or knows.',
    },
    {
      title: 'Your right to an interpreter',
      body:
        head +
        'If you are not comfortable with the language of the inquiry, you may ask for an interpreter. Tell HR before the inquiry, and say which language you need. ' +
        'The interpreter repeats what is said, word for word, and takes no side.',
    },
  ];
}

/** The findings and sanctions on the inquiry form. Drafts: the lawyer confirms which sanctions apply. */
export const HEARING_FINDINGS = { guilty: 'Guilty', not_guilty: 'Not guilty' } as const;
export type HearingFinding = keyof typeof HEARING_FINDINGS;
export const HEARING_SANCTIONS = {
  none: 'No sanction',
  written_warning: 'Written warning',
  final_written_warning: 'Final written warning',
  suspension: 'Suspension without pay',
  dismissal: 'Dismissal',
  other: 'Other (described)',
} as const;
export type HearingSanction = keyof typeof HEARING_SANCTIONS;

/** The disciplinary inquiry form (owner, 9 Oct 2026: our own form for now). */
export interface HearingRecord {
  heldOn?: string;
  chairperson?: string;
  initiator?: string;
  employeePresent?: boolean;
  representative?: string;
  interpreter?: string;
  witnesses?: string;
  plea?: 'guilty' | 'not_guilty' | '';
  companyCase?: string;
  employeeCase?: string;
  mitigating?: string;
  aggravating?: string;
  finding?: HearingFinding | '';
  reasons?: string;
  sanction?: HearingSanction | '';
  sanctionNote?: string;
}

/** What is still missing before a decision can be published; null when it can be. */
export function hearingRecordErrors(h: HearingRecord): Record<string, string> | null {
  const e: Record<string, string> = {};
  if (!h.heldOn) e.heldOn = 'Enter the date the inquiry was held.';
  if (!h.chairperson?.trim()) e.chairperson = 'Enter the chairperson.';
  if (!h.finding) e.finding = 'Choose the finding.';
  if (!h.reasons?.trim() || h.reasons.trim().length < 10) e.reasons = 'Give the reasons for the finding.';
  if (h.finding === 'guilty' && !h.sanction) e.sanction = 'Choose the sanction.';
  if (h.sanction === 'other' && !h.sanctionNote?.trim()) e.sanctionNote = 'Describe the sanction.';
  return Object.keys(e).length ? e : null;
}

/** The outcome notice, filled from the inquiry form. HR edits it before it is published. */
export function outcomeNotice(c: { companyName: string; employeeName: string; employeeNumber: string; date: string; charge: string; issuedBy: string }, h: HearingRecord): { subject: string; body: string } {
  const sanction = h.finding === 'guilty' ? (h.sanction === 'other' ? h.sanctionNote ?? '' : h.sanction ? HEARING_SANCTIONS[h.sanction] : '') : 'None';
  return {
    subject: `Outcome of the disciplinary inquiry of ${h.heldOn ?? ''}`.trim(),
    body:
      `${c.companyName}\nTo: ${c.employeeName} (employee number ${c.employeeNumber})\nDate: ${c.date}\n\n` +
      `The disciplinary inquiry held on ${h.heldOn ?? '[date]'}, chaired by ${h.chairperson ?? '[chairperson]'}, considered the charge: ${c.charge}.\n\n` +
      `Finding: ${h.finding ? HEARING_FINDINGS[h.finding] : '[finding]'}\nReasons: ${h.reasons ?? '[reasons]'}\n` +
      `Sanction: ${sanction}${h.sanction && h.sanction !== 'other' && h.sanctionNote ? ` (${h.sanctionNote})` : ''}\n\n` +
      `You may appeal in writing to HR within [appeal period] of receiving this outcome.\n\n${c.issuedBy}`,
  };
}
