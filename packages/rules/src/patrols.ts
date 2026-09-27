/** Patrol rules (brief section 6.5). */

export const GPS_ACCURACY_REQUIRED_M = 25;
export const DEFAULT_POINT_RADIUS_M = 30;
export const DUPLICATE_SCAN_WINDOW_S = 120;
export const ALERT_ESCALATE_AFTER_MIN = 10;

const MIN = 60_000;

export interface PatrolRule {
  perShift: number;
  minGapMinutes: number;
  maxDurationMinutes: number;
}

export interface Window {
  index: number;
  start: Date;
  end: Date;
}

/** The shift split into equal windows, one patrol per window. */
export function patrolWindows(shiftStart: Date, shiftEnd: Date, perShift: number): Window[] {
  const length = (shiftEnd.getTime() - shiftStart.getTime()) / perShift;
  return Array.from({ length: perShift }, (_, i) => ({
    index: i,
    start: new Date(shiftStart.getTime() + i * length),
    end: new Date(shiftStart.getTime() + (i + 1) * length),
  }));
}

/** Warn when the gap plus the maximum duration cannot fit inside one window. */
export function ruleFitWarning(shiftMinutes: number, r: PatrolRule): string | null {
  const window = shiftMinutes / r.perShift;
  if (r.minGapMinutes + r.maxDurationMinutes > window) {
    return `${r.perShift} patrols make each window ${Math.round(window)} minutes, but the gap (${r.minGapMinutes}) plus the maximum duration (${r.maxDurationMinutes}) is ${r.minGapMinutes + r.maxDurationMinutes} minutes. Guards may not be able to fit every patrol in.`;
  }
  return null;
}

export function ruleErrors(r: Partial<PatrolRule>): Record<string, string> {
  const e: Record<string, string> = {};
  if (!Number.isInteger(r.perShift) || (r.perShift as number) < 1 || (r.perShift as number) > 48) e.perShift = 'Between 1 and 48 patrols per shift.';
  if (!Number.isInteger(r.minGapMinutes) || (r.minGapMinutes as number) < 0) e.minGapMinutes = 'Zero or more minutes.';
  if (!Number.isInteger(r.maxDurationMinutes) || (r.maxDurationMinutes as number) < 1) e.maxDurationMinutes = 'At least 1 minute.';
  return e;
}

export interface PatrolHistory {
  /** Windows that already have a patrol of this type (active, completed or partial). */
  usedWindows: number[];
  /** When the last patrol of this type finished, if any. */
  lastFinishedAt: Date | null;
  /** Whether the guard already has a patrol of any type in progress. */
  activePatrol: boolean;
}

export type StartCheck =
  | { ok: true; window: Window }
  | { ok: false; reason: string; opensAt: Date | null };

/**
 * Can a patrol of this type start now? Only one patrol at a time; one per
 * window; and not until the minimum gap has passed since the last one of this
 * type finished (scenario 2). If not, says when the next one opens.
 */
export function canStartPatrol(now: Date, windows: Window[], rule: PatrolRule, h: PatrolHistory): StartCheck {
  if (h.activePatrol) return { ok: false, reason: 'Finish the patrol in progress first.', opensAt: null };
  const gapUntil = h.lastFinishedAt ? new Date(h.lastFinishedAt.getTime() + rule.minGapMinutes * MIN) : null;
  const current = windows.find((w) => now >= w.start && now < w.end);
  const nextFree = windows.find((w) => w.end > now && !h.usedWindows.includes(w.index));
  const opensAt = (w: Window | undefined) => {
    if (!w) return null;
    const t = Math.max(w.start.getTime(), gapUntil?.getTime() ?? 0);
    return new Date(t);
  };
  if (!current) return { ok: false, reason: 'There is no patrol window open now.', opensAt: opensAt(nextFree) };
  if (h.usedWindows.includes(current.index)) {
    return { ok: false, reason: 'This window’s patrol has been done. The next one opens later.', opensAt: opensAt(nextFree) };
  }
  if (gapUntil && now < gapUntil) {
    return { ok: false, reason: `The minimum gap of ${rule.minGapMinutes} minutes since the last patrol has not passed.`, opensAt: gapUntil };
  }
  return { ok: true, window: current };
}

