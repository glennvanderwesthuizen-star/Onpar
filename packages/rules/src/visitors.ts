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
