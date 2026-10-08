import { QUALIFICATION_TYPES } from './qualifications';
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
    thuthukaSent: number;
    thuthukaAdopted: number;
    customerPraise: number;
    discretionaryMin: number;
    discretionaryMax: number;
  };
  /** Thuthuka notes that earn submission barbs each month. */
  notesPaidPerMonth: number;
  /** Whether guards may hand in barbs. Closed until the accountant has answered on tax (rule book). */
  storeOpen: boolean;
  /** Funded courses a guard may hand in for in any twelve months. */
  coursesPerYear: number;
  /** Discretionary barbs each site may award in a month. */
  discretionaryBudgetPerSite: number;
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
    thuthukaSent: 2,
    thuthukaAdopted: 25,
    customerPraise: 25,
    discretionaryMin: 5,
    discretionaryMax: 15,
  },
  notesPaidPerMonth: 2,
  discretionaryBudgetPerSite: 100,
  storeOpen: false,
  coursesPerYear: 1,
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
  thuthuka_sent: 'Thuthuka note sent',
  thuthuka_adopted: 'Thuthuka note adopted',
  customer_praise: 'Customer praise',
  discretionary: 'Recognition award',
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
  if (s.barbs.discretionaryMax < s.barbs.discretionaryMin) e['barbs.discretionaryMax'] = 'The most cannot be below the least.';
  if (!whole(s.notesPaidPerMonth, 0, 31)) e.notesPaidPerMonth = 'A whole number from 0 to 31.';
  if (typeof s.storeOpen !== 'boolean') e.storeOpen = 'Open or closed.';
  if (!whole(s.coursesPerYear, 0, 12)) e.coursesPerYear = 'A whole number from 0 to 12.';
  if (!whole(s.discretionaryBudgetPerSite, 0, 100_000)) e.discretionaryBudgetPerSite = 'A whole number of barbs.';
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

// --- Thuthuka notes and awards approved by a person ----------------------------------------

/** A Thuthuka note's journey (rule book): sent, looked at, then adopted or declined with a reason. */
export const NOTE_STATUSES = ['sent', 'under_review', 'adopted', 'declined'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];
export const NOTE_STATUS_LABELS: Record<NoteStatus, string> = { sent: 'Sent', under_review: 'Being looked at', adopted: 'Adopted', declined: 'Not taken up' };

export interface NoteInput {
  noticed: string;
  suggestion: string;
  improves: string;
}

export function noteErrors(n: NoteInput): Record<string, string> {
  const e: Record<string, string> = {};
  if (n.noticed.trim().length < 5) e.noticed = 'Say what you noticed.';
  if (n.suggestion.trim().length < 5) e.suggestion = 'Say what you suggest.';
  if (n.improves.trim().length < 3) e.improves = 'Say what it would make better.';
  return e;
}

/** Kinds of award that wait for a person's approval (rule book). */
export const AWARD_KINDS = ['customer_praise', 'discretionary'] as const;
export type AwardKind = (typeof AWARD_KINDS)[number];
export const AWARD_KIND_LABELS: Record<AwardKind, string> = { customer_praise: 'Customer praise', discretionary: 'Recognition award' };

/** The barbs an award pays: praise is fixed; a recognition award must sit inside the allowed range. */
export function awardBarbsError(kind: AwardKind, barbs: number, s: WireSettings): string | null {
  if (kind === 'customer_praise') return null;
  if (!Number.isInteger(barbs) || barbs < s.barbs.discretionaryMin || barbs > s.barbs.discretionaryMax) {
    return `A recognition award is ${s.barbs.discretionaryMin} to ${s.barbs.discretionaryMax} barbs.`;
  }
  return null;
}

/** The system suggests a recognition award every third month in a row at the standard. */
export function suggestsRecognition(streak: number): boolean {
  return streak >= 3 && streak % 3 === 0;
}

// --- Goals and the store (step 3) ----------------------------------------------------------

/**
 * One row of the owner's goals and store table. A row is a goal a guard can choose; if it has a
 * barb price and is "in the store", it can also be handed in for. The rand cost is the company's
 * only and never goes to the guard's phone.
 */
export interface WireItem {
  id: string;
  name: string;
  category: WireItemCategory;
  /** Barbs to hand in for it; 0 for a goal that is not bought (a milestone). */
  barbs: number;
  /** Months of service before it opens. */
  monthsService: number;
  /** Barbs he must have on his Wire (not spend) before it opens. */
  wireAtLeast: number;
  /** PSIRA grade he must already hold, or null. A is the highest. */
  needsGrade: string | null;
  /** Months in a row at the standard, or 0. */
  monthsAtStandard: number;
  /** A training record he must hold (a qualification type such as pre_employment), or null. */
  needsTraining: string | null;
  inStore: boolean;
  active: boolean;
}

export const WIRE_ITEM_CATEGORIES = ['airtime', 'data', 'voucher', 'kit', 'training', 'milestone', 'other'] as const;
export type WireItemCategory = (typeof WIRE_ITEM_CATEGORIES)[number];
export const WIRE_ITEM_CATEGORY_LABELS: Record<WireItemCategory, string> = {
  airtime: 'Airtime',
  data: 'Data',
  voucher: 'Vouchers',
  kit: 'Kit upgrades',
  training: 'Training and grades',
  milestone: 'Milestones',
  other: 'Other',
};

