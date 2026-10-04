import { canStartPatrol, checkScan, distanceMetres, learnPointLocation, patrolShare, patrolWindows, pointMissing, readingOutOfLimit, ruleFitWarning, Check } from './index';

const start = new Date('2026-09-28T06:00:00+02:00');
const end = new Date('2026-09-28T18:00:00+02:00');
const at = (hhmm: string) => new Date(`2026-09-28T${hhmm}:00+02:00`);
const rule = { perShift: 4, minGapMinutes: 60, maxDurationMinutes: 45 };

describe('windows', () => {
  it('splits a 12-hour shift into four 3-hour windows', () => {
    const w = patrolWindows(start, end, 4);
    expect(w.map((x) => x.start.toISOString())).toEqual([at('06:00'), at('09:00'), at('12:00'), at('15:00')].map((d) => d.toISOString()));
    expect(w[3].end.toISOString()).toBe(end.toISOString());
  });
  it('warns when the gap plus duration does not fit a window', () => {
    expect(ruleFitWarning(720, rule)).toBeNull();
    expect(ruleFitWarning(720, { perShift: 12, minGapMinutes: 30, maxDurationMinutes: 45 })).toMatch(/60 minutes.*75 minutes/);
  });
});

describe('starting a patrol (scenario 2)', () => {
  const w = patrolWindows(start, end, 4);
  it('starts in an open window', () => {
    expect(canStartPatrol(at('06:30'), w, rule, { usedWindows: [], lastFinishedAt: null, activePatrol: false })).toMatchObject({ ok: true, window: { index: 0 } });
  });
  it('blocks a second patrol in the same window and says when the next opens', () => {
    const r = canStartPatrol(at('07:10'), w, rule, { usedWindows: [0], lastFinishedAt: at('07:00'), activePatrol: false });
    expect(r).toMatchObject({ ok: false });
    expect((r as { opensAt: Date }).opensAt.toISOString()).toBe(at('09:00').toISOString());
  });
  it('blocks the next patrol until the minimum gap has passed', () => {
    const r = canStartPatrol(at('09:05'), w, rule, { usedWindows: [0], lastFinishedAt: at('08:30'), activePatrol: false });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/minimum gap of 60 minutes/) });
    expect((r as { opensAt: Date }).opensAt.toISOString()).toBe(at('09:30').toISOString());
    expect(canStartPatrol(at('09:31'), w, rule, { usedWindows: [0], lastFinishedAt: at('08:30'), activePatrol: false }).ok).toBe(true);
  });
  it('allows only one active patrol at a time', () => {
    expect(canStartPatrol(at('06:30'), w, rule, { usedWindows: [], lastFinishedAt: null, activePatrol: true })).toMatchObject({ ok: false });
  });
});

describe('scans (scenario 4)', () => {
  const point = { lat: -26.1076, lng: 28.0567, radiusM: 30 };
  it('accepts a scan at the point with a good fix', () => {
    expect(checkScan({ lat: -26.10762, lng: 28.05671, accuracyM: 8 }, point, null)).toMatchObject({ result: 'accepted' });
  });
  it('rejects a scan 480 m away', () => {
    const far = { lat: -26.1076 + 480 / 111_320, lng: 28.0567 };
    const r = checkScan({ ...far, accuracyM: 5 }, point, null);
    expect(r.result).toBe('rejected_distance');
    expect(r.distanceM).toBeGreaterThan(470);
    expect(r.distanceM).toBeLessThan(490);
  });
  it('rejects poor GPS accuracy', () => {
    expect(checkScan({ lat: -26.1076, lng: 28.0567, accuracyM: 40 }, point, null).result).toBe('rejected_accuracy');
  });
  it('ignores a repeat scan within 2 minutes', () => {
    expect(checkScan({ lat: -26.1076, lng: 28.0567, accuracyM: 5 }, point, 90).result).toBe('ignored_duplicate');
    expect(checkScan({ lat: -26.1076, lng: 28.0567, accuracyM: 5 }, point, 130).result).toBe('accepted');
  });
  it('measures distance sensibly', () => {
    expect(Math.round(distanceMetres(0, 0, 0, 1) / 1000)).toBe(111);
  });
});

describe('point checks (scenario 7)', () => {
  const fuel: Check = { id: 'fuel', kind: 'number', label: 'generator fuel', unit: 'litres', below: 50 };
  const door: Check = { id: 'door', kind: 'ok_problem', label: 'the fire door' };
  it('flags fuel of 30 litres against a limit of 50', () => {
    expect(readingOutOfLimit(fuel, { checkId: 'fuel', value: 30 })).toBe(true);
    expect(readingOutOfLimit(fuel, { checkId: 'fuel', value: 70 })).toBe(false);
    expect(readingOutOfLimit(door, { checkId: 'door', ok: false })).toBe(true);
  });
  it('blocks saving until a required photo is taken', () => {
    const p = { photoMode: 'required' as const, noteMode: 'off' as const, checks: [fuel] };
    expect(pointMissing(p, { photo: false, note: '', readings: [{ checkId: 'fuel', value: 30 }] })).toEqual(['A photo is required.']);
    expect(pointMissing(p, { photo: true, note: '', readings: [{ checkId: 'fuel', value: 30 }] })).toEqual([]);
  });
});

describe('patrol points (scenario 6)', () => {
  it('shares 6 points over 13 patrols, summing to exactly 6.00', () => {
    const shares = Array.from({ length: 13 }, (_, i) => patrolShare(6, 13, i + 1));
    shares.forEach((s) => expect(Math.abs(s - 6 / 13)).toBeLessThan(0.01));
    expect(Math.round(shares.reduce((a, b) => a + b, 0) * 100) / 100).toBe(6);
  });
  it('gives nothing beyond the required number', () => {
    expect(patrolShare(6, 13, 14)).toBe(0);
    expect(patrolShare(10, 4, 1)).toBe(2.5);
  });
});

describe('learning a point location from its first scans (owner, 4 Oct 2026)', () => {
  // About 11 m per 0.0001 degrees of latitude.
  const at = (dLat: number, accuracyM = 8) => ({ lat: -26.1 + dLat, lng: 28.05, accuracyM });

  it('accepts scans of a point with no location, still requiring an accurate GPS reading', () => {
    expect(checkScan(at(0), { lat: null, lng: null, radiusM: 30 }, null)).toEqual({ result: 'accepted', distanceM: null });
    expect(checkScan(at(0, 40), { lat: null, lng: null, radiusM: 30 }, null).result).toBe('rejected_accuracy');
  });

  it('needs 10 good readings that agree within 30 m, then uses their average', () => {
    const nine = Array.from({ length: 9 }, (_, i) => at(i * 0.00002));
    expect(learnPointLocation(nine)).toEqual({ location: null, agreeing: 9 });
    const ten = [...nine, at(0.0001)];
    const r = learnPointLocation(ten);
    expect(r.agreeing).toBe(10);
    expect(r.location!.lat).toBeCloseTo(-26.1 + 0.0000856, 5);
  });

  it('ignores inaccurate readings and readings far from the rest', () => {
    const readings = [...Array.from({ length: 9 }, () => at(0)), at(0, 60), at(0.01), at(0.0004)];
    expect(learnPointLocation(readings)).toEqual({ location: null, agreeing: 9 });
  });
});
