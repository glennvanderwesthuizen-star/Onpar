/**
 * Attendance rules (brief sections 6.2, 6.3 and 8).
 *
 * All times are Africa/Johannesburg. South Africa has had no daylight saving
 * since 1944, so the offset is a fixed +02:00, which keeps this arithmetic simple.
 */

import { minutesOfDay } from './shifts';

export const SAST_OFFSET_MINUTES = 120;
const MINUTE = 60_000;

/** Up to this many minutes after the start counts as ON TIME. Configurable per company. */
export const DEFAULT_GRACE_MINUTES = 5;
/** Device time further than this from trusted time is flagged. */
export const CLOCK_DRIFT_FLAG_SECONDS = 120;
/** Events older than this are refused. */
export const MAX_EVENT_AGE_HOURS = 72;
/** An event arriving more than this after it happened is "late-synced". */
export const LATE_SYNC_AFTER_SECONDS = 120;
/** A guard may Duty On up to this long before a shift starts and still be matched to it. */
export const EARLY_ARRIVAL_WINDOW_MINUTES = 120;

export type ArrivalStatus = 'ON_TIME' | 'LATE' | 'UNSCHEDULED';
export type DepartureStatus = 'ON_TIME' | 'EARLY_DEPARTURE' | 'UNSCHEDULED';

/** The local (SAST) calendar date of an instant, as YYYY-MM-DD. */
export function sastDate(at: Date): string {
  return new Date(at.getTime() + SAST_OFFSET_MINUTES * MINUTE).toISOString().slice(0, 10);
}