/**
 * The rule book's store and the insignia, as a first table for the owner to change. Barb prices
 * and costs are placeholders; the grade each course needs is a guess for the owner to check
 * against PSIRA's rules.
 */
export const DEFAULT_WIRE_ITEMS: (Omit<WireItem, 'id' | 'active'> & { costRand: number | null })[] = [
  { name: 'Airtime, own number', category: 'airtime', barbs: 50, costRand: 50, monthsService: 3, wireAtLeast: 0, needsGrade: null, monthsAtStandard: 0, needsTraining: null, inStore: true },
  { name: 'Airtime, family or friends', category: 'airtime', barbs: 50, costRand: 50, monthsService: 3, wireAtLeast: 100, needsGrade: null, monthsAtStandard: 0, needsTraining: null, inStore: true },
  { name: 'Data bundle, 1 GB', category: 'data', barbs: 75, costRand: 89, monthsService: 3, wireAtLeast: 0, needsGrade: null, monthsAtStandard: 0, needsTraining: null, inStore: true },
  { name: 'Grocery voucher', category: 'voucher', barbs: 500, costRand: 500, monthsService: 6, wireAtLeast: 0, needsGrade: null, monthsAtStandard: 0, needsTraining: null, inStore: true },
  { name: 'Tactical torch', category: 'kit', barbs: 150, costRand: null, monthsService: 0, wireAtLeast: 0, needsGrade: null, monthsAtStandard: 0, needsTraining: null, inStore: true },
  { name: 'Premium boots', category: 'kit', barbs: 300, costRand: 1400, monthsService: 0, wireAtLeast: 0, needsGrade: null, monthsAtStandard: 0, needsTraining: null, inStore: true },
  { name: 'First aid course', category: 'training', barbs: 150, costRand: null, monthsService: 0, wireAtLeast: 0, needsGrade: null, monthsAtStandard: 0, needsTraining: null, inStore: true },
  { name: 'Advanced CCTV course', category: 'training', barbs: 250, costRand: null, monthsService: 6, wireAtLeast: 0, needsGrade: null, monthsAtStandard: 0, needsTraining: null, inStore: true },
  { name: 'PSIRA Grade B course', category: 'training', barbs: 200, costRand: 1380, monthsService: 6, wireAtLeast: 0, needsGrade: 'C', monthsAtStandard: 0, needsTraining: null, inStore: true },
  { name: 'PSIRA Grade A course', category: 'training', barbs: 300, costRand: 1500, monthsService: 12, wireAtLeast: 0, needsGrade: 'B', monthsAtStandard: 0, needsTraining: null, inStore: true },
  { name: 'Silver barb', category: 'milestone', barbs: 0, costRand: null, monthsService: 0, wireAtLeast: 1000, needsGrade: null, monthsAtStandard: 0, needsTraining: null, inStore: false },
  { name: 'Gold barb', category: 'milestone', barbs: 0, costRand: null, monthsService: 0, wireAtLeast: 5000, needsGrade: null, monthsAtStandard: 0, needsTraining: null, inStore: false },
];

export function wireItemErrors(i: Omit<WireItem, 'id'>): Record<string, string> {
  const e: Record<string, string> = {};
  if (i.name.trim().length < 2) e.name = 'Give it a name.';
  if (!WIRE_ITEM_CATEGORIES.includes(i.category)) e.category = 'Choose a kind.';
  if (!whole(i.barbs, 0, 100_000)) e.barbs = 'A whole number of barbs.';
  if (!whole(i.monthsService, 0, 600)) e.monthsService = 'A whole number of months.';
  if (!whole(i.wireAtLeast, 0, 10_000_000)) e.wireAtLeast = 'A whole number of barbs.';
  if (!whole(i.monthsAtStandard, 0, 120)) e.monthsAtStandard = 'A whole number of months.';
  if (i.needsGrade !== null && !['A', 'B', 'C', 'D', 'E'].includes(i.needsGrade)) e.needsGrade = 'Grade C, B or A, or none.';
  if (i.inStore && i.barbs <= 0) e.barbs = 'Something in the store needs a barb price.';
  if (i.needsTraining !== null && !(i.needsTraining in QUALIFICATION_TYPES)) e.needsTraining = 'Choose a kind of training, or none.';
  return e;
}

/** Where a guard stands, for working out his goal. */
export interface GoalGuard {
  grade: string | null;
  monthsService: number;
  wireTotal: number;
  available: number;
  streak: number;
  /** Barbs a month at his recent pace. */
  pace: number;
  /** Courses he handed in for in the last twelve months. */
  coursesThisYear: number;
  /** Kinds of training he holds now (not expired), such as pre_employment or armed_response. */
  training?: string[];
}

export interface GoalStep {
  label: string;
  done: boolean;
  /** What is still to come, said positively. */
  toGo: string | null;
}

const GRADE_RANK: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, E: 5 };

