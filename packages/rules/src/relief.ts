/**
 * Relief at shift change (owner's decision D-33, docs/NEXT_ROUND.md items 2 to 5).
 *
 * A guard may log Duty From only once his relief has done Duty On at the site, one
 * relief for one leaving guard, first in first out. If nobody arrives, Duty From
 * unlocks 30 minutes after the shift ends. A supervisor can always release a guard.
 */

import { sastTime } from './attendance';

const MINUTE = 60_000;

/** How long after the shift ends a guard must wait for his relief. */
export const RELIEF_WAIT_MINUTES = 30;
/** Duty On more than this many minutes before the shift earns the early-arrival point. */
export const EARLY_BONUS_MINUTES = 15;

/** A guard of the shift that is ending, at the same site. */
export interface LeavingGuard {
  attendanceId: string;
  name: string;
  dutyOnAt: Date;
  dutyFromAt: Date | null;
  /** When he gave his turn to a partner ("let my partner go first"). */
  turnGivenAt: Date | null;
  /** How he left: 'relieved' uses up one relief. */
  reliefStatus: string | null;
}

/** A guard of the next shift who has done Duty On at the site. */
export interface Reliever {
  attendanceId: string;
  name: string;
  dutyOnAt: Date;
  lateMinutes: number;
}

export type ReliefOutcome =
  /** No scheduled end (not rostered, no matching shift): no rule applies. */
  | 'no_rule'
  /** A relief has arrived for him: he may go. */
  | 'relieved'
  /** Nobody came within the waiting time: he may go, and the post is uncovered. */
  | 'no_relief'
  /** He must wait. */
  | 'wait';

export interface ReliefCheck {
  canLeave: boolean;
  outcome: ReliefOutcome;
  /** For the guard, in plain words. */
  message: string;
  /** The relief he leaves on, when relieved. */
  reliever: Reliever | null;
  /** When Duty From unlocks anyway if nobody arrives. */
  unlocksAt: Date | null;
  /** His place in the queue (0 = next to go). */
  position: number;
  /** He is next and a relief is available, so he may give his turn to a partner behind him. */
  canGiveTurn: boolean;
}

/** The queue of guards still on duty: first in, first out; a guard who gave his turn goes behind the others. */
export function reliefQueue(leaving: LeavingGuard[]): LeavingGuard[] {
  return leaving
    .filter((g) => !g.dutyFromAt)
    .sort((a, b) => {
      const ga = a.turnGivenAt ? 1 : 0;
      const gb = b.turnGivenAt ? 1 : 0;
      if (ga !== gb) return ga - gb;
      if (ga && gb && a.turnGivenAt!.getTime() !== b.turnGivenAt!.getTime()) return a.turnGivenAt!.getTime() - b.turnGivenAt!.getTime();
      return a.dutyOnAt.getTime() - b.dutyOnAt.getTime();
    });
}

/**
 * Whether the guard with attendance `me` may log Duty From now.
 * `leaving` is every guard of his shift at the site (him included); `relievers` the
 * next shift's guards who have done Duty On there.
 */
export function reliefCheck(now: Date, me: string, shiftEnd: Date | null, leaving: LeavingGuard[], relievers: Reliever[]): ReliefCheck {
  const base = { reliever: null, unlocksAt: null, position: 0, canGiveTurn: false };
  if (!shiftEnd) return { ...base, canLeave: true, outcome: 'no_rule', message: '' };
  const unlocksAt = new Date(shiftEnd.getTime() + RELIEF_WAIT_MINUTES * MINUTE);
  const arrived = [...relievers].sort((a, b) => a.dutyOnAt.getTime() - b.dutyOnAt.getTime());
  const used = leaving.filter((g) => g.dutyFromAt && g.reliefStatus === 'relieved').length;
  const available = Math.max(0, arrived.length - used);
  const queue = reliefQueue(leaving);
  const position = Math.max(0, queue.findIndex((g) => g.attendanceId === me));
  if (position < available) {
    const reliever = arrived[used + position];
    return {
      canLeave: true,
      outcome: 'relieved',
      message: `${reliever.name} has arrived to relieve you. You may log Duty From.`,
      reliever,
      unlocksAt,
      position,
      canGiveTurn: queue.length > position + 1,
    };
  }
  if (now.getTime() >= unlocksAt.getTime()) {
    return {
      ...base,
      canLeave: true,
      outcome: 'no_relief',
      message: 'Your relief has not arrived. You may log Duty From; your supervisor will be told the post is not covered.',
      unlocksAt,
      position,
    };
  }
  const ahead = available > 0 ? queue[position - 1] ?? queue[0] : null;
  return {
    ...base,
    canLeave: false,
    outcome: 'wait',
    message:
      available > 0 && ahead
        ? `A relief has arrived, but it is ${ahead.name}'s turn to go first. Stay on post until the next relief arrives, or until ${sastTime(unlocksAt)}.`
        : `Your relief has not arrived yet. Stay on post. If nobody arrives, Duty From unlocks at ${sastTime(unlocksAt)}.`,
    unlocksAt,
    position,
  };
}

/** Duty On more than 15 minutes before the shift earns the early-arrival point. */
export function earnsEarlyBonus(scheduledStart: Date | null, dutyOnAt: Date): boolean {
  return !!scheduledStart && scheduledStart.getTime() - dutyOnAt.getTime() > EARLY_BONUS_MINUTES * MINUTE;
}

/** Minutes worked outside the rostered shift: before it starts and after it ends. Never invented: both times must exist. */
export function overtimeMinutes(
  scheduledStart: Date | null,
  scheduledEnd: Date | null,
  dutyOnAt: Date | null,
  dutyFromAt: Date | null,
): { before: number; after: number; total: number } {
  const before = scheduledStart && dutyOnAt ? Math.max(0, Math.floor((scheduledStart.getTime() - dutyOnAt.getTime()) / MINUTE)) : 0;
  const after = scheduledEnd && dutyFromAt ? Math.max(0, Math.floor((dutyFromAt.getTime() - scheduledEnd.getTime()) / MINUTE)) : 0;
  return { before, after, total: before + after };
}
