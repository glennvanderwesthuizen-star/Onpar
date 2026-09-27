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