/** Distance in metres between two points (haversine). */
export function distanceMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export type ScanResult = 'accepted' | 'rejected_accuracy' | 'rejected_distance' | 'ignored_duplicate';

export const SCAN_RESULT_LABELS: Record<ScanResult | 'rejected_unknown_code' | 'rejected_wrong_type', string> = {
  accepted: 'Accepted',
  rejected_accuracy: 'Rejected: GPS not accurate enough',
  rejected_distance: 'Rejected: not at the patrol point',
  ignored_duplicate: 'Ignored: repeat scan',
  rejected_unknown_code: 'Rejected: unknown QR code',
  rejected_wrong_type: 'Rejected: point belongs to another patrol',
};

/**
 * A scan counts only with a GPS fix of 25 m or better, within the point's
 * radius (scenario 4). A repeat of the same point within 2 minutes is ignored.
 */
export function checkScan(
  scan: { lat: number; lng: number; accuracyM: number },
  point: { lat: number; lng: number; radiusM: number },
  secondsSinceLastSameScan: number | null,
): { result: ScanResult; distanceM: number } {
  const distanceM = Math.round(distanceMetres(scan.lat, scan.lng, point.lat, point.lng));
  if (secondsSinceLastSameScan !== null && secondsSinceLastSameScan < DUPLICATE_SCAN_WINDOW_S) return { result: 'ignored_duplicate', distanceM };
  if (!(scan.accuracyM <= GPS_ACCURACY_REQUIRED_M)) return { result: 'rejected_accuracy', distanceM };
  if (distanceM > point.radiusM) return { result: 'rejected_distance', distanceM };
  return { result: 'accepted', distanceM };
}

/** What a patrol point asks for (section 6.5). */
export type Requirement = 'off' | 'optional' | 'required';
export type Check =
  | { id: string; kind: 'number'; label: string; unit: string; below?: number | null; above?: number | null }
  | { id: string; kind: 'ok_problem'; label: string }
  | { id: string; kind: 'photo'; label: string };

export type ReadingValue = { checkId: string; value?: number; ok?: boolean; photo?: boolean };

/**
 * Is a reading outside its limit? A number below `below` or above `above`,
 * or "Problem", is flagged and raises an Amber report (scenario 7).
 */
export function readingOutOfLimit(check: Check, r: ReadingValue): boolean {
  if (check.kind === 'number') {
    if (typeof r.value !== 'number') return false;
    return (check.below != null && r.value < check.below) || (check.above != null && r.value > check.above);
  }
  if (check.kind === 'ok_problem') return r.ok === false;
  return false;
}

/** What is still missing before a point counts as done. */
export function pointMissing(
  point: { photoMode: Requirement; noteMode: Requirement; checks: Check[] },
  given: { photo: boolean; note: string; readings: ReadingValue[] },
): string[] {
  const missing: string[] = [];
  if (point.photoMode === 'required' && !given.photo) missing.push('A photo is required.');
  if (point.noteMode === 'required' && !given.note.trim()) missing.push('A note is required.');
  for (const c of point.checks) {
    const r = given.readings.find((x) => x.checkId === c.id);
    if (c.kind === 'number' && typeof r?.value !== 'number') missing.push(`Enter ${c.label}.`);
    if (c.kind === 'ok_problem' && typeof r?.ok !== 'boolean') missing.push(`Say whether ${c.label} is OK.`);
    if (c.kind === 'photo' && !r?.photo) missing.push(`Take the photo: ${c.label}.`);
  }
  return missing;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Patrol points for the k-th completed patrol of a shift, when the site's
 * allocation is shared across `required` patrols. Cumulative rounding makes
 * the shares add up to exactly the allocation (scenario 6).
 */
export function patrolShare(allocation: number, required: number, k: number): number {
  if (required <= 0 || k < 1 || k > required) return 0;
  return round2(round2((allocation * k) / required) - round2((allocation * (k - 1)) / required));
}
