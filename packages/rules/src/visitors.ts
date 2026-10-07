/**
 * Visitor management (spec of 3 Oct 2026; plan approved 7 Oct 2026), step 1: the groundwork.
 * The checks a site can switch on or off, the time limits, the visitor categories and the
 * barred list. Nothing here is hard-coded per site: these are the starting values only.
 */

/** The checks a site can switch on or off, in the order of the spec's table. */
export const VISITOR_CHECKS = [
  'expiredLicenceOk',
  'barredList',
  'stolenVehicle',
  'cellPin',
  'paxCount',
  'exitMatch',
  'facePhoto',
  'documents',
  'entryLimit',
  'overstayAlert',
  'rollCall',
] as const;
export type VisitorCheck = (typeof VISITOR_CHECKS)[number];

export interface VisitorCheckInfo {
  label: string;
  /** What it does when it is on. */
  about: string;
  /** The starting position for a new site. */
  default: boolean;
  /** Why it cannot be switched on yet, when it cannot. */
  notYet?: string;
}

export const VISITOR_CHECK_INFO: Record<VisitorCheck, VisitorCheckInfo> = {
  expiredLicenceOk: { label: 'Expired licence acceptable', about: 'An expired driver’s licence or licence disc is ignored. When off, the guard gets a warning and decides.', default: true },
  barredList: { label: 'Barred list', about: 'Compares the ID number, cell number and number plate with the barred list. A match blocks entry and alerts the supervisor.', default: true },
  stolenVehicle: { label: 'Stolen vehicle lookup', about: 'Checks the number plate against a stolen vehicle database.', default: false, notYet: 'No lookup provider has been contracted yet.' },
  cellPin: { label: 'Cell number PIN', about: 'Sends a one-time PIN to an announced visitor’s cell number to confirm it.', default: false, notYet: 'On Par does not send SMS messages yet.' },
  paxCount: { label: 'Passenger count', about: 'The guard must enter the number of passengers on the way in and on the way out.', default: true },
  exitMatch: { label: 'Exit match', about: 'The person and the vehicle leaving must match the way in.', default: true },
  facePhoto: { label: 'Face photo for pedestrians', about: 'A visitor on foot cannot be saved without a photo of their face.', default: true },
  documents: { label: 'Documents', about: 'Shows site rules or an indemnity for the visitor to accept on the gate phone.', default: false, notYet: 'This follows in a later version.' },
  entryLimit: { label: 'One entry for a once-off announcement', about: 'A once-off announced visitor is let in once only.', default: true },
  overstayAlert: { label: 'Overstay alert', about: 'Flags visitors still on site past the time limit for their category.', default: true },
  rollCall: { label: 'Emergency roll-call', about: 'Gives the supervisor a list of everyone on site to tick off at an assembly point.', default: true },
};

export type VisitorChecks = Record<VisitorCheck, boolean>;

/** A site's visitor settings. A site that has never saved any uses DEFAULT_VISITOR_SETTINGS. */
export interface VisitorSettings {
  checks: VisitorChecks;
  /** How long the customer has to answer the alert before the guard is offered the phone. */
  noResponseSeconds: number;
  /** Whether the guard may dial the customer's second contact after no answer. */
  secondContact: boolean;
  /** How long after the guard is alerted to an overstay the supervisor is told. */
  overstayEscalationMinutes: number;
  /** How long visit records and face photos are kept. A proposal for legal to confirm. */
  retentionMonths: number;
}

export const VISITOR_LIMITS = {
  noResponseSeconds: { min: 30, max: 600 },
  overstayEscalationMinutes: { min: 5, max: 240 },
  retentionMonths: { min: 1, max: 120 },
  /** A category's "hours on site" limit, in minutes. */
  limitMinutes: { min: 15, max: 7 * 24 * 60 },
} as const;

export const DEFAULT_VISITOR_SETTINGS: VisitorSettings = {
  checks: Object.fromEntries(VISITOR_CHECKS.map((c) => [c, VISITOR_CHECK_INFO[c].default])) as VisitorChecks,
  noResponseSeconds: 120,
  secondContact: true,
  overstayEscalationMinutes: 30,
  retentionMonths: 12,
};

