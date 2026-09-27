import { addDays, addWorkingDays, computeScore, DEFAULT_SCORING, isWorkingDay, mergeScoring, position, saPublicHolidays, scoringErrors } from './index';

const T = '2026-09-28';

describe('score (section 6.8)', () => {
  it('starts at 80 with no events', () => {
    expect(computeScore([], T)).toMatchObject({ score: 80, position: 'ON_PAR', counted: 0 });
  });
  it('adds points from the last 30 days only, today included', () => {
    const r = computeScore(
      [
        { date: T, impact: 1 },
        { date: addDays(T, -29), impact: 1 },
        { date: addDays(T, -30), impact: 1 },
        { date: addDays(T, 1), impact: 1 },
      ],
      T,
    );
    expect(r.score).toBe(82);
    expect(r.from).toBe(addDays(T, -29));
  });
  it('holds each day within ±5 (scenario 15)', () => {
    const busy = Array.from({ length: 8 }, () => ({ date: T, impact: 1 }));
    expect(computeScore(busy, T)).toMatchObject({ score: 85, counted: 5, cappedOff: 3 });
    const bad = Array.from({ length: 4 }, () => ({ date: T, impact: -2 }));
    expect(computeScore(bad, T)).toMatchObject({ score: 75, counted: -5, cappedOff: -3 });
  });
  it('lets a reversal on the same day offset the original', () => {
    expect(computeScore([{ date: T, impact: -1 }, { date: T, impact: 1 }], T).score).toBe(80);
  });
  it('keeps the score between 0 and 120', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ date: addDays(T, -i), impact: 5 }));
    expect(computeScore(many, T).score).toBe(120);
    const worst = Array.from({ length: 30 }, (_, i) => ({ date: addDays(T, -i), impact: -5 }));
    expect(computeScore(worst, T).score).toBe(0);
  });
  it('keeps fractions (patrol points) to two decimals', () => {
    expect(computeScore([{ date: T, impact: 6 / 13 }, { date: T, impact: 6 / 13 }], T).score).toBe(80.92);
  });
});

describe('positions', () => {
  it('Above Par 90+, On Par 70–89, Needs Attention below 70', () => {
    expect(position(90)).toBe('ABOVE_PAR');
    expect(position(89.99)).toBe('ON_PAR');
    expect(position(70)).toBe('ON_PAR');
    expect(position(69.5)).toBe('NEEDS_ATTENTION');
  });
});

describe('company settings', () => {
  it('fills in defaults and applies overrides', () => {
    const c = mergeScoring({ points: { late: -2 } as never, dailyCap: 4 });
    expect(c.points.late).toBe(-2);
    expect(c.points.on_time).toBe(1);
    expect(c.dailyCap).toBe(4);
  });
  it('accepts the defaults', () => {
    expect(scoringErrors(DEFAULT_SCORING)).toEqual({});
  });
  it('keeps positive events positive and negative ones negative', () => {
    const e = scoringErrors(mergeScoring({ points: { on_time: -1, late: 2 } as never }));
    expect(Object.keys(e).sort()).toEqual(['points.late', 'points.on_time']);
  });
  it('keeps the positions in order', () => {
    expect(scoringErrors(mergeScoring({ onParFrom: 95 })).aboveParFrom).toBeDefined();
  });
});

describe('working days (answer within 3 working days)', () => {
  it('knows SA public holidays, including Easter and Sunday → Monday', () => {
    const h = saPublicHolidays(2026);
    expect(h.has('2026-04-03')).toBe(true); // Good Friday
    expect(h.has('2026-04-06')).toBe(true); // Family Day
    expect(h.has('2026-04-27')).toBe(true); // Freedom Day
    expect(h.has('2026-08-10')).toBe(true); // Women's Day 9 Aug is a Sunday
    expect(h.has('2026-09-24')).toBe(true);
  });
  it('skips weekends and holidays', () => {
    expect(isWorkingDay('2026-09-26')).toBe(false); // Saturday
    expect(isWorkingDay('2026-09-24')).toBe(false); // Heritage Day
    expect(addWorkingDays('2026-09-25', 3)).toBe('2026-09-30'); // Fri → Mon, Tue, Wed
    expect(addWorkingDays('2026-09-23', 1)).toBe('2026-09-25'); // skips Heritage Day
  });
});
