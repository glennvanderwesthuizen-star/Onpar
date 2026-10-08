/**
 * The Wire: the guard reward programme (owner's rule book and build specification of 8 Oct 2026).
 *
 * Reward only. Barbs are earned and never taken away; nothing here produces a negative
 * number. It is separate from performance scoring (scoring.ts), which keeps its points
 * gained and lost. Every value is a company setting; these are the rule book's defaults,
 * placeholders to be tuned during the pilot.
 */

// --- Settings ------------------------------------------------------------------------------

export interface WireSettings {
  /** Minutes before the shift start a guard must be on duty to be ready for duty. */
  readyLeadMinutes: number;
  barbs: {
    readyForDuty: number;
    dutiesComplete: number;
    cleanHandover: number;
    improvement: number;
    standardStart: number;
    standardStep: number;
    standardCap: number;
    newSkill: number;
    longServiceMonthly: number;
    anniversary: number;
  };
  /** Monthly score (percent) that counts as the standard. */
  standardScore: number;
  /** Percentage points above his own three-month average for the improvement award. */
  improvementMargin: number;
  silver: number;
  gold: number;
  /** Entry barbs by recruitment score: the first band he reaches, highest first. */
  entryBands: { from: number; barbs: number }[];
  /** Barbs per completed year of service for guards already employed at launch. On the Wire only. */
  launchCreditPerYear: number;
  /** Internal cost of one barb in rand. Management reports only, never the guard. */
  randPerBarb: number;
  /** Weights inside each pillar of the monthly score. */
  weights: {
    shiftsWorked: number;
    readyForDuty: number;
    noNoShows: number;
    tasksDone: number;
    itemsHandled: number;
  };
}

export const DEFAULT_WIRE: WireSettings = {
  readyLeadMinutes: 15,
  barbs: {
    readyForDuty: 1,
    dutiesComplete: 1,
    cleanHandover: 1,
    improvement: 20,
    standardStart: 20,
    standardStep: 5,
    standardCap: 40,
    newSkill: 25,
    longServiceMonthly: 2,
    anniversary: 25,
  },
  standardScore: 95,
  improvementMargin: 1,
  silver: 1000,
  gold: 5000,
  entryBands: [
    { from: 90, barbs: 50 },
    { from: 80, barbs: 30 },
    { from: 70, barbs: 15 },
  ],
  launchCreditPerYear: 50,
  randPerBarb: 1,
  weights: { shiftsWorked: 50, readyForDuty: 30, noNoShows: 20, tasksDone: 50, itemsHandled: 30 },
};

/** The ways a barb is earned, as stored on each ledger entry. */
export const WIRE_RULES = {
  ready_for_duty: 'Ready for duty',
  duties_complete: 'Duties complete',
  clean_handover: 'Clean handover',
  improvement: 'Improvement award',
  standard: 'Standard award',
  new_skill: 'New skill',
  long_service: 'Long service',
  anniversary: 'Anniversary',
  entry: 'Entry barbs',
  launch_credit: 'Service before The Wire',
} as const;
export type WireRule = keyof typeof WIRE_RULES;

/** Saved settings over the defaults, so a value added later starts on its default. */
export function mergeWire(saved: unknown): WireSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<WireSettings>;
  return {
    ...DEFAULT_WIRE,
    ...s,
    barbs: { ...DEFAULT_WIRE.barbs, ...(s.barbs ?? {}) },
    weights: { ...DEFAULT_WIRE.weights, ...(s.weights ?? {}) },
    entryBands: Array.isArray(s.entryBands) && s.entryBands.length ? s.entryBands : DEFAULT_WIRE.entryBands,
  };
}

const whole = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;

