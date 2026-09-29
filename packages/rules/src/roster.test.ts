import {
  describePattern,
  guardsByDayError,
  guardsRequiredOn,
  holidaysBetween,
  nextPayrollPeriod,
  parsePattern,
  patternErrors,
  patternSymbolOn,
  payrollPeriod,
  previousPayrollPeriod,
  registerStatus,
  resolveRosterDay,
  rosterClashes,
  RosterAllocation,
  RosterChange,
  RosterShift,
  weekdayIndex,
  weekStart,
  dateRange,
} from './roster';

const DNO = parsePattern('DDDNNNOOO');

describe('pattern validity (scenario 23)', () => {
  it('rejects a night straight into a day', () => {
    expect(patternErrors({ name: 'Bad', sequence: parsePattern('DNDO') }).sequence).toMatch(/Day 2 is a night shift followed straight by a day shift on day 3/);
  });
  it('accepts a day straight into a night', () => {
    expect(patternErrors({ name: '3/3/3', sequence: DNO })).toEqual({});
    expect(patternErrors({ name: 'DN', sequence: parsePattern('DDNNOO') })).toEqual({});
  });
  it('checks the wrap from the last day back to the first', () => {
    expect(patternErrors({ name: 'Wrap', sequence: parsePattern('DDNN') }).sequence).toMatch(/starts again with a day shift/);
    expect(patternErrors({ name: 'Wrap ok', sequence: parsePattern('DDNNO') })).toEqual({});
  });
  it('rejects unknown letters, empty and all-off patterns', () => {
    expect(patternErrors({ name: 'x', sequence: parsePattern('DXO') }).sequence).toMatch(/Use only D/);
    expect(patternErrors({ name: 'x', sequence: [] }).sequence).toMatch(/at least one day/);
    expect(patternErrors({ name: 'x', sequence: ['O', 'O'] }).sequence).toMatch(/at least one day or night/);
    expect(patternErrors({ name: ' ', sequence: DNO }).name).toBeDefined();
  });
  it('describes a pattern in words', () => {
    expect(describePattern(DNO)).toBe('3 day / 3 night / 3 off');
    expect(describePattern(parsePattern('D D D D D, O O'))).toBe('5 day / 2 off');
  });
});

describe('roster computation (scenario 24)', () => {
  it('follows the worked example: positions 1 and 4 start on day and night', () => {
    expect(patternSymbolOn(DNO, '2026-10-01', 1, '2026-10-01')).toBe('D');
    expect(patternSymbolOn(DNO, '2026-10-01', 4, '2026-10-01')).toBe('N');
  });
  it('extends indefinitely and moves forward a week with no re-entry', () => {
    const week = (start: string, pos: number) => dateRange(start, `2026-10-${String(Number(start.slice(8)) + 6).padStart(2, '0')}`).map((d) => patternSymbolOn(DNO, '2026-10-01', pos, d)).join('');
    expect(week('2026-10-01', 1)).toBe('DDDNNNO');
    expect(week('2026-10-08', 1)).toBe('OODDDNN');
    expect(week('2026-10-01', 4)).toBe('NNNOOOD');
    // Far in the future: 900 days later is 100 whole cycles, so the same slot.
    expect(patternSymbolOn(DNO, '2026-10-01', 1, '2029-03-19')).toBe('D');
  });
  it('is not rostered before the start date', () => {
    expect(patternSymbolOn(DNO, '2026-10-01', 1, '2026-09-30')).toBeNull();
  });
});

const siteA = 'A';
const siteB = 'B';
const shifts: RosterShift[] = [
  { id: 'a-day', siteId: siteA, name: 'Day', kind: 'day', startTime: '06:00', endTime: '18:00' },
  { id: 'a-night', siteId: siteA, name: 'Night', kind: 'night', startTime: '18:00', endTime: '06:00' },
  { id: 'b-day', siteId: siteB, name: 'Morning', kind: 'day', startTime: '07:00', endTime: '15:00' },
  { id: 'b-late', siteId: siteB, name: 'Late', kind: 'day', startTime: '14:00', endTime: '22:00', sortOrder: 1 },
];
const alloc: RosterAllocation = { id: 'al', siteId: siteA, sequence: DNO, startDate: '2026-10-01', endDate: null, position: 1 };

