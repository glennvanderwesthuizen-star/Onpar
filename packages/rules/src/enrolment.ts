import { validateSaId } from './sa-id';
import { qualificationStatus } from './qualifications';

/** PSIRA grades, A is the highest. */
export const PSIRA_GRADES = ['A', 'B', 'C', 'D', 'E'] as const;
export type PsiraGrade = (typeof PSIRA_GRADES)[number];
/**
 * The grades offered in forms (owner, 8 Oct 2026: in practice C, B and A, lowest first). D and E
 * stay valid so older records still load; whether they are still issued is PSIRA's to say.
 */
export const PSIRA_GRADES_IN_USE = ['C', 'B', 'A'] as const;

/** The four photos enrolment requires (brief section 6.12). */
export const REQUIRED_PHOTO_KINDS = ['face', 'full_body', 'id_document', 'psira_card'] as const;
export type PhotoKind = (typeof REQUIRED_PHOTO_KINDS)[number];

export const PHOTO_LABELS: Record<PhotoKind, string> = {
  face: 'Face close-up',
  full_body: 'Full body in uniform',
  id_document: 'ID document',
  psira_card: 'PSIRA card',
};

/** The qualification type that counts as firearm competency for armed sites. */
export const FIREARM_COMPETENCY = 'firearm_competency';

export function isPsiraGrade(g: unknown): g is PsiraGrade {
  return typeof g === 'string' && (PSIRA_GRADES as readonly string[]).includes(g);
}

/** True when `grade` meets or beats `minimum` (A beats B, and so on). */
export function gradeMeetsMinimum(grade: PsiraGrade, minimum: PsiraGrade): boolean {
  return PSIRA_GRADES.indexOf(grade) <= PSIRA_GRADES.indexOf(minimum);
}

export interface SiteRequirements {
  name: string;
  minimumGrade: PsiraGrade;
  armed: boolean;
}

export interface QualificationInput {
  type: string;
  expiryDate?: string | null;
}

export interface OfficerCheckInput {
  psiraGrade: PsiraGrade;
  qualifications: QualificationInput[];
}

/**
 * Warnings (not blocks) when an officer does not fit a site: grade below the
 * site minimum, or no valid firearm competency at an armed site. Used at
 * enrolment (section 6.12) and at roster allocation (section 39).
 */
export function siteFitWarnings(officer: OfficerCheckInput, site: SiteRequirements, today: string | Date): string[] {
  const warnings: string[] = [];
  if (!gradeMeetsMinimum(officer.psiraGrade, site.minimumGrade)) {
    warnings.push(
      `PSIRA grade ${officer.psiraGrade} is below ${site.name}'s minimum of grade ${site.minimumGrade}.`,
    );
  }
  if (site.armed) {
    const firearm = officer.qualifications.filter((q) => q.type === FIREARM_COMPETENCY);
    const valid = firearm.some((q) => qualificationStatus(q.expiryDate, today) !== 'EXPIRED');
    if (!valid) {
      warnings.push(
        firearm.length
          ? `${site.name} is an armed site and this officer's firearm competency has expired.`
          : `${site.name} is an armed site and this officer has no firearm competency on file.`,
      );
    }
  }
  return warnings;
}

export interface EnrolmentInput {
  fullName?: string;
  idNumber?: string;
  cellNumber?: string;
  nextOfKinName?: string;
  nextOfKinNumber?: string;
  psiraNumber?: string;
  psiraGrade?: string;
  psiraExpiry?: string;
  siteId?: string;
  photoKinds: string[];
}

/** SA phone numbers: 0XXXXXXXXX or +27XXXXXXXXX, spaces allowed. */
export function isSaPhoneNumber(n: string | undefined): boolean {
  if (!n) return false;
  return /^(0\d{9}|\+27\d{9})$/.test(n.replace(/[\s-]/g, ''));
}

/**
 * Everything that blocks enrolment (scenario 11): missing required fields,
 * an invalid ID number, or any of the four photos missing.
 * Returns field → message.
 */
export function enrolmentErrors(input: EnrolmentInput, today: Date = new Date()): Record<string, string> {
  const errors: Record<string, string> = {};
  const required: [keyof EnrolmentInput, string][] = [
    ['fullName', 'Full name'],
    ['idNumber', 'SA ID number'],
    ['cellNumber', 'Cell number'],
    ['nextOfKinName', 'Next of kin'],
    ['nextOfKinNumber', "Next of kin's number"],
    ['psiraNumber', 'PSIRA number'],
    ['psiraGrade', 'PSIRA grade'],
    ['psiraExpiry', 'PSIRA expiry'],
    ['siteId', 'Assigned site'],
  ];
  for (const [field, label] of required) {
    const v = input[field];
    if (typeof v !== 'string' || v.trim() === '') errors[field] = `${label} is required.`;
  }
  if (!errors.idNumber) {
    const id = validateSaId(input.idNumber!, today);
    if (!id.valid) errors.idNumber = id.reason;
  }
  if (!errors.cellNumber && !isSaPhoneNumber(input.cellNumber)) {
    errors.cellNumber = 'Enter a South African cell number, for example 082 555 0101.';
  }
  if (!errors.nextOfKinNumber && !isSaPhoneNumber(input.nextOfKinNumber)) {
    errors.nextOfKinNumber = 'Enter a South African number, for example 082 555 0101.';
  }
  if (!errors.psiraGrade && !isPsiraGrade(input.psiraGrade)) {
    errors.psiraGrade = 'PSIRA grade must be A, B, C, D or E.';
  }
  if (!errors.psiraExpiry && !/^\d{4}-\d{2}-\d{2}$/.test(input.psiraExpiry!)) {
    errors.psiraExpiry = 'PSIRA expiry must be a date.';
  }
  const missing = REQUIRED_PHOTO_KINDS.filter((k) => !input.photoKinds.includes(k));
  if (missing.length) {
    errors.photos = `All four photos are required. Missing: ${missing.map((k) => PHOTO_LABELS[k]).join(', ')}.`;
  }
  return errors;
}
