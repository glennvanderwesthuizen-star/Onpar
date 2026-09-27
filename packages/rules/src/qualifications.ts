export type QualificationStatus = 'COMPLIANT' | 'EXPIRING' | 'EXPIRED';

/** Days before expiry at which a qualification counts as EXPIRING. Configurable per company. */
export const DEFAULT_EXPIRING_WITHIN_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

function dateOnlyUtc(d: string | Date): number {
  const s = typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
  return Date.parse(s + 'T00:00:00Z');
}

/**
 * A qualification is valid up to and including its expiry date.
 * No expiry date means it does not expire.
 */
export function qualificationStatus(
  expiryDate: string | null | undefined,
  today: string | Date,
  expiringWithinDays = DEFAULT_EXPIRING_WITHIN_DAYS,
): QualificationStatus {
  if (!expiryDate) return 'COMPLIANT';
  const daysLeft = (dateOnlyUtc(expiryDate) - dateOnlyUtc(today)) / DAY_MS;
  if (daysLeft < 0) return 'EXPIRED';
  if (daysLeft <= expiringWithinDays) return 'EXPIRING';
  return 'COMPLIANT';
}

/** Qualification types (section 6.9). PSIRA registration is tracked on the officer and shown alongside. */
export const QUALIFICATION_TYPES = {
  firearm_competency: 'Firearm competency',
  first_aid: 'First aid',
  fire_fighting: 'Fire fighting',
  other: 'Other',
} as const;
export type QualificationType = keyof typeof QUALIFICATION_TYPES;

export interface QualificationRecord {
  type: string;
  name: string;
  expiryDate: string | null;
  completionDate?: string | null;
}

/**
 * The record that counts for each qualification: a renewal adds a new record
 * rather than changing the old one, so the one with the latest expiry (no
 * expiry counts as latest) is current. "Other" qualifications are kept apart by name.
 */
export function currentQualifications<T extends QualificationRecord>(records: T[]): T[] {
  const byKey = new Map<string, T>();
  const later = (a: T, b: T) => {
    if (!a.expiryDate) return true;
    if (!b.expiryDate) return false;
    return a.expiryDate > b.expiryDate;
  };
  for (const r of records) {
    const key = r.type === 'other' ? `other:${r.name.trim().toLowerCase()}` : r.type;
    const have = byKey.get(key);
    if (!have || later(r, have)) byKey.set(key, r);
  }
  return [...byKey.values()];
}

export interface ComplianceSummary {
  total: number;
  compliant: number;
  expiring: number;
  expired: number;
  /** Compliant as a whole percentage of everything tracked; 100 when nothing is tracked. */
  compliantPercent: number;
}

/** Figures for the dashboard (section 6.11): compliant percentage, expiring, expired. */
export function complianceSummary(statuses: QualificationStatus[]): ComplianceSummary {
  const compliant = statuses.filter((s) => s === 'COMPLIANT').length;
  const expiring = statuses.filter((s) => s === 'EXPIRING').length;
  const expired = statuses.filter((s) => s === 'EXPIRED').length;
  const total = statuses.length;
  return { total, compliant, expiring, expired, compliantPercent: total ? Math.round((compliant / total) * 100) : 100 };
}
