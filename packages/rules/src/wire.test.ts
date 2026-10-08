import {
  DEFAULT_WIRE,
  EMPTY_RUN,
  MonthFacts,
  bobWireMonth,
  bobWireMonthsTo,
  completedYears,
  entryBarbs,
  insignia,
  isReadyForDuty,
  mergeWire,
  monthAward,
  monthBarbs,
  monthlyScore,
  monthsTo,
  shiftBarbs,
  simulateGuard,
  wireSettingsErrors,
  noteErrors,
  awardBarbsError,
  suggestsRecognition,
  WireRun,
} from './wire';

const s = DEFAULT_WIRE;
const perfect: MonthFacts = { rostered: 20, worked: 20, noShows: 0, ready: 20, dutiesComplete: 20, cleanHandover: 20, tasksAllocated: 30, tasksDone: 30, itemsRaised: 4, itemsHandled: 4, newSkills: 0, anniversary: false };

describe('The Wire', () => {
  it('a shift earns up to three barbs, and a shift that earned nothing writes nothing', () => {
    expect(shiftBarbs({ readyForDuty: true, dutiesComplete: true, cleanHandover: true }, s).map((e) => e.barbs)).toEqual([1, 1, 1]);
    expect(shiftBarbs({ readyForDuty: false, dutiesComplete: false, cleanHandover: false }, s)).toEqual([]);
  });

  it('ready for duty means on duty 15 minutes before the start; on the hour earns nothing', () => {
    const start = new Date('2026-10-08T06:00:00+02:00');
    expect(isReadyForDuty(new Date('2026-10-08T05:40:00+02:00'), start, s)).toBe(true);
    expect(isReadyForDuty(new Date('2026-10-08T05:45:00+02:00'), start, s)).toBe(true);
    expect(isReadyForDuty(new Date('2026-10-08T06:00:00+02:00'), start, s)).toBe(false);
    expect(isReadyForDuty(new Date('2026-10-08T05:00:00+02:00'), null, s)).toBe(false);
  });

  it('the monthly score is two equal pillars, leaving out what there is nothing to count', () => {
    expect(monthlyScore(perfect, s)).toEqual({ attendance: 100, job: 100, overall: 100 });
    const late = { ...perfect, ready: 10 };
    expect(monthlyScore(late, s)!.attendance).toBe(85);
    // No tasks and no reports: the score is attendance alone.
    expect(monthlyScore({ ...perfect, tasksAllocated: 0, tasksDone: 0, itemsRaised: 0, itemsHandled: 0 }, s)).toEqual({ attendance: 100, job: null, overall: 100 });
    // No reports raised: job performance is tasks alone.
    expect(monthlyScore({ ...perfect, tasksDone: 15, itemsRaised: 0, itemsHandled: 0 }, s)!.job).toBe(50);
    expect(monthlyScore({ ...perfect, rostered: 0, worked: 0 }, s)).toBeNull();
  });

  it('the standard award grows by 5 each month in a row up to 40, and is never paid with the improvement award', () => {
    let run = EMPTY_RUN;
    const paid: number[] = [];
    for (const m of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']) {
      const a = monthAward(m, 97, run, s);
      expect(a.award).toBe('standard');
      paid.push(a.barbs);
      run = a.next;
    }
    expect(paid).toEqual([20, 25, 30, 35, 40, 40]);
  });

  it('one short month in twelve keeps the run; a second resets it', () => {
    let run: WireRun = { streak: 3, graceMonth: null, history: [96, 96, 96] };
    let a = monthAward('2026-04', 90, run, s);
    expect(a.award).toBeNull();
    expect(a.next.streak).toBe(3);
    a = monthAward('2026-05', 96, a.next, s);
    expect(a.barbs).toBe(35);
    a = monthAward('2026-06', 90, a.next, s);
    expect(a.next.streak).toBe(0);
    run = a.next;
    expect(monthAward('2026-07', 96, run, s).barbs).toBe(20);
  });

  it('improvement is beating his own three-month average by a point; one bad month cannot set up an easy win', () => {
    expect(monthAward('2026-04', 81, { ...EMPTY_RUN, history: [70, 80, 90] }, s)).toMatchObject({ award: 'improvement', barbs: 20, average: 80 });
    expect(monthAward('2026-04', 80.5, { ...EMPTY_RUN, history: [70, 80, 90] }, s).award).toBeNull();
    // A poor month drags the average only a third of the way.
    expect(monthAward('2026-04', 70, { ...EMPTY_RUN, history: [85, 85, 40] }, s).award).toBeNull();
    // The first month has nothing to beat.
    expect(monthAward('2026-01', 90, EMPTY_RUN, s).award).toBeNull();
  });

  it('a steady month at the standard earns about what the rule book says, and nothing is ever negative', () => {
    const r = monthBarbs('2026-01', perfect, EMPTY_RUN, s);
    expect(r.entries).toEqual([
      { rule: 'standard', barbs: 20 },
      { rule: 'long_service', barbs: 2 },
    ]);
    const poor = monthBarbs('2026-02', { ...perfect, worked: 5, noShows: 15, ready: 0, tasksDone: 0 }, r.run, s);
    expect(poor.entries.every((e) => e.barbs > 0)).toBe(true);
  });

  it('entry barbs come from the recruitment score; launch credit counts completed years', () => {
    expect([95, 85, 72, 50, null].map((x) => entryBarbs(x, s))).toEqual([50, 30, 15, 0, 0]);
    expect(completedYears('2023-10-09', '2026-10-08')).toBe(2);
    expect(completedYears('2023-10-08', '2026-10-08')).toBe(3);
  });

  it('insignia: black, silver at 1,000, gold at 5,000', () => {
    expect([0, 999, 1000, 4999, 5000].map((t) => insignia(t, s))).toEqual(['black', 'black', 'silver', 'silver', 'gold']);
    expect(monthsTo(1000, 100, 90)).toBe(10);
    expect(monthsTo(1000, 100, 0)).toBeNull();
  });

  it('even Bob Wire, earning everything, needs more than three years for gold on today’s values', () => {
    expect(bobWireMonth(20, s)).toBeCloseTo(60 + 40 + 2 + 25 / 12);
    expect(bobWireMonthsTo(s.silver, 20, s)).toBeLessThanOrEqual(12);
    expect(bobWireMonthsTo(s.gold, 20, s)).toBeGreaterThan(36);
  });

  it('a what-if run replays real months under other values', () => {
    const g = { employeeId: 'e1', recruitmentScore: 92, launchYears: 2, months: [{ month: '2026-01', facts: perfect }, { month: '2026-02', facts: perfect }] };
    const now = simulateGuard(g, s);
    expect(now.opening).toEqual({ entry: 50, launch_credit: 100 });
    expect(now.months.map((m) => m.barbs)).toEqual([60 + 20 + 2, 60 + 25 + 2]);
    expect(now.total).toBe(150 + 82 + 87);
    const doubled = simulateGuard(g, mergeWire({ barbs: { readyForDuty: 2 } }));
    expect(doubled.months[0].barbs).toBe(102);
    expect(doubled.months[0].bySource.ready_for_duty).toBe(40);
  });

  it('Thuthuka notes need three answers; recognition awards stay inside the range; suggested every third month at the standard', () => {
    expect(noteErrors({ noticed: 'Gate 3 light is out at night', suggestion: 'Put it on a timer', improves: 'Safety' })).toEqual({});
    expect(Object.keys(noteErrors({ noticed: '', suggestion: 'x', improves: '' }))).toEqual(['noticed', 'suggestion', 'improves']);
    expect(awardBarbsError('discretionary', 10, s)).toBeNull();
    expect(awardBarbsError('discretionary', 20, s)).toMatch(/5 to 15/);
    expect(awardBarbsError('customer_praise', 0, s)).toBeNull();
    expect([1, 2, 3, 4, 6].map(suggestsRecognition)).toEqual([false, false, true, false, true]);
  });

  it('checks settings', () => {
    expect(wireSettingsErrors(s)).toEqual({});
    expect(wireSettingsErrors(mergeWire({ gold: 900 }))).toHaveProperty('gold');
    expect(wireSettingsErrors(mergeWire({ barbs: { improvement: -5 } }))).toHaveProperty(['barbs.improvement']);
  });
});