describe('resolving a day (scenario 25 and D-25)', () => {
  it('maps D and N to the site shifts of that kind', () => {
    const d = resolveRosterDay('2026-10-01', [alloc], [], shifts);
    expect(d).toMatchObject({ status: 'working', source: 'pattern', shiftId: 'a-day' });
    expect(resolveRosterDay('2026-10-04', [alloc], [], shifts)).toMatchObject({ status: 'working', shiftId: 'a-night' });
    expect(resolveRosterDay('2026-10-07', [alloc], [], shifts)).toMatchObject({ status: 'off', siteId: siteA });
  });
  it('a one-off change affects only that date', () => {
    const change: RosterChange = { id: 'c1', date: '2026-10-02', weekday: null, fromDate: null, untilDate: null, shiftId: 'b-day' };
    const days = dateRange('2026-10-01', '2026-10-09').map((d) => resolveRosterDay(d, [alloc], [change], shifts));
    const plain = dateRange('2026-10-01', '2026-10-09').map((d) => resolveRosterDay(d, [alloc], [], shifts));
    expect(days[1]).toMatchObject({ status: 'working', source: 'change', siteId: siteB, shiftId: 'b-day' });
    days.forEach((d, i) => i !== 1 && expect(d).toEqual(plain[i]));
  });
  it('a weekly change repeats on its weekday within its dates, and a one-off beats it', () => {
    // 2026-10-10 is a Saturday.
    expect(weekdayIndex('2026-10-10')).toBe(5);
    const weekly: RosterChange = { id: 'w', date: null, weekday: 5, fromDate: '2026-10-01', untilDate: '2026-10-31', shiftId: 'b-late' };
    expect(resolveRosterDay('2026-10-10', [alloc], [weekly], shifts)).toMatchObject({ source: 'weekly', shiftId: 'b-late' });
    expect(resolveRosterDay('2026-10-17', [alloc], [weekly], shifts)).toMatchObject({ source: 'weekly' });
    expect(resolveRosterDay('2026-11-07', [alloc], [weekly], shifts)).toMatchObject({ source: 'pattern' });
    const off: RosterChange = { id: 'o', date: '2026-10-17', weekday: null, fromDate: null, untilDate: null, shiftId: null };
    expect(resolveRosterDay('2026-10-17', [alloc], [weekly, off], shifts)).toMatchObject({ status: 'off', source: 'change' });
  });
  it('a relief guard with no pattern can still be placed for a day', () => {
    const change: RosterChange = { id: 'c', date: '2026-10-05', weekday: null, fromDate: null, untilDate: null, shiftId: 'b-day' };
    expect(resolveRosterDay('2026-10-05', [], [change], shifts)).toMatchObject({ status: 'working', siteId: siteB });
    expect(resolveRosterDay('2026-10-06', [], [change], shifts)).toMatchObject({ status: 'not_rostered' });
  });
  it('uses the allocation that applied on the date', () => {
    const old: RosterAllocation = { ...alloc, id: 'old', endDate: '2026-10-05' };
    const moved: RosterAllocation = { ...alloc, id: 'new', siteId: siteB, startDate: '2026-10-05', position: 1 };
    expect(resolveRosterDay('2026-10-04', [old, moved], [], shifts)).toMatchObject({ siteId: siteA });
    expect(resolveRosterDay('2026-10-05', [old, moved], [], shifts)).toMatchObject({ siteId: siteB, shiftId: 'b-day' });
  });
  it('uses the chosen shift when a site has two of a kind', () => {
    const atB = { ...alloc, siteId: siteB, dayShiftId: 'b-late' };
    expect(resolveRosterDay('2026-10-01', [atB], [], shifts)).toMatchObject({ shiftId: 'b-late' });
    expect(resolveRosterDay('2026-10-01', [{ ...atB, dayShiftId: null }], [], shifts)).toMatchObject({ shiftId: 'b-day' });
  });
  it('flags a pattern night at a site with no night shift', () => {
    const atB = { ...alloc, siteId: siteB };
    expect(resolveRosterDay('2026-10-04', [atB], [], shifts)).toMatchObject({ status: 'unmapped', kind: 'night' });
  });
});