/** Problems with a set of settings, by field. Barbs are whole numbers and never negative. */
export function wireSettingsErrors(s: WireSettings): Record<string, string> {
  const e: Record<string, string> = {};
  if (!whole(s.readyLeadMinutes, 0, 120)) e.readyLeadMinutes = 'Between 0 and 120 minutes.';
  for (const [k, v] of Object.entries(s.barbs)) if (!whole(v, 0, 1000)) e[`barbs.${k}`] = 'A whole number of barbs from 0 to 1,000.';
  if (s.barbs.standardCap < s.barbs.standardStart) e['barbs.standardCap'] = 'The cap cannot be below the starting award.';
  if (!(typeof s.standardScore === 'number' && s.standardScore > 0 && s.standardScore <= 100)) e.standardScore = 'A percentage from 1 to 100.';
  if (!(typeof s.improvementMargin === 'number' && s.improvementMargin >= 0 && s.improvementMargin <= 50)) e.improvementMargin = 'From 0 to 50 percentage points.';
  if (!whole(s.silver, 1, 1_000_000)) e.silver = 'A whole number of barbs.';
  if (!whole(s.gold, 1, 10_000_000)) e.gold = 'A whole number of barbs.';
  else if (s.gold <= s.silver) e.gold = 'Gold must be more barbs than silver.';
  if (!whole(s.launchCreditPerYear, 0, 1000)) e.launchCreditPerYear = 'A whole number of barbs from 0 to 1,000.';
  if (!(typeof s.randPerBarb === 'number' && s.randPerBarb >= 0 && s.randPerBarb <= 1000)) e.randPerBarb = 'From R0 to R1,000.';
  for (const [k, v] of Object.entries(s.weights)) if (!whole(v, 0, 100)) e[`weights.${k}`] = 'A whole number from 0 to 100.';
  if (!s.entryBands.every((b) => whole(b.from, 0, 100) && whole(b.barbs, 0, 1000))) e.entryBands = 'Each band needs a score from 0 to 100 and barbs from 0 to 1,000.';
  return e;
}

// --- Per shift -----------------------------------------------------------------------------

/** What happened on one worked shift, as far as The Wire is concerned. */
export interface ShiftFacts {
  readyForDuty: boolean;
  dutiesComplete: boolean;
  cleanHandover: boolean;
}

/** The barbs one worked shift earns. A shift that earned nothing simply has no entries. */
export function shiftBarbs(f: ShiftFacts, s: WireSettings): { rule: WireRule; barbs: number }[] {
  const out: { rule: WireRule; barbs: number }[] = [];
  if (f.readyForDuty && s.barbs.readyForDuty > 0) out.push({ rule: 'ready_for_duty', barbs: s.barbs.readyForDuty });
  if (f.dutiesComplete && s.barbs.dutiesComplete > 0) out.push({ rule: 'duties_complete', barbs: s.barbs.dutiesComplete });
  if (f.cleanHandover && s.barbs.cleanHandover > 0) out.push({ rule: 'clean_handover', barbs: s.barbs.cleanHandover });
  return out;
}

/** On duty at least the lead time before the scheduled start. */
export function isReadyForDuty(dutyOnAt: Date, scheduledStart: Date | null, s: WireSettings): boolean {
  return !!scheduledStart && dutyOnAt.getTime() <= scheduledStart.getTime() - s.readyLeadMinutes * 60_000;
}

// --- Per month -----------------------------------------------------------------------------

/** One guard's month, counted from the records On Par already keeps. Leave and off days are not rostered. */
export interface MonthFacts {
  /** Shifts the roster had him working. */
  rostered: number;
  /** Shifts he worked (on and off duty), rostered or not. */
  worked: number;
  /** Rostered shifts with no attendance at all. */
  noShows: number;
  /** Worked shifts on which he was ready for duty. */
  ready: number;
  /** Worked shifts with all duties complete, and with a clean handover. */
  dutiesComplete: number;
  cleanHandover: number;
  /** Tasks allocated to him, and of those done or honestly marked "could not complete". */
  tasksAllocated: number;
  tasksDone: number;
  /** Reports he raised, and of those closed or handed to a named person. */
  itemsRaised: number;
  itemsHandled: number;
  /** Courses passed or grades gained this month. */
  newSkills: number;
  /** A completed year of service falls in this month. */
  anniversary: boolean;
}

export interface MonthScore {
  attendance: number;
  job: number | null;
  overall: number;
}

const pct = (a: number, b: number) => (b > 0 ? Math.min(1, a / b) : null);
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * His own monthly score in percent, from two pillars of equal weight (rule book). Measures with
 * nothing to count are left out and the others re-weighted. With no job measures at all, the
 * score is the attendance pillar alone. Null when he had no shifts to judge.
 */