/** Field-by-field problems with a site's visitor settings; empty when they are fine. */
export function visitorSettingsErrors(s: VisitorSettings): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const c of VISITOR_CHECKS) {
    const why = VISITOR_CHECK_INFO[c].notYet;
    if (s.checks[c] && why) errors[`checks.${c}`] = `${VISITOR_CHECK_INFO[c].label} cannot be switched on yet. ${why}`;
  }
  const range = (key: 'noResponseSeconds' | 'overstayEscalationMinutes' | 'retentionMonths', unit: string) => {
    const { min, max } = VISITOR_LIMITS[key];
    if (!Number.isInteger(s[key]) || s[key] < min || s[key] > max) errors[key] = `Enter a whole number from ${min} to ${max} ${unit}.`;
  };
  range('noResponseSeconds', 'seconds');
  range('overstayEscalationMinutes', 'minutes');
  range('retentionMonths', 'months');
  return errors;
}

/**
 * How a category's approval lasts: one entry; until the customer removes the visitor; or
 * between a start and an end date.
 */
export const CATEGORY_KINDS = ['once_off', 'regular', 'fixed_period'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];
export const CATEGORY_KIND_LABELS: Record<CategoryKind, string> = {
  once_off: 'One entry',
  regular: 'Until the customer removes them',
  fixed_period: 'Between a start and an end date',
};

export interface VisitorCategory {
  name: string;
  kind: CategoryKind;
  contractor: boolean;
  /** Overstay limit as time on site, in minutes; or null. */
  limitMinutes: number | null;
  /** Overstay limit as a time of day ("17:00"); or null. At most one of the two limits is set. */
  limitUntil: string | null;
}

/** The five categories every site starts with. The administrator can change them and add more. */
export const DEFAULT_VISITOR_CATEGORIES: readonly VisitorCategory[] = [
  { name: 'Once-off visitor', kind: 'once_off', contractor: false, limitMinutes: 240, limitUntil: null },
  { name: 'Regular visitor', kind: 'regular', contractor: false, limitMinutes: null, limitUntil: null },
  { name: 'Contractor, once-off', kind: 'once_off', contractor: true, limitMinutes: null, limitUntil: '17:00' },
  { name: 'Regular contractor', kind: 'regular', contractor: true, limitMinutes: null, limitUntil: '17:00' },
  { name: 'Contractor, fixed period', kind: 'fixed_period', contractor: true, limitMinutes: null, limitUntil: '17:00' },
];

export function visitorCategoryErrors(c: VisitorCategory): Record<string, string> {
  const errors: Record<string, string> = {};
  if (c.name.trim().length < 2) errors.name = 'Enter a name for the category.';
  if (c.limitMinutes !== null && c.limitUntil !== null) errors.limitUntil = 'Choose time on site or a time of day, not both.';
  const { min, max } = VISITOR_LIMITS.limitMinutes;
  if (c.limitMinutes !== null && (!Number.isInteger(c.limitMinutes) || c.limitMinutes < min || c.limitMinutes > max)) errors.limitMinutes = 'Enter a time from 15 minutes to 7 days.';
  if (c.limitUntil !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(c.limitUntil)) errors.limitUntil = 'Enter a time of day, for example 17:00.';
  return errors;
}

/** A category's overstay limit in words, for lists. */
export function categoryLimitText(c: Pick<VisitorCategory, 'limitMinutes' | 'limitUntil'>): string {
  if (c.limitUntil) return `Until ${c.limitUntil}`;
  if (c.limitMinutes === null) return 'No limit';
  const h = Math.floor(c.limitMinutes / 60);
  const m = c.limitMinutes % 60;
  const hours = h ? `${h} hour${h === 1 ? '' : 's'}` : '';
  const mins = m ? `${m} minutes` : '';
  return [hours, mins].filter(Boolean).join(' ');
}

/** What a barred-list entry identifies someone or something by. */
export const BARRED_KINDS = ['id_number', 'cell', 'registration'] as const;
export type BarredKind = (typeof BARRED_KINDS)[number];
export const BARRED_KIND_LABELS: Record<BarredKind, string> = { id_number: 'ID number', cell: 'Cell number', registration: 'Number plate' };