describe('rest checks (D-25: always blocked)', () => {
  const day = (date: string, change: RosterChange[] = []) => resolveRosterDay(date, [alloc], change, shifts);
  it('finds a day shift placed straight after a night shift', () => {
    // 4 Oct is a night; move 5 Oct from night to Site B's day.
    const c: RosterChange = { id: 'c', date: '2026-10-05', weekday: null, fromDate: null, untilDate: null, shiftId: 'b-day' };
    const clashes = rosterClashes(dateRange('2026-10-03', '2026-10-07').map((d) => day(d, [c])));
    expect(clashes).toHaveLength(1);
    expect(clashes[0].message).toMatch(/day shift straight after the night shift of 2026-10-04/);
  });
  it('allows the pattern itself, including day into night', () => {
    expect(rosterClashes(dateRange('2026-10-01', '2026-10-30').map((d) => day(d)))).toEqual([]);
  });
  it('uses real times: a late shift overlapping a night that ends the next morning', () => {
    const nightB: RosterShift = { id: 'b-night', siteId: siteB, name: 'Graveyard', kind: 'night', startTime: '22:00', endTime: '08:00' };
    const s = [...shifts, nightB];
    const c1: RosterChange = { id: '1', date: '2026-10-07', weekday: null, fromDate: null, untilDate: null, shiftId: 'b-night' };
    const c2: RosterChange = { id: '2', date: '2026-10-08', weekday: null, fromDate: null, untilDate: null, shiftId: 'a-night' };
    const days = ['2026-10-07', '2026-10-08'].map((d) => resolveRosterDay(d, [alloc], [c1, c2], s));
    expect(rosterClashes(days)).toEqual([]);
    const c3: RosterChange = { id: '3', date: '2026-10-07', weekday: null, fromDate: null, untilDate: null, shiftId: 'b-late' };
    const c4: RosterChange = { id: '4', date: '2026-10-06', weekday: null, fromDate: null, untilDate: null, shiftId: 'b-night' };
    // Night 22:00–08:00 on the 6th, then a Day-tagged 14:00 shift on the 7th: still a night into a day, so blocked.
    expect(rosterClashes(['2026-10-06', '2026-10-07'].map((d) => resolveRosterDay(d, [alloc], [c3, c4], s)))).toHaveLength(1);
  });
});

describe('guards needed per day (D-20)', () => {
  const holidays = holidaysBetween('2026-01-01', '2026-12-31');
  const shift = { guardsRequired: 3, guardsByDay: [3, 3, 3, 3, 3, 2, 2, 1] };
  it('uses the weekday figure, the public holiday figure, then a single-date change', () => {
    expect(guardsRequiredOn(shift, '2026-10-05', holidays)).toBe(3); // Monday
    expect(guardsRequiredOn(shift, '2026-10-11', holidays)).toBe(2); // Sunday
    expect(guardsRequiredOn(shift, '2026-09-24', holidays)).toBe(1); // Heritage Day, a Thursday
    expect(guardsRequiredOn(shift, '2026-10-05', holidays, 5)).toBe(5);
    expect(guardsRequiredOn({ guardsRequired: 4, guardsByDay: null }, '2026-10-11', holidays)).toBe(4);
  });
  it('validates the per-day list', () => {
    expect(guardsByDayError(null)).toBeNull();
    expect(guardsByDayError([1, 1, 1, 1, 1, 0, 0, 0])).toBeNull();
    expect(guardsByDayError([1, 1])).toMatch(/each day/);
    expect(guardsByDayError([0, 0, 0, 0, 0, 0, 0, 0])).toMatch(/At least one/);
    expect(guardsByDayError([1, 1, 1, 1, 1, 1, 1, -1])).toMatch(/0 or more/);
  });
});

describe('payroll period (scenario 32)', () => {
  it('26 Aug to 25 Sep contains 19 Sep and is 31 days', () => {
    const p = payrollPeriod('2026-09-19', 26);
    expect(p).toEqual({ start: '2026-08-26', end: '2026-09-25', days: 31 });
    expect(nextPayrollPeriod(p, 26).start).toBe('2026-09-26');
    expect(previousPayrollPeriod(p, 26).start).toBe('2026-07-26');
  });
  it('handles the start day itself, year ends and other start days', () => {
    expect(payrollPeriod('2026-09-26', 26).start).toBe('2026-09-26');
    expect(payrollPeriod('2027-01-10', 26)).toEqual({ start: '2026-12-26', end: '2027-01-25', days: 31 });
    expect(payrollPeriod('2027-03-01', 26)).toEqual({ start: '2027-02-26', end: '2027-03-25', days: 28 });
    expect(payrollPeriod('2026-09-19', 1)).toEqual({ start: '2026-09-01', end: '2026-09-30', days: 30 });
  });
  it('changing the start day changes the period', () => {
    expect(payrollPeriod('2026-09-19', 15).start).toBe('2026-09-15');
  });
  it('weeks start on Monday', () => {
    expect(weekStart('2026-10-04')).toBe('2026-09-28');
    expect(weekStart('2026-09-28')).toBe('2026-09-28');
  });
});

describe('attendance register status (scenario 26)', () => {
  const at = new Date('2026-10-01T04:00:00Z');
  it('never invents a time: missing records say so', () => {
    expect(registerStatus('working', null, null, true)).toBe('absent');
    expect(registerStatus('working', null, null, false)).toBe('upcoming');
    expect(registerStatus('off', null, null, true)).toBe('rest_day');
    expect(registerStatus('not_rostered', null, null, true)).toBe('no_record');
    expect(registerStatus('working', at, null, true)).toBe('on_duty');
    expect(registerStatus('working', at, at, true)).toBe('complete');
    expect(registerStatus('off', at, at, true)).toBe('unscheduled');
  });
});