/** The instant for a local SAST date and HH:MM time. */
export function sastInstant(date: string, hhmm: string): Date {
  return new Date(Date.parse(`${date}T${hhmm}:00+02:00`));
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface ShiftTimes {
  id: string;
  startTime: string;
  endTime: string;
}

export interface ShiftMatch {
  shiftId: string;
  /** The local date the shift starts on. A night shift from 18:00 to 06:00 belongs to the date it starts. */
  shiftDate: string;
  scheduledStart: Date;
  scheduledEnd: Date;
}

/**
 * Interim scheduling until rostering (milestone 21): the shift a guard is on
 * is the site shift whose window, from 2 hours before its start until its
 * end, contains the Duty On time. If several fit, the one starting closest
 * to the Duty On time wins. Returns null if none fits.
 */
export function matchShift(shifts: ShiftTimes[], at: Date): ShiftMatch | null {
  const today = sastDate(at);
  let best: ShiftMatch | null = null;
  for (const s of shifts) {
    // A shift that started yesterday may still be running (overnight), or one may start tomorrow within the early window.
    for (const date of [addDays(today, -1), today, addDays(today, 1)]) {
      const start = sastInstant(date, s.startTime);
      const overnight = minutesOfDay(s.endTime) <= minutesOfDay(s.startTime);
      const end = sastInstant(overnight ? addDays(date, 1) : date, s.endTime);
      const opens = start.getTime() - EARLY_ARRIVAL_WINDOW_MINUTES * MINUTE;
      if (at.getTime() < opens || at.getTime() >= end.getTime()) continue;
      const candidate = { shiftId: s.id, shiftDate: date, scheduledStart: start, scheduledEnd: end };
      if (!best || Math.abs(start.getTime() - at.getTime()) < Math.abs(best.scheduledStart.getTime() - at.getTime())) {
        best = candidate;
      }
    }
  }
  return best;
}

/** ON TIME up to the grace period after the start, otherwise LATE with whole minutes. */
export function arrivalStatus(
  scheduledStart: Date | null,
  dutyOnAt: Date,
  graceMinutes = DEFAULT_GRACE_MINUTES,
): { status: ArrivalStatus; lateMinutes: number } {
  if (!scheduledStart) return { status: 'UNSCHEDULED', lateMinutes: 0 };
  const late = Math.floor((dutyOnAt.getTime() - scheduledStart.getTime()) / MINUTE);
  return late > graceMinutes ? { status: 'LATE', lateMinutes: late } : { status: 'ON_TIME', lateMinutes: 0 };
}

/** EARLY DEPARTURE with whole minutes when Duty From is before the scheduled end. */
export function departureStatus(scheduledEnd: Date | null, dutyFromAt: Date): { status: DepartureStatus; earlyMinutes: number } {
  if (!scheduledEnd) return { status: 'UNSCHEDULED', earlyMinutes: 0 };
  const early = Math.ceil((scheduledEnd.getTime() - dutyFromAt.getTime()) / MINUTE);
  return early > 0 ? { status: 'EARLY_DEPARTURE', earlyMinutes: early } : { status: 'ON_TIME', earlyMinutes: 0 };
}

export type TimeCheck =
  | {
      ok: true;
      /** The official time recorded for the event. */
      officialAt: Date;
      lateSynced: boolean;
      /** Device clock minus trusted time, in seconds. */
      driftSeconds: number;
      driftFlagged: boolean;
    }
  | { ok: false; reason: string };

/**
 * Decides the official time of an event from the device (section 8).
 *
 * `trustedAt` is what the device computed as last server time plus elapsed
 * time since then, which the guard cannot change. `deviceClock` is the phone's
 * wall clock, kept for comparison. If the event arrives promptly, server time
 * is used; otherwise the device's trusted time, flagged as late-synced.
 */
export function reconcileTime(trustedAt: Date, deviceClock: Date, receivedAt: Date): TimeCheck {
  const lag = (receivedAt.getTime() - trustedAt.getTime()) / 1000;
  if (lag < -LATE_SYNC_AFTER_SECONDS) {
    return { ok: false, reason: 'The event time is in the future. The device clock needs to resynchronise.' };
  }
  if (lag > MAX_EVENT_AGE_HOURS * 3600) {
    return { ok: false, reason: `The event is older than ${MAX_EVENT_AGE_HOURS} hours and cannot be accepted.` };
  }
  const lateSynced = lag > LATE_SYNC_AFTER_SECONDS;
  const driftSeconds = Math.round((deviceClock.getTime() - trustedAt.getTime()) / 1000);
  return {
    ok: true,
    officialAt: lateSynced ? trustedAt : receivedAt,
    lateSynced,
    driftSeconds,
    driftFlagged: Math.abs(driftSeconds) > CLOCK_DRIFT_FLAG_SECONDS,
  };
}

/**
 * Declaration wording, exactly as supplied by the owner (section 6.2).
 * Changing any wording means adding a new version, never editing an old one,
 * because every declaration record keeps the version it showed.
 */
export const DECLARATIONS = {
  duty_on: {
    // Version 2 (decision D-33) adds the relief statement. Wording to be checked by a labour lawyer (L-02).
    version: 2,
    statements: [
      'I am fit and free of injury and ready to commence and complete my shift',
      'I have read the OB and understand the tasks for the day',
      'I have taken receipt of all equipment handed over from the previous shift, all in good order',
      'I understand that I may not leave the site until my relief has arrived, for up to 30 minutes after my shift ends, unless my supervisor releases me',
    ],
  },
  duty_from: {
    version: 1,
    statements: [
      'I am fit and free of injury and departing from duty, I have handed over all assigned equipment and handed over any information required by the incoming shift',
    ],
  },
} as const;

export type DutyKind = keyof typeof DECLARATIONS;

/** Earlier wordings still accepted from phones not yet updated, recorded under their own version. */
const EARLIER_DECLARATIONS: Record<DutyKind, { version: number; statements: readonly string[] }[]> = {
  duty_on: [{ version: 1, statements: DECLARATIONS.duty_on.statements.slice(0, 3) }],
  duty_from: [],
};

/** The wording a declaration was made against, found by how many statements the phone showed. */
export function declarationWordingFor(kind: DutyKind, statementCount: number): { version: number; statements: readonly string[] } | null {
  const current = DECLARATIONS[kind];
  if (statementCount === current.statements.length) return current;
  return EARLIER_DECLARATIONS[kind].find((w) => w.statements.length === statementCount) ?? null;
}

/** HH:MM in South African time. */
export function sastTime(at: Date): string {
  return new Date(at.getTime() + SAST_OFFSET_MINUTES * MINUTE).toISOString().slice(11, 16);
}

/** A date like "27 Sep 2026". */
export function sastLongDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