/** A number plate as it is compared: capitals and digits only ("ca 123-456" and "CA123456" are the same plate). */
export function normalisePlate(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** A cell number as it is compared: digits only, South African numbers in the local form ("+27 82 555 0140" is "0825550140"). */
export function normaliseCell(text: string): string {
  const digits = text.replace(/\D/g, '');
  if (digits.startsWith('0027')) return `0${digits.slice(4)}`;
  if (digits.startsWith('27') && digits.length === 11) return `0${digits.slice(2)}`;
  return digits;
}

/** An ID or passport number as it is compared: capitals and digits only. */
export function normaliseIdNumber(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * The value of a barred-list entry in its compared form, or the reason it cannot be used.
 * Passports and foreign IDs are allowed, so an ID number is not held to the South African format.
 */
export function barredValue(kind: BarredKind, text: string): { value: string } | { error: string } {
  if (kind === 'registration') {
    const value = normalisePlate(text);
    return value.length >= 2 && value.length <= 12 ? { value } : { error: 'Enter the number plate.' };
  }
  if (kind === 'cell') {
    const value = normaliseCell(text);
    return value.length >= 9 && value.length <= 15 ? { value } : { error: 'Enter the full cell number.' };
  }
  const value = normaliseIdNumber(text);
  return value.length >= 5 && value.length <= 20 ? { value } : { error: 'Enter the ID or passport number.' };
}

// --- Step 2: scanning a visitor in ------------------------------------------------------------

export const VISIT_TYPES = ['vehicle', 'pedestrian'] as const;
export type VisitType = (typeof VISIT_TYPES)[number];

/** The spec's visit statuses. */
export const VISIT_STATUSES = ['awaiting_approval', 'on_site', 'exited', 'exited_exception', 'denied', 'denied_no_response', 'left_no_scan_out'] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];
export const VISIT_STATUS_LABELS: Record<VisitStatus, string> = {
  awaiting_approval: 'Awaiting approval',
  on_site: 'On site',
  exited: 'Exited',
  exited_exception: 'Exited with exception',
  denied: 'Denied',
  denied_no_response: 'Denied, no response',
  left_no_scan_out: 'Left without scan-out',
};

/** The document the visitor was identified from. */
export const IDENTITY_DOCUMENTS = ['id_card', 'id_book', 'drivers_licence', 'passport', 'other'] as const;
export type IdentityDocument = (typeof IDENTITY_DOCUMENTS)[number];
export const IDENTITY_DOCUMENT_LABELS: Record<IdentityDocument, string> = {
  id_card: 'ID card',
  id_book: 'ID book',
  drivers_licence: 'Driver’s licence',
  passport: 'Passport',
  other: 'Other document',
};

/** How a document's details got onto the phone: read from its barcode, or typed by the guard with a photo. */
export const CAPTURE_METHODS = ['scan', 'manual'] as const;
export type CaptureMethod = (typeof CAPTURE_METHODS)[number];

/** What the guard must be warned about before asking for approval. He decides, and his choice is recorded. */
export const VISIT_WARNINGS = ['licence_expired', 'disc_expired'] as const;
export type VisitWarning = (typeof VISIT_WARNINGS)[number];
export const VISIT_WARNING_TEXT: Record<VisitWarning, string> = {
  licence_expired: 'The driver’s licence has expired.',
  disc_expired: 'The vehicle’s licence disc has expired.',
};

/**
 * The warnings for a visit. With "Expired licence acceptable" on, an expired licence or disc
 * is ignored. `today` and the dates are YYYY-MM-DD in South African time.
 */
export function visitWarnings(checks: Pick<VisitorChecks, 'expiredLicenceOk'>, today: string, licenceExpiry: string | null, discExpiry: string | null): VisitWarning[] {
  if (checks.expiredLicenceOk) return [];
  const out: VisitWarning[] = [];
  if (licenceExpiry && licenceExpiry < today) out.push('licence_expired');
  if (discExpiry && discExpiry < today) out.push('disc_expired');
  return out;
}

// --- Step 3: approval -------------------------------------------------------------------------

/** How a visit was approved or refused: in the customer app, or by phone at the gate. */
export const APPROVAL_METHODS = ['push', 'phone'] as const;
export type ApprovalMethod = (typeof APPROVAL_METHODS)[number];

/** What the guard records after phoning the customer. */
export const CALL_OUTCOMES = ['approved', 'denied', 'no_answer'] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
export const CALL_OUTCOME_LABELS: Record<CallOutcome, string> = { approved: 'Approved by phone', denied: 'Denied by phone', no_answer: 'No answer' };

/** Which of the customer's numbers the gate phoned. */
export const CALL_CONTACTS = ['primary', 'second'] as const;
export type CallContact = (typeof CALL_CONTACTS)[number];

/** A visitor's name for lists and alerts: "Dlamini, T J". */
export function visitorName(surname: string, names: string): string {
  return [surname.trim(), names.trim()].filter(Boolean).join(', ');
}

/** A vehicle in one line: "CA123456 White Toyota Corolla". */
export function vehicleLine(v: { registration: string; colour?: string | null; make?: string | null; model?: string | null }): string {
  return [v.registration, v.colour, v.make, v.model].filter(Boolean).join(' ');
}

// --- Step 4: announced visitors ---------------------------------------------------------------

/** A pass: one visit on a date, or a regular on set days and hours. */
export const PASS_KINDS = ['once', 'ongoing'] as const;
export type PassKind = (typeof PASS_KINDS)[number];

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export interface PassInput {
  kind: PassKind;
  visitorName: string;
  /** How the category's approval lasts (from the site's category list). */
  categoryKind: CategoryKind;
  idNumber: string;
  cell: string;
  registration: string;
  /** YYYY-MM-DD, for one visit. */
  visitDate: string | null;
  /** HH:MM, optional, for one visit. */
  time: string | null;
  /** 1 Monday to 7 Sunday; empty means every day. */
  days: number[];
  hoursFrom: string | null;
  hoursTo: string | null;
  startDate: string | null;
  endDate: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Field-by-field problems with a pass a customer is making; empty when it is fine. `today` is YYYY-MM-DD in South Africa. */
export function passErrors(p: PassInput, today: string): Record<string, string> {
  const e: Record<string, string> = {};
  if (p.visitorName.trim().length < 2) e.visitorName = 'Enter the visitor’s name.';
  // The gate must be able to recognise the visitor: at least one of the three.
  const id = normaliseIdNumber(p.idNumber);
  const cell = normaliseCell(p.cell);
  const reg = normalisePlate(p.registration);
  if (!id && !cell && !reg) e.identifier = 'Give at least one: their ID number, cell number or number plate.';
  if (id && (id.length < 5 || id.length > 20)) e.idNumber = 'Enter the full ID or passport number.';
  if (cell && (cell.length < 9 || cell.length > 15)) e.cell = 'Enter the full cell number.';
  if (reg && (reg.length < 2 || reg.length > 12)) e.registration = 'Enter the number plate.';
  if (p.kind === 'once') {
    if (p.categoryKind !== 'once_off') e.categoryId = 'Choose a kind of visitor that is for one visit.';
    if (!p.visitDate || !DAY.test(p.visitDate)) e.visitDate = 'Choose the day they are coming.';
    else if (p.visitDate < today) e.visitDate = 'That day has passed.';
    if (p.time !== null && !CLOCK.test(p.time)) e.time = 'Enter the time, for example 14:30.';
  } else {
    if (p.categoryKind === 'once_off') e.categoryId = 'Choose a kind of visitor that comes regularly.';
    if (p.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) e.days = 'Choose the days of the week.';
    if ((p.hoursFrom === null) !== (p.hoursTo === null)) e.hoursTo = 'Give both the start and the end time, or neither.';
    else if (p.hoursFrom !== null && p.hoursTo !== null) {
      if (!CLOCK.test(p.hoursFrom) || !CLOCK.test(p.hoursTo)) e.hoursTo = 'Enter the times, for example 08:00 and 17:00.';
      else if (p.hoursTo <= p.hoursFrom) e.hoursTo = 'The end time must be after the start time.';
    }
    for (const k of ['startDate', 'endDate'] as const) if (p[k] !== null && !DAY.test(p[k] as string)) e[k] = 'Choose a date.';
    // A fixed-period contractor has a first and a last day.
    if (p.categoryKind === 'fixed_period') {
      if (!p.startDate) e.startDate ??= 'Choose the first day.';
      if (!p.endDate) e.endDate ??= 'Choose the last day.';
    }
    if (p.startDate && p.endDate && !e.startDate && !e.endDate && p.endDate < p.startDate) e.endDate = 'The last day must be on or after the first day.';
    if (p.endDate && !e.endDate && p.endDate < today) e.endDate = 'That day has passed.';
  }
  return e;
}

/** When a pass applies, in words: "Wed 7 Oct, about 14:30" or "Mon, Wed, Fri, 08:00 to 17:00, until 2026-11-20". */
export function passWhen(p: { kind: PassKind; visitDate: string | null; time: string | null; days: number[] | null; hoursFrom: string | null; hoursTo: string | null; startDate: string | null; endDate: string | null }): string {
  if (p.kind === 'once') return [p.visitDate ?? '', p.time ? `about ${p.time}` : 'any time'].filter(Boolean).join(', ');
  const days = p.days && p.days.length && p.days.length < 7 ? [...p.days].sort((a, b) => a - b).map((d) => WEEKDAYS[d - 1]).join(', ') : 'Every day';
  const hours = p.hoursFrom && p.hoursTo ? `${p.hoursFrom} to ${p.hoursTo}` : 'any time';
  const dates = p.startDate && p.endDate ? `${p.startDate} to ${p.endDate}` : p.endDate ? `until ${p.endDate}` : p.startDate ? `from ${p.startDate}` : '';
  return [days, hours, dates].filter(Boolean).join(', ');
}

// --- Step 5: leaving and exceptions -----------------------------------------------------------

/** What can go wrong when a visitor leaves (the spec's four), and a visitor found to have left without being scanned out. */
export const EXCEPTION_TYPES = ['driver_mismatch', 'vehicle_mismatch', 'pax_mismatch', 'no_open_visit', 'no_scan_out'] as const;
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];
export const EXCEPTION_LABELS: Record<ExceptionType, string> = {
  driver_mismatch: 'Different driver',
  vehicle_mismatch: 'Different vehicle',
  pax_mismatch: 'Passenger count differs',
  no_open_visit: 'Not recorded as on site',
  no_scan_out: 'Left without scan-out',
};
/** What the guard is told, in a sentence. */
export const EXCEPTION_TEXT: Record<ExceptionType, string> = {
  driver_mismatch: 'The vehicle is leaving with a different driver from the one who came in.',
  vehicle_mismatch: 'The visitor is not leaving in the vehicle they came in with.',
  pax_mismatch: 'The number of passengers leaving is not the number that came in.',
  no_open_visit: 'Nobody with this ID or number plate is recorded as on site.',
  no_scan_out: 'This visitor is still recorded as on site from an earlier visit.',
};

/** The reasons a guard can pick. "Other" needs a note. */
export const EXCEPTION_REASONS = ['passenger_driving', 'passengers_stayed', 'passengers_added', 'vehicle_stayed', 'not_scanned_in', 'not_scanned_out', 'other'] as const;
export type ExceptionReason = (typeof EXCEPTION_REASONS)[number];
export const EXCEPTION_REASON_LABELS: Record<ExceptionReason, string> = {
  passenger_driving: 'A passenger is driving',
  passengers_stayed: 'Passengers stayed behind',
  passengers_added: 'Extra passengers leaving',
  vehicle_stayed: 'Vehicle left on site',
  not_scanned_in: 'Was not scanned in',
  not_scanned_out: 'Left earlier without being scanned out',
  other: 'Other (type a note)',
};

/** What the gate knows at the moment a visitor leaves. */
export interface ExitFacts {
  /** The open visit the scan found. Null: nobody recorded as on site matches. */
  visit: { type: VisitType; paxIn: number | null } | null;
  /** The person leaving is the one on the visit: by a scanned ID, or because the guard confirmed it. Null: not checked. */
  samePerson: boolean | null;
  /** The vehicle leaving is the one on the visit. For a visitor who came on foot: they are leaving on foot. */
  sameVehicle: boolean;
  paxOut: number | null;
}

/**
 * The exceptions an exit raises. "Exit match" covers the person and the vehicle; "Pax count"
 * covers the passengers. With a check off, that difference is not an exception.
 */
export function exitExceptions(checks: Pick<VisitorChecks, 'exitMatch' | 'paxCount'>, f: ExitFacts): ExceptionType[] {
  if (!f.visit) return ['no_open_visit'];
  const out: ExceptionType[] = [];
  if (checks.exitMatch && f.samePerson === false) out.push('driver_mismatch');
  if (checks.exitMatch && !f.sameVehicle) out.push('vehicle_mismatch');
  if (checks.paxCount && f.visit.type === 'vehicle' && f.sameVehicle && f.visit.paxIn !== null && f.paxOut !== null && f.paxOut !== f.visit.paxIn) out.push('pax_mismatch');
  return out;
}

/** What is wrong with the guard's handling of an exception; null when it is fine. A reason must be picked or a note typed. */
export function exceptionHandlingError(reason: string | null, note: string): string | null {
  if (reason !== null && !(EXCEPTION_REASONS as readonly string[]).includes(reason)) return 'Choose a reason from the list.';
  if (reason === 'other' && note.trim().length < 3) return 'Type a note to say what happened.';
  if (reason === null && note.trim().length < 3) return 'Choose a reason or type a note before you continue.';
  return null;
}