/** 1000 as "1,000", the same on every machine. */
function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function months(n: number): string {
  return `${n} month${n === 1 ? '' : 's'}`;
}

/**
 * The steps to a goal, each done or still to come, and whether he is ready. Nothing is phrased
 * as a failure: an unmet step says what is still to come.
 */
export function goalProgress(item: Omit<WireItem, 'id'>, g: GoalGuard, s: WireSettings) {
  const steps: GoalStep[] = [];
  const atPace = (n: number) => (g.pace > 0 ? `about ${months(Math.ceil(n / g.pace))} at your pace` : 'it comes with every shift');
  if (item.needsGrade) {
    const done = !!g.grade && (GRADE_RANK[g.grade] ?? 9) <= GRADE_RANK[item.needsGrade];
    steps.push({ label: `Grade ${item.needsGrade}`, done, toGo: done ? null : `Grade ${item.needsGrade} first` });
  }
  if (item.needsTraining) {
    const label = QUALIFICATION_TYPES[item.needsTraining as keyof typeof QUALIFICATION_TYPES] ?? item.needsTraining;
    const done = (g.training ?? []).includes(item.needsTraining);
    steps.push({ label, done, toGo: done ? null : `${label} first` });
  }
  if (item.monthsService > 0) {
    const done = g.monthsService >= item.monthsService;
    steps.push({ label: `${months(item.monthsService)} of service`, done, toGo: done ? null : `opens in ${months(item.monthsService - g.monthsService)}` });
  }
  if (item.monthsAtStandard > 0) {
    const done = g.streak >= item.monthsAtStandard;
    steps.push({ label: `${months(item.monthsAtStandard)} in a row at the standard`, done, toGo: done ? null : `${g.streak} so far` });
  }
  if (item.wireAtLeast > 0) {
    const done = g.wireTotal >= item.wireAtLeast;
    const left = item.wireAtLeast - g.wireTotal;
    steps.push({ label: `${thousands(item.wireAtLeast)} barbs on your Wire`, done, toGo: done ? null : `${thousands(left)} to go, ${atPace(left)}` });
  }
  if (item.category === 'training' && item.inStore) {
    const done = g.coursesThisYear < s.coursesPerYear;
    steps.push({ label: 'Your course for this year', done, toGo: done ? null : 'opens again twelve months after your last course' });
  }
  if (item.barbs > 0) {
    const done = g.available >= item.barbs;
    const left = item.barbs - g.available;
    steps.push({ label: `${thousands(item.barbs)} barbs available`, done, toGo: done ? null : `${Math.max(0, g.available)} of ${item.barbs}, ${atPace(left)}` });
  }
  const ready = steps.every((x) => x.done);
  // The months still to go: the longest of the steps that time alone or earning will finish.
  const waits: number[] = [];
  if (!ready) {
    if (item.monthsService > g.monthsService) waits.push(item.monthsService - g.monthsService);
    if (item.monthsAtStandard > g.streak) waits.push(item.monthsAtStandard - g.streak);
    const barbsLeft = Math.max(item.barbs - g.available, item.wireAtLeast - g.wireTotal, 0);
    if (barbsLeft > 0) waits.push(g.pace > 0 ? Math.ceil(barbsLeft / g.pace) : Infinity);
  }
  const blockedByGrade = steps.some((x) => !x.done && x.toGo?.endsWith(' first'));
  const monthsToGo = ready ? 0 : blockedByGrade || waits.some((w) => !Number.isFinite(w)) ? null : Math.max(0, ...waits);
  return { steps, ready, monthsToGo };
}

// --- The recognition board (step 4) --------------------------------------------------------

/**
 * The most improved guards of a month, each measured against his own three-month average. Only
 * guards who improved are listed, so the board never has a last place.
 */
export function mostImproved<T extends { overall: number; average: number | null }>(rows: T[], n = 5): (T & { improvedBy: number })[] {
  return rows
    .filter((r) => r.average !== null && r.overall - r.average > 0)
    .map((r) => ({ ...r, improvedBy: round1(r.overall - (r.average as number)) }))
    .sort((a, b) => b.improvedBy - a.improvedBy)
    .slice(0, n);
}

/** Wire milestones passed going from one total to another: silver, gold and every further 1,000. */
export function milestonesCrossed(before: number, after: number, s: WireSettings): { at: number; label: string }[] {
  const marks = new Set<number>([s.silver, s.gold]);
  for (let t = 1000; t <= after; t += 1000) if (t > s.silver) marks.add(t);
  return [...marks]
    .filter((t) => before < t && t <= after)
    .sort((a, b) => a - b)
    .map((t) => ({ at: t, label: t === s.gold ? 'Gold barb' : t === s.silver ? 'Silver barb' : `${thousands(t)} barbs on the Wire` }));
}

/**
 * How a guard appears on the board (rule book): by name only if he chose to be shown, and with his
 * site only to guards of the same site; everyone else sees his region.
 */
export function boardName(g: { name: string; showName: boolean; siteName: string | null; region: string | null }, sameSite: boolean): string {
  const where = sameSite ? g.siteName : g.region;
  const who = g.showName ? g.name : 'A guard';
  return where ? `${who}, ${where}` : who;
}
