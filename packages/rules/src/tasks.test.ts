import { occurrenceDates, occurrenceDeadline, occurrenceStatus, taskErrors } from './index';

describe('occurrence dates', () => {
  it('once', () => {
    expect(occurrenceDates({ recurrence: 'once', startDate: '2026-10-05' }, '2026-10-01', '2026-10-31')).toEqual(['2026-10-05']);
    expect(occurrenceDates({ recurrence: 'once', startDate: '2026-10-05' }, '2026-10-06', '2026-10-31')).toEqual([]);
  });
  it('daily, clipped to the window and end date', () => {
    expect(occurrenceDates({ recurrence: 'daily', startDate: '2026-09-28', endDate: '2026-10-01' }, '2026-09-01', '2026-12-31')).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
    ]);
  });
  it('weekly on the start weekday', () => {
    // 2026-09-28 is a Monday
    expect(occurrenceDates({ recurrence: 'weekly', startDate: '2026-09-28' }, '2026-10-01', '2026-10-20')).toEqual([
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
    ]);
  });
  it('monthly on the same day: fire extinguishers on the 19th', () => {
    expect(occurrenceDates({ recurrence: 'monthly', startDate: '2026-07-19' }, '2026-07-01', '2026-10-31')).toEqual([
      '2026-07-19',
      '2026-08-19',
      '2026-09-19',
      '2026-10-19',
    ]);
  });
  it('monthly on the 31st falls on the last day of shorter months', () => {
    expect(occurrenceDates({ recurrence: 'monthly', startDate: '2026-01-31' }, '2026-01-01', '2026-04-30')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
  });
  it('crosses the year end', () => {
    expect(occurrenceDates({ recurrence: 'monthly', startDate: '2026-11-15' }, '2026-11-01', '2027-01-31')).toEqual([
      '2026-11-15',
      '2026-12-15',
      '2027-01-15',
    ]);
  });
});

describe('deadlines and status', () => {
  it('untimed tasks are open all day and missed after midnight SAST', () => {
    const d = occurrenceDeadline('2026-09-28', null);
    expect(d.dueAt).toBeNull();
    expect(d.closesAt.toISOString()).toBe('2026-09-28T22:00:00.000Z');
    expect(occurrenceStatus('open', '2026-09-28', null, new Date('2026-09-28T23:30:00+02:00'))).toBe('open');
    expect(occurrenceStatus('open', '2026-09-28', null, new Date('2026-09-29T00:00:00+02:00'))).toBe('missed');
  });
  it('timed tasks become overdue after the due time, then missed', () => {
    expect(occurrenceStatus('open', '2026-09-28', '14:00', new Date('2026-09-28T13:59:00+02:00'))).toBe('open');
    expect(occurrenceStatus('open', '2026-09-28', '14:00', new Date('2026-09-28T14:01:00+02:00'))).toBe('overdue');
    expect(occurrenceStatus('open', '2026-09-28', '14:00', new Date('2026-09-29T00:01:00+02:00'))).toBe('missed');
  });
  it('future occurrences are upcoming and finished ones keep their state', () => {
    expect(occurrenceStatus('open', '2026-09-30', null, new Date('2026-09-28T12:00:00+02:00'))).toBe('upcoming');
    expect(occurrenceStatus('completed', '2026-09-28', '14:00', new Date('2026-09-29T12:00:00+02:00'))).toBe('completed');
  });
});

describe('task validation', () => {
  const ok = { title: 'Generator check', siteId: 's', assigneeType: 'post', assigneeDeviceId: 'd', recurrence: 'daily', startDate: '2026-09-28' };
  it('accepts an untimed task, the default', () => {
    expect(taskErrors({ ...ok, timeRequired: false })).toEqual({});
  });
  it('needs a time only when a specific time is required', () => {
    expect(taskErrors({ ...ok, timeRequired: true }).dueTime).toBeDefined();
    expect(taskErrors({ ...ok, timeRequired: true, dueTime: '14:00' })).toEqual({});
  });
  it('needs an assignee', () => {
    expect(taskErrors({ ...ok, assigneeType: 'employee', assigneeEmployeeId: null }).assigneeEmployeeId).toBeDefined();
  });
});