export function monthlyScore(f: MonthFacts, s: WireSettings): MonthScore | null {
  const weighted = (parts: [number | null, number][]) => {
    const used = parts.filter(([v, w]) => v !== null && w > 0) as [number, number][];
    const total = used.reduce((t, [, w]) => t + w, 0);
    return total ? used.reduce((t, [v, w]) => t + v * w, 0) / total : null;
  };
  const base = Math.max(f.rostered, f.worked);
  if (!base) return null;
  const w = s.weights;
  const attendance = weighted([
    [pct(f.worked, f.rostered || f.worked), w.shiftsWorked],
    [pct(f.ready, f.worked), w.readyForDuty],
    [f.rostered ? 1 - Math.min(1, f.noShows / f.rostered) : null, w.noNoShows],
  ]);
  const job = weighted([
    [pct(f.tasksDone, f.tasksAllocated), w.tasksDone],
    [pct(f.itemsHandled, f.itemsRaised), w.itemsHandled],
  ]);
  if (attendance === null) return null;
  const overall = job === null ? attendance : (attendance + job) / 2;
  return { attendance: round1(attendance * 100), job: job === null ? null : round1(job * 100), overall: round1(overall * 100) };
}

/** Where a guard stands going into a month: his run at the standard and his earlier scores. */
export interface WireRun {
  /** Months in a row at the standard. */
  streak: number;
  /** The month (YYYY-MM) a short month last kept his run alive, if any. */
  graceMonth: string | null;
  /** His overall scores for earlier months, oldest first. */
  history: number[];
}

export const EMPTY_RUN: WireRun = { streak: 0, graceMonth: null, history: [] };

export interface MonthAward {
  award: 'standard' | 'improvement' | null;
  barbs: number;
  /** His own average over up to three earlier months, if he has any. */
  average: number | null;
  next: WireRun;
}

function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

/**
 * The month's award: the standard award once he is at the standard (growing each month in a
 * row, up to the cap), or else the improvement award when he beats his own three-month average.
 * Never both. One short month in any twelve keeps his run alive without paying the standard award.
 */
export function monthAward(month: string, score: number, run: WireRun, s: WireSettings): MonthAward {
  const last3 = run.history.slice(-3);
  const average = last3.length ? round1(last3.reduce((a, b) => a + b, 0) / last3.length) : null;
  const history = [...run.history, score];
  if (score >= s.standardScore) {
    const streak = run.streak + 1;
    const barbs = Math.min(s.barbs.standardCap, s.barbs.standardStart + s.barbs.standardStep * (streak - 1));
    return { award: 'standard', barbs, average, next: { streak, graceMonth: run.graceMonth, history } };
  }
  const graceFree = run.graceMonth === null || monthsBetween(run.graceMonth, month) >= 12;
  const keep = run.streak > 0 && graceFree;
  const next: WireRun = keep ? { streak: run.streak, graceMonth: month, history } : { streak: 0, graceMonth: run.graceMonth, history };
  if (average !== null && score >= average + s.improvementMargin && s.barbs.improvement > 0) {
    return { award: 'improvement', barbs: s.barbs.improvement, average, next };
  }
  return { award: null, barbs: 0, average, next };
}

/** Everything a month earns besides the shift barbs, which are written as each shift ends. */
export function monthBarbs(month: string, f: MonthFacts, run: WireRun, s: WireSettings) {
  const score = monthlyScore(f, s);
  const entries: { rule: WireRule; barbs: number }[] = [];
  let award: MonthAward | null = null;
  if (score) {
    award = monthAward(month, score.overall, run, s);
    if (award.award && award.barbs > 0) entries.push({ rule: award.award, barbs: award.barbs });
  }
  if (f.worked > 0 && s.barbs.longServiceMonthly > 0) entries.push({ rule: 'long_service', barbs: s.barbs.longServiceMonthly });
  if (f.anniversary && s.barbs.anniversary > 0) entries.push({ rule: 'anniversary', barbs: s.barbs.anniversary });
  if (f.newSkills > 0 && s.barbs.newSkill > 0) entries.push({ rule: 'new_skill', barbs: s.barbs.newSkill * f.newSkills });
  return { score, award, entries, run: award?.next ?? run };
}

// --- Entry, insignia and forecasts ---------------------------------------------------------

export function entryBarbs(recruitmentScore: number | null, s: WireSettings): number {
  if (recruitmentScore === null) return 0;
  return [...s.entryBands].sort((a, b) => b.from - a.from).find((b) => recruitmentScore >= b.from)?.barbs ?? 0;
}

/** Completed years between joining and the day The Wire started for his company. */
export function completedYears(joinedOn: string, onDate: string): number {
  const [jy, jm, jd] = joinedOn.split('-').map(Number);
  const [y, m, d] = onDate.split('-').map(Number);
  return Math.max(0, y - jy - (m < jm || (m === jm && d < jd) ? 1 : 0));
}

