import { earnsEarlyBonus, overtimeMinutes, reliefCheck, LeavingGuard, Reliever } from './index';

// Day shift 06:00 to 18:00 SAST on 3 Oct 2026; 18:00 SAST is 16:00 UTC.
const end = new Date('2026-10-03T16:00:00Z');
const t = (hhmm: string) => new Date(`2026-10-03T${hhmm}:00+02:00`);
const sipho: LeavingGuard = { attendanceId: 'sipho', name: 'Sipho', dutyOnAt: t('05:40'), dutyFromAt: null, turnGivenAt: null, reliefStatus: null };
const thabo: LeavingGuard = { attendanceId: 'thabo', name: 'Thabo', dutyOnAt: t('05:50'), dutyFromAt: null, turnGivenAt: null, reliefStatus: null };
const night = (name: string, hhmm: string, late = 0): Reliever => ({ attendanceId: name, name, dutyOnAt: t(hhmm), lateMinutes: late });

describe('relief at shift change (D-33)', () => {
  it('blocks Duty From until the relief arrives, and says when it unlocks', () => {
    const c = reliefCheck(t('18:05'), 'sipho', end, [sipho, thabo], []);
    expect(c).toMatchObject({ canLeave: false, outcome: 'wait' });
    expect(c.message).toContain('18:30');
  });

  it('lets the first guard in go first when one relief arrives early, one for one', () => {
    const relievers = [night('Lindiwe', '17:00')];
    expect(reliefCheck(t('17:01'), 'sipho', end, [sipho, thabo], relievers)).toMatchObject({ canLeave: true, outcome: 'relieved' });
    const second = reliefCheck(t('17:01'), 'thabo', end, [sipho, thabo], relievers);
    expect(second).toMatchObject({ canLeave: false, outcome: 'wait' });
    expect(second.message).toContain("Sipho's turn");
  });

  it('a relief used by a guard who already left is not used twice', () => {
    const gone = { ...sipho, dutyFromAt: t('17:05'), reliefStatus: 'relieved' };
    expect(reliefCheck(t('17:10'), 'thabo', end, [gone, thabo], [night('Lindiwe', '17:00')]).canLeave).toBe(false);
    const both = reliefCheck(t('17:40'), 'thabo', end, [gone, thabo], [night('Lindiwe', '17:00'), night('Musa', '17:35')]);
    expect(both).toMatchObject({ canLeave: true, outcome: 'relieved' });
    expect(both.reliever?.name).toBe('Musa');
  });

  it('a guard who gives his turn goes behind his partner', () => {
    const gave = { ...sipho, turnGivenAt: t('17:02') };
    const relievers = [night('Lindiwe', '17:00')];
    expect(reliefCheck(t('17:03'), 'thabo', end, [gave, thabo], relievers).canLeave).toBe(true);
    expect(reliefCheck(t('17:03'), 'sipho', end, [gave, thabo], relievers).canLeave).toBe(false);
  });

  it('only the next guard may give his turn, and only to someone behind him', () => {
    const relievers = [night('Lindiwe', '17:00')];
    expect(reliefCheck(t('17:01'), 'sipho', end, [sipho, thabo], relievers).canGiveTurn).toBe(true);
    expect(reliefCheck(t('17:01'), 'sipho', end, [sipho], relievers).canGiveTurn).toBe(false);
  });

  it('unlocks 30 minutes after the shift if nobody arrives, flagging the post', () => {
    expect(reliefCheck(t('18:29'), 'sipho', end, [sipho], []).canLeave).toBe(false);
    expect(reliefCheck(t('18:30'), 'sipho', end, [sipho], [])).toMatchObject({ canLeave: true, outcome: 'no_relief' });
  });

  it('applies no rule when the guard has no scheduled shift end', () => {
    expect(reliefCheck(t('12:00'), 'sipho', null, [sipho], [])).toMatchObject({ canLeave: true, outcome: 'no_rule' });
  });
});

describe('early-arrival point and overtime minutes', () => {
  const start = t('18:00');
  it('earns the point only for more than 15 minutes early', () => {
    expect(earnsEarlyBonus(start, t('17:44'))).toBe(true);
    expect(earnsEarlyBonus(start, t('17:45'))).toBe(false);
    expect(earnsEarlyBonus(start, t('17:55'))).toBe(false);
    expect(earnsEarlyBonus(null, t('17:00'))).toBe(false);
  });

  it('counts minutes before the start and after the end, never inventing a missing time', () => {
    expect(overtimeMinutes(t('06:00'), t('18:00'), t('05:40'), t('18:25'))).toEqual({ before: 20, after: 25, total: 45 });
    expect(overtimeMinutes(t('06:00'), t('18:00'), t('06:10'), t('17:00'))).toEqual({ before: 0, after: 0, total: 0 });
    expect(overtimeMinutes(t('06:00'), t('18:00'), t('05:40'), null)).toEqual({ before: 20, after: 0, total: 20 });
  });
});
