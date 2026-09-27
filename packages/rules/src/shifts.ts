/** Site and shift rules (brief sections 6.13, 36 and 41). */

export type ShiftKind = 'day' | 'night';

/** Default equipment list per shift. Configurable per company later. */
export const DEFAULT_EQUIPMENT_TYPES = ['Radio', 'Torch', 'Handheld device', 'Firearm', 'Vehicle'] as const;

/** Payroll month start day. Limited to 1–28 so every month has that day. */
export const DEFAULT_PAYROLL_START_DAY = 26;

export interface ShiftInput {
  name?: string;
  kind?: string;
  startTime?: string;
  endTime?: string;
  guardsRequired?: number;
  equipment?: Record<string, number>;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Length of a shift in minutes. A shift ending at or before its start runs past midnight. */
export function shiftLengthMinutes(startTime: string, endTime: string): number {
  const s = minutesOfDay(startTime);
  const e = minutesOfDay(endTime);
  return e > s ? e - s : e + 24 * 60 - s;
}

/** Returns field → message for one shift. Empty object means valid. */
export function shiftErrors(shift: ShiftInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!shift.name?.trim()) errors.name = 'Give the shift a name, for example Day.';
  if (shift.kind !== 'day' && shift.kind !== 'night') errors.kind = 'Choose Day or Night.';
  if (!shift.startTime || !TIME.test(shift.startTime)) errors.startTime = 'Enter a start time like 06:00.';
  if (!shift.endTime || !TIME.test(shift.endTime)) errors.endTime = 'Enter an end time like 18:00.';
  if (!errors.startTime && !errors.endTime && shift.startTime === shift.endTime) {
    errors.endTime = 'The shift must end at a different time from when it starts.';
  }
  if (!Number.isInteger(shift.guardsRequired) || (shift.guardsRequired as number) < 1) {
    errors.guardsRequired = 'At least 1 guard is needed on every shift.';
  }
  for (const [item, qty] of Object.entries(shift.equipment ?? {})) {
    if (!Number.isInteger(qty) || qty < 0) errors[`equipment.${item}`] = `${item} must be 0 or more.`;
  }
  return errors;
}

export interface SiteInput {
  name?: string;
  address?: string;
  client?: string;
  minimumGrade?: string;
  armed?: boolean;
  payrollStartDay?: number;
  shifts?: ShiftInput[];
}

/** Returns field → message for a whole site, with shift errors keyed `shifts.<i>.<field>`. */
export function siteErrors(site: SiteInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!site.name?.trim()) errors.name = 'The site needs a name.';
  if (!site.address?.trim()) errors.address = 'Enter an address or area.';
  if (!site.client?.trim()) errors.client = 'Enter the client.';
  if (!site.minimumGrade || !['A', 'B', 'C', 'D', 'E'].includes(site.minimumGrade)) {
    errors.minimumGrade = 'Choose a minimum PSIRA grade, A to E.';
  }
  if (typeof site.armed !== 'boolean') errors.armed = 'Say whether the site is armed.';
  const day = site.payrollStartDay;
  if (!Number.isInteger(day) || (day as number) < 1 || (day as number) > 28) {
    errors.payrollStartDay = 'Payroll month start day must be between 1 and 28.';
  }
  if (!site.shifts?.length) errors.shifts = 'Add at least one shift.';
  site.shifts?.forEach((s, i) => {
    for (const [k, v] of Object.entries(shiftErrors(s))) errors[`shifts.${i}.${k}`] = v;
  });
  return errors;
}

/** Guards needed for one full day at a site: the sum over its shifts. */
export function guardsNeededPerDay(shifts: { guardsRequired: number }[]): number {
  return shifts.reduce((n, s) => n + s.guardsRequired, 0);
}
