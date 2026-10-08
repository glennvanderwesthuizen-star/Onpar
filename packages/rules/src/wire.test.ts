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
  mostImproved,
  milestonesCrossed,
  boardName,
  goalProgress,
  wireItemErrors,
  DEFAULT_WIRE_ITEMS,
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

  it('a goal is a list of steps, each done or still to come, and says when he is ready', () => {
    const gradeB = DEFAULT_WIRE_ITEMS.find((i) => i.name === 'PSIRA Grade B course')!;
    const guard = { grade: 'C', monthsService: 8, wireTotal: 400, available: 120, streak: 2, pace: 80, coursesThisYear: 0 };
    const p = goalProgress({ ...gradeB, active: true }, guard, s);
    expect(p.steps.map((x) => [x.label, x.done])).toEqual([
      ['Grade C', true],
      ['6 months of service', true],
      ['Your course for this year', true],
      ['200 barbs available', false],
    ]);
    expect(p.steps[3].toGo).toBe('120 of 200, about 1 month at your pace');
    expect(p.monthsToGo).toBe(1);
    expect(p.ready).toBe(false);
    expect(goalProgress({ ...gradeB, active: true }, { ...guard, available: 250 }, s).ready).toBe(true);
    // A Grade D guard needs Grade C first: no promise of a date.
    const d = goalProgress({ ...gradeB, active: true }, { ...guard, grade: 'D' }, s);
    expect(d.steps[0]).toEqual({ label: 'Grade C', done: false, toGo: 'Grade C first' });
    expect(d.monthsToGo).toBeNull();
    // Service still to come, and no wording of failure anywhere.
    const early = goalProgress({ ...gradeB, active: true }, { ...guard, monthsService: 2 }, s);
    expect(early.steps[1].toGo).toBe('opens in 4 months');
    expect(early.monthsToGo).toBe(4);
    expect(JSON.stringify(early)).not.toMatch(/fail|cannot|not allowed|refused/i);
    // The silver barb is a goal, not bought.
    const silver = goalProgress({ ...DEFAULT_WIRE_ITEMS.find((i) => i.name === 'Silver barb')!, active: true }, guard, s);
    expect(silver.steps).toEqual([{ label: '1,000 barbs on your Wire', done: false, toGo: '600 to go, about 8 months at your pace' }]);
    // One course a year.
    expect(goalProgress({ ...gradeB, active: true }, { ...guard, available: 250, coursesThisYear: 1 }, s).ready).toBe(false);
  });

  it('a goal can need a kind of training, such as pre-employment training', () => {
    const armed = { name: 'Armed response course', category: 'training' as const, barbs: 250, monthsService: 0, wireAtLeast: 0, needsGrade: 'B', monthsAtStandard: 0, needsTraining: 'pre_employment', inStore: true, active: true };
    const guard = { grade: 'B', monthsService: 8, wireTotal: 400, available: 300, streak: 0, pace: 80, coursesThisYear: 0 };
    const without = goalProgress(armed, guard, s);
    expect(without.steps[1]).toEqual({ label: 'Pre-employment training', done: false, toGo: 'Pre-employment training first' });
    expect(without.monthsToGo).toBeNull();
    expect(goalProgress(armed, { ...guard, training: ['pre_employment'] }, s).ready).toBe(true);
    expect(wireItemErrors({ ...armed, needsTraining: 'juggling' })).toHaveProperty('needsTraining');
  });

  it('checks a row of the goals and store table, and the store starts closed', () => {
    expect(DEFAULT_WIRE_ITEMS.every((i) => Object.keys(wireItemErrors({ ...i, active: true })).length === 0)).toBe(true);
    expect(wireItemErrors({ ...DEFAULT_WIRE_ITEMS[0], barbs: 0, active: true })).toHaveProperty('barbs');
    expect(wireItemErrors({ ...DEFAULT_WIRE_ITEMS[0], needsGrade: 'Z', active: true })).toHaveProperty('needsGrade');
    expect(s.storeOpen).toBe(false);
  });

  it('the board lists only guards who improved, best first, and never a last place', () => {
    const rows = [
      { id: 'a', overall: 90, average: 80 },
      { id: 'b', overall: 70, average: 75 },
      { id: 'c', overall: 85, average: null },
      { id: 'd', overall: 96, average: 95 },
    ];
    expect(mostImproved(rows).map((r) => [r.id, r.improvedBy])).toEqual([
      ['a', 10],
      ['d', 1],
    ]);
  });

  it('milestones: silver, gold and every further 1,000; names only when chosen; region outside his site', () => {
    expect(milestonesCrossed(950, 1010, s)).toEqual([{ at: 1000, label: 'Silver barb' }]);
    expect(milestonesCrossed(1990, 2010, s)).toEqual([{ at: 2000, label: '2,000 barbs on the Wire' }]);
    expect(milestonesCrossed(4990, 6010, s).map((m) => m.label)).toEqual(['Gold barb', '6,000 barbs on the Wire']);
    expect(milestonesCrossed(100, 200, s)).toEqual([]);
    const g = { name: 'Sipho Dlamini', showName: false, siteName: 'Estate ABC', region: 'Gauteng' };
    expect(boardName(g, true)).toBe('A guard, Estate ABC');
    expect(boardName({ ...g, showName: true }, false)).toBe('Sipho Dlamini, Gauteng');
  });

  it('checks settings', () => {
    expect(wireSettingsErrors(s)).toEqual({});
    expect(wireSettingsErrors(mergeWire({ gold: 900 }))).toHaveProperty('gold');
    expect(wireSettingsErrors(mergeWire({ barbs: { improvement: -5 } }))).toHaveProperty(['barbs.improvement']);
  });
});
