import { arrivalStatus, declarationWordingFor, departureStatus, matchShift, reconcileTime, sastDate, sastInstant, DECLARATIONS } from './index';

const day = { id: 'day', startTime: '06:00', endTime: '18:00' };
const night = { id: 'night', startTime: '18:00', endTime: '06:00' };
const at = (s: string) => new Date(s);

describe('SAST helpers', () => {
  it('uses a fixed +02:00 offset', () => {
    expect(sastInstant('2026-09-28', '06:00').toISOString()).toBe('2026-09-28T04:00:00.000Z');
    expect(sastDate(at('2026-09-27T22:30:00Z'))).toBe('2026-09-28');
  });
});

describe('matching a Duty On to a shift', () => {
  it('matches 05:57 to the 06:00 day shift (scenario 1)', () => {
    const m = matchShift([day, night], at('2026-09-28T05:57:00+02:00'))!;
    expect(m.shiftId).toBe('day');
    expect(m.shiftDate).toBe('2026-09-28');
    expect(m.scheduledStart.toISOString()).toBe('2026-09-28T04:00:00.000Z');
    expect(m.scheduledEnd.toISOString()).toBe('2026-09-28T16:00:00.000Z');
  });
  it('matches 17:40 to the night shift starting that evening', () => {
    expect(matchShift([day, night], at('2026-09-28T17:40:00+02:00'))).toMatchObject({ shiftId: 'night', shiftDate: '2026-09-28' });
  });
  it('matches 02:00 to the night shift that started the previous evening', () => {
    const m = matchShift([day, night], at('2026-09-29T02:00:00+02:00'))!;
    expect(m).toMatchObject({ shiftId: 'night', shiftDate: '2026-09-28' });
    expect(m.scheduledEnd.toISOString()).toBe('2026-09-29T04:00:00.000Z');
  });
  it('returns null when no shift window fits', () => {
    expect(matchShift([{ id: 'x', startTime: '08:00', endTime: '12:00' }], at('2026-09-28T14:00:00+02:00'))).toBeNull();
  });
});

describe('arrival and departure status', () => {
  const start = sastInstant('2026-09-28', '06:00');
  const end = sastInstant('2026-09-28', '18:00');
  it('is ON TIME up to 5 minutes after the start', () => {
    expect(arrivalStatus(start, at('2026-09-28T05:57:00+02:00'))).toEqual({ status: 'ON_TIME', lateMinutes: 0 });
    expect(arrivalStatus(start, at('2026-09-28T06:05:59+02:00'))).toEqual({ status: 'ON_TIME', lateMinutes: 0 });
  });
  it('is LATE with minutes after the grace period (scenario 1: 06:17)', () => {
    expect(arrivalStatus(start, at('2026-09-28T06:17:00+02:00'))).toEqual({ status: 'LATE', lateMinutes: 17 });
    expect(arrivalStatus(start, at('2026-09-28T06:06:00+02:00'))).toEqual({ status: 'LATE', lateMinutes: 6 });
  });
  it('respects a company grace period', () => {
    expect(arrivalStatus(start, at('2026-09-28T06:10:00+02:00'), 10).status).toBe('ON_TIME');
  });
  it('flags early departure', () => {
    expect(departureStatus(end, at('2026-09-28T17:30:00+02:00'))).toEqual({ status: 'EARLY_DEPARTURE', earlyMinutes: 30 });
    expect(departureStatus(end, at('2026-09-28T18:02:00+02:00'))).toEqual({ status: 'ON_TIME', earlyMinutes: 0 });
  });
  it('is UNSCHEDULED without a shift', () => {
    expect(arrivalStatus(null, start).status).toBe('UNSCHEDULED');
  });
});

describe('trusted time (section 8, scenario 13)', () => {
  const now = at('2026-09-28T12:00:00Z');
  it('uses server time for a prompt event', () => {
    const r = reconcileTime(at('2026-09-28T11:59:30Z'), at('2026-09-28T11:59:30Z'), now);
    expect(r).toEqual({ ok: true, officialAt: now, lateSynced: false, driftSeconds: 0, driftFlagged: false });
  });
  it('uses the device trusted time and flags late-synced events', () => {
    const r = reconcileTime(at('2026-09-28T06:00:00Z'), at('2026-09-28T06:00:10Z'), now);
    expect(r).toMatchObject({ ok: true, officialAt: at('2026-09-28T06:00:00Z'), lateSynced: true, driftFlagged: false });
  });
  it('flags a phone clock more than 2 minutes out', () => {
    const r = reconcileTime(at('2026-09-28T11:59:00Z'), at('2026-09-28T12:04:00Z'), now);
    expect(r).toMatchObject({ ok: true, driftSeconds: 300, driftFlagged: true });
  });
  it('refuses events over 72 hours old or in the future', () => {
    expect(reconcileTime(at('2026-09-25T11:00:00Z'), at('2026-09-25T11:00:00Z'), now).ok).toBe(false);
    expect(reconcileTime(at('2026-09-28T12:10:00Z'), at('2026-09-28T12:10:00Z'), now).ok).toBe(false);
  });
});

describe('declaration wording', () => {
  it('has four Duty On statements (the fourth is the relief statement, D-33) and one Duty From statement', () => {
    expect(DECLARATIONS.duty_on.statements).toHaveLength(4);
    expect(DECLARATIONS.duty_on.version).toBe(2);
    expect(DECLARATIONS.duty_on.statements[3]).toContain('until my relief has arrived');
    expect(DECLARATIONS.duty_from.statements).toHaveLength(1);
  });

  it('still accepts the three-statement wording from phones not yet updated, as version 1', () => {
    expect(declarationWordingFor('duty_on', 4)?.version).toBe(2);
    expect(declarationWordingFor('duty_on', 3)?.version).toBe(1);
    expect(declarationWordingFor('duty_on', 2)).toBeNull();
    expect(declarationWordingFor('duty_from', 1)?.version).toBe(1);
  });
});
