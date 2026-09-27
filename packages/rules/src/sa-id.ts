/**
 * South African ID numbers: 13 digits, YYMMDD SSSS C A Z.
 * YYMMDD is the date of birth, C is citizenship (0 citizen, 1 permanent
 * resident, 2 refugee), A is a legacy digit and Z is a Luhn check digit.
 */

export type SaIdResult =
  | { valid: true; dateOfBirth: string; citizen: boolean }
  | { valid: false; reason: string };

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Validates an SA ID number. `today` decides the century of the birth year:
 * a two-digit year that would put the birth date in the future is 1900s.
 */
export function validateSaId(raw: string, today: Date = new Date()): SaIdResult {
  const id = (raw ?? '').replace(/\s/g, '');
  if (!/^\d{13}$/.test(id)) return { valid: false, reason: 'An ID number must be exactly 13 digits.' };

  const yy = Number(id.slice(0, 2));
  const mm = Number(id.slice(2, 4));
  const dd = Number(id.slice(4, 6));
  let year = 2000 + yy;
  if (year > today.getUTCFullYear()) year -= 100;
  const dob = new Date(Date.UTC(year, mm - 1, dd));
  if (dob.getUTCFullYear() !== year || dob.getUTCMonth() !== mm - 1 || dob.getUTCDate() !== dd) {
    return { valid: false, reason: 'The first six digits are not a valid date of birth.' };
  }
  if (dob.getTime() > today.getTime()) {
    return { valid: false, reason: 'The date of birth is in the future.' };
  }

  const c = id[10];
  if (c !== '0' && c !== '1' && c !== '2') {
    return { valid: false, reason: 'The citizenship digit (11th) must be 0, 1 or 2.' };
  }
  if (!luhnValid(id)) return { valid: false, reason: 'The check digit is wrong. Please re-check the number.' };

  return { valid: true, dateOfBirth: dob.toISOString().slice(0, 10), citizen: c === '0' };
}

/** Shows only the last four digits, as the brief requires (section 6.12). */
export function maskIdNumber(id: string): string {
  const clean = (id ?? '').replace(/\s/g, '');
  if (clean.length <= 4) return clean;
  return '•'.repeat(clean.length - 4) + clean.slice(-4);
}
