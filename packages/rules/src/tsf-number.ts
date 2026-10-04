/**
 * The guard's TSF number: a username styled on South African number plates, e.g. "BCD 123 GP".
 * It says who the guard is; the PIN (typed every time) proves it. It is printed on the guard's
 * ID card only inside a QR code, next to their name. The province is that of the guard's home
 * site when the number is issued, and the number never changes afterwards (even on a transfer).
 */

export const PROVINCES = [
  { code: 'GP', name: 'Gauteng' },
  { code: 'WC', name: 'Western Cape' },
  { code: 'KZN', name: 'KwaZulu-Natal' },
  { code: 'EC', name: 'Eastern Cape' },
  { code: 'FS', name: 'Free State' },
  { code: 'LP', name: 'Limpopo' },
  { code: 'MP', name: 'Mpumalanga' },
  { code: 'NW', name: 'North West' },
  { code: 'NC', name: 'Northern Cape' },
] as const;
export type ProvinceCode = (typeof PROVINCES)[number]['code'];

export function isProvince(code: unknown): code is ProvinceCode {
  return PROVINCES.some((p) => p.code === code);
}

export function provinceName(code: string | null | undefined): string {
  return PROVINCES.find((p) => p.code === code)?.name ?? '';
}

/** Like Gauteng plates: no vowels (so no words are spelt) and no Q (looks like O and 0). */
export const PLATE_LETTERS = 'BCDFGHJKLMNPRSTVWXYZ';

const PATTERN = new RegExp(`^([${PLATE_LETTERS}]{3})(\\d{3})(${PROVINCES.map((p) => p.code).join('|')})$`);

/** How the number is stored and put in the QR code: no spaces, e.g. "BCD123GP". */
export function normaliseTsfNumber(input: string): string | null {
  const s = (input ?? '').toUpperCase().replace(/[\s-]/g, '');
  const m = PATTERN.exec(s);
  return m && m[2] !== '000' ? s : null;
}

/** How the number is shown, with plate spacing: "BCD 123 GP". */
export function formatTsfNumber(n: string | null | undefined): string {
  const m = n ? PATTERN.exec(n) : null;
  return m ? `${m[1]} ${m[2]} ${m[3]}` : (n ?? '');
}

export function tsfNumberProvince(n: string): ProvinceCode | null {
  const m = PATTERN.exec(n);
  return m ? (m[3] as ProvinceCode) : null;
}

/**
 * A random, unused-looking number for a province. `randomInt(max)` returns 0..max-1; the server
 * passes a cryptographic one and retries if the number is already taken.
 */
export function generateTsfNumber(province: ProvinceCode, randomInt: (max: number) => number): string {
  let letters = '';
  for (let i = 0; i < 3; i++) letters += PLATE_LETTERS[randomInt(PLATE_LETTERS.length)];
  const digits = String(1 + randomInt(999)).padStart(3, '0');
  return `${letters}${digits}${province}`;
}

/** What the guard's ID card QR code holds. The prefix stops a checkpoint QR being taken for an ID. */
export const ID_QR_PREFIX = 'ONPAR-ID:';

export function idCardQr(tsfNumber: string): string {
  return ID_QR_PREFIX + tsfNumber;
}

/** The TSF number from a scanned ID card, or null if it is not an On Par ID card. */
export function parseIdCardQr(text: string): string | null {
  const t = (text ?? '').trim();
  if (!t.toUpperCase().startsWith(ID_QR_PREFIX)) return null;
  return normaliseTsfNumber(t.slice(ID_QR_PREFIX.length));
}