export type Insignia = 'black' | 'silver' | 'gold';
export const INSIGNIA_LABELS: Record<Insignia, string> = { black: 'Black barb', silver: 'Silver barb', gold: 'Gold barb' };

export function insignia(wireTotal: number, s: WireSettings): Insignia {
  return wireTotal >= s.gold ? 'gold' : wireTotal >= s.silver ? 'silver' : 'black';
}

/** Months until a total is reached at a monthly pace; null when he is not earning. 0 when already there. */
export function monthsTo(target: number, total: number, pacePerMonth: number): number | null {
  if (total >= target) return 0;
  if (pacePerMonth <= 0) return null;
  return Math.ceil((target - total) / pacePerMonth);
}

/**
 * The most a guard can earn in a month on a given number of shifts: every shift barb, the standard
 * award at its cap and long service, with an anniversary spread over the year. This is Bob Wire,
 * the guard who sets the standard, and the fastest anyone can reach silver or gold.
 */
export function bobWireMonth(shifts: number, s: WireSettings): number {
  const b = s.barbs;
  return shifts * (b.readyForDuty + b.dutiesComplete + b.cleanHandover) + b.standardCap + b.longServiceMonthly + b.anniversary / 12;
}

/** Months for Bob Wire to reach a total from nothing, given he climbs the standard award from its start. */
export function bobWireMonthsTo(target: number, shifts: number, s: WireSettings): number {
  const b = s.barbs;
  let total = 0;
  for (let m = 1; m <= 1200; m++) {
    total += shifts * (b.readyForDuty + b.dutiesComplete + b.cleanHandover) + Math.min(b.standardCap, b.standardStart + b.standardStep * (m - 1)) + b.longServiceMonthly + (m % 12 === 0 ? b.anniversary : 0);
    if (total >= target) return m;
  }
  return Infinity;
}

// --- Simulation ----------------------------------------------------------------------------

/** One guard's real months, for replaying them under other values. */
export interface SimGuard {
  employeeId: string;
  recruitmentScore: number | null;
  /** Barbs from service before The Wire (launch credit). */
  launchYears: number;
  months: { month: string; facts: MonthFacts }[];
}

export interface SimMonth {
  month: string;
  score: number | null;
  award: MonthAward['award'];
  bySource: Partial<Record<WireRule, number>>;
  barbs: number;
}

/**
 * Replays real months under a set of values, month by month, exactly as the live engine would
 * have paid them. Shift barbs come from the month's counts. Used for the owner's "what if" runs.
 */
export function simulateGuard(g: SimGuard, s: WireSettings) {
  let run = EMPTY_RUN;
  const opening: Partial<Record<WireRule, number>> = {};
  const entry = entryBarbs(g.recruitmentScore, s);
  if (entry) opening.entry = entry;
  if (g.launchYears * s.launchCreditPerYear) opening.launch_credit = g.launchYears * s.launchCreditPerYear;
  const months: SimMonth[] = g.months.map(({ month, facts }) => {
    const bySource: Partial<Record<WireRule, number>> = {};
    const add = (rule: WireRule, n: number) => {
      if (n > 0) bySource[rule] = (bySource[rule] ?? 0) + n;
    };
    add('ready_for_duty', facts.ready * s.barbs.readyForDuty);
    add('duties_complete', facts.dutiesComplete * s.barbs.dutiesComplete);
    add('clean_handover', facts.cleanHandover * s.barbs.cleanHandover);
    const r = monthBarbs(month, facts, run, s);
    for (const e of r.entries) add(e.rule, e.barbs);
    run = r.run;
    return { month, score: r.score?.overall ?? null, award: r.award?.award ?? null, bySource, barbs: Object.values(bySource).reduce((a, b) => a + (b ?? 0), 0) };
  });
  const openingTotal = Object.values(opening).reduce((a, b) => a + (b ?? 0), 0);
  const earned = months.reduce((a, m) => a + m.barbs, 0);
  const pace = months.length ? earned / months.length : 0;
  const total = openingTotal + earned;
  return {
    employeeId: g.employeeId,
    opening,
    months,
    total,
    pace: Math.round(pace * 10) / 10,
    monthsToSilver: monthsTo(s.silver, total, pace),
    monthsToGold: monthsTo(s.gold, total, pace),
  };
}
