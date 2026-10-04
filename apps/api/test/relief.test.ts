import { randomUUID } from 'node:crypto';
import { sastTime } from '@onpar/rules';
import { enrol, enrolmentData, ownerQuery, setupWorld, World } from './helpers';

/** A valid SA ID number for a sequence number, so each officer is unique. */
function idNumber(n: number): string {
  const { validateSaId } = require('@onpar/rules');
  const base = `880202${String(6000 + n).padStart(4, '0')}08`;
  for (let d = 0; d <= 9; d++) if (validateSaId(base + d).valid) return base + d;
  throw new Error('no check digit');
}

/**
 * Relief at shift change (owner's decision D-33): Duty From only once the relief has
 * arrived, first in first out, giving a turn, supervisor release, the early-arrival and
 * covering points. The site's shifts are set around the current time, so every Duty On
 * and Duty From happens "now", as on a real phone.
 */
describe('relief at shift change (D-33)', () => {
  let w: World;
  let admin: string;
  let manager: string;
  let deviceToken: string;
  let siteId: string;
  const g: { id: string; number: string; pin: string; token: string }[] = [];
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const dev = (i: number) => ({ 'X-Device-Token': deviceToken, ...auth(g[i].token) });
  const duty = (i: number, kind: 'duty_on' | 'duty_from') => {
    const now = new Date().toISOString();
    return w.http().post('/api/device/duty').set(dev(i)).send({ eventId: randomUUID(), kind, pin: g[i].pin, trustedAt: now, deviceClock: now });
  };
  const me = async (i: number) => (await w.http().get('/api/device/me').set(dev(i))).body;
  const events = (employeeId: string, type: string) =>
    ownerQuery('SELECT impact, evidence FROM performance_events WHERE employee_id = $1 AND event_type = $2', [employeeId, type]);

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    manager = await w.login('manager@a.test');
    // The day guards come on duty during the day shift (it ends in 5 hours); then the shift change
    // is moved to 20 minutes from now, as if they had been on duty all day.
    const later = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 5 * 3600_000);
    const end = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 20 * 60_000);
    const dayStart = sastTime(new Date(end.getTime() - 12 * 3600_000));
    const change = sastTime(end);
    siteId = (
      await w.http().post('/api/sites').set(auth(manager)).send({
        name: 'Relief Estate',
        address: 'Sandton',
        client: 'Relief HOA',
        province: 'GP', minimumGrade: 'E',
        armed: false,
        shifts: [
          { name: 'Day', kind: 'day', startTime: sastTime(new Date(later.getTime() - 12 * 3600_000)), endTime: sastTime(later), guardsRequired: 2 },
          { name: 'Night', kind: 'night', startTime: sastTime(later), endTime: sastTime(new Date(later.getTime() - 12 * 3600_000)), guardsRequired: 2 },
        ],
      })
    ).body.id;
    deviceToken = (await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Relief phone', serialOrImei: '356938035643817', siteId })).body.deviceToken;
    for (let i = 0; i < 4; i++) {
      const o = await enrol(w, admin, enrolmentData(siteId, { idNumber: idNumber(i), fullName: ['Sipho', 'Thabo', 'Lindiwe', 'Musa'][i] }));
      if (o.status !== 201) throw new Error(JSON.stringify(o.body));
      const token = (
        await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: o.body.officer.employeeNumber, pin: o.body.initialPin })
      ).body.token;
      g.push({ id: o.body.officer.id, number: o.body.officer.employeeNumber, pin: o.body.initialPin, token });
    }
    // The day guards come on duty: Sipho first, then Thabo.
    expect((await duty(0, 'duty_on')).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await duty(1, 'duty_on')).status).toBe(200);
    await ownerQuery(`UPDATE site_shifts SET start_time = CASE kind WHEN 'day' THEN $2::time ELSE $3::time END,
                                             end_time = CASE kind WHEN 'day' THEN $3::time ELSE $2::time END WHERE site_id = $1`, [siteId, dayStart, change]);
    await ownerQuery('UPDATE attendance SET scheduled_end = $2, scheduled_start = $3 WHERE site_id = $1', [siteId, end, new Date(end.getTime() - 12 * 3600_000)]);
  });
  afterAll(() => w.app.close());

  it('refuses Duty From before the relief arrives, and the phone is told why and until when', async () => {
    const r = await duty(0, 'duty_from');
    expect(r.status).toBe(409);
    expect(r.body.message).toContain('Your relief has not arrived yet');
    const state = await me(0);
    expect(state.attendance.relief).toMatchObject({ canLeave: false, outcome: 'wait' });
    expect(state.attendance.relief.unlocksAt).toBeTruthy();
  });

  it('gives the early-arrival point for Duty On more than 15 minutes before the shift', async () => {
    // Lindiwe arrives 20 minutes before the night shift.
    expect((await duty(2, 'duty_on')).status).toBe(200);
    const [bonus] = await events(g[2].id, 'early_arrival');
    expect(Number(bonus.impact)).toBe(1);
    expect(bonus.evidence).toMatch(/minutes before/);
  });

  it('lets the first guard in go first; his partner waits for the next relief', async () => {
    expect((await me(0)).attendance.relief).toMatchObject({ canLeave: true, outcome: 'relieved', reliever: 'Lindiwe', canGiveTurn: true });
    const thabo = await duty(1, 'duty_from');
    expect(thabo.status).toBe(409);
    expect(thabo.body.message).toContain("Sipho's turn");
  });

  it('the guard whose turn it is can give it to his partner, with his PIN, and it is recorded', async () => {
    const wrong = await w.http().post('/api/device/relief/give-turn').set(dev(0)).send({ pin: '000000' === g[0].pin ? '111111' : '000000' });
    expect(wrong.status).toBe(401);
    const r = await w.http().post('/api/device/relief/give-turn').set(dev(0)).send({ pin: g[0].pin });
    expect(r.status).toBe(200);
    expect((await duty(1, 'duty_from')).status).toBe(200);
    const [a] = await ownerQuery("SELECT relief_status, departure_status FROM attendance WHERE employee_id = $1", [g[1].id]);
    expect(a).toMatchObject({ relief_status: 'relieved', departure_status: 'EARLY_DEPARTURE' });
    const [audit] = await ownerQuery("SELECT after FROM audit_log WHERE action = 'attendance.relief_turn_given'");
    expect(audit.after.relief).toBe('Lindiwe');
    // The relief is used: Sipho must wait for the next one.
    expect((await duty(0, 'duty_from')).status).toBe(409);
  });

  it('a supervisor can release a guard at any time, with a reason', async () => {
    const r = await w.http().post('/api/attendance/on-behalf').set(auth(manager)).send({ employeeId: g[0].id, kind: 'duty_from', reason: 'Family emergency' });
    expect(r.status).toBe(201);
    const [a] = await ownerQuery('SELECT relief_status FROM attendance WHERE employee_id = $1', [g[0].id]);
    expect(a.relief_status).toBe('released');
  });

  it('a guard who stays for a late relief gets the covering point and the points the late guard lost', async () => {
    // Sipho comes back on duty; move his shift and Lindiwe's so that the shift ended 10 minutes ago
    // and she arrived 10 minutes late.
    expect((await duty(0, 'duty_on')).status).toBe(200);
    await ownerQuery(
      `UPDATE attendance SET scheduled_end = now() - interval '10 minutes', scheduled_start = now() - interval '12 hours 10 minutes'
        WHERE employee_id = $1 AND duty_from_at IS NULL`,
      [g[0].id],
    );
    await ownerQuery(
      `UPDATE attendance SET scheduled_start = now() - interval '10 minutes', late_minutes = 10, arrival_status = 'LATE' WHERE employee_id = $1`,
      [g[2].id],
    );
    expect((await duty(0, 'duty_from')).status).toBe(200);
    const [cover] = await events(g[0].id, 'covering');
    expect(Number(cover.impact)).toBe(1);
    expect(cover.evidence).toContain('Lindiwe');
    const [moved] = await events(g[0].id, 'covered_points');
    expect(Number(moved.impact)).toBe(1); // "Late arrival" is −1 by default
  });

  it('unlocks 30 minutes after the shift when no relief comes, marking the post uncovered', async () => {
    expect((await duty(3, 'duty_on')).status).toBe(200);
    // Lindiwe's night shift is not Musa's relief here.
    await ownerQuery(`UPDATE attendance SET scheduled_start = now() - interval '40 minutes' WHERE employee_id = $1`, [g[2].id]);
    await ownerQuery(
      `UPDATE attendance SET scheduled_end = now() - interval '31 minutes', scheduled_start = now() - interval '12 hours 31 minutes'
        WHERE employee_id = $1 AND duty_from_at IS NULL`,
      [g[3].id],
    );
    expect((await duty(3, 'duty_from')).status).toBe(200);
    const [a] = await ownerQuery('SELECT relief_status FROM attendance WHERE employee_id = $1', [g[3].id]);
    expect(a.relief_status).toBe('no_relief');
    expect((await events(g[3].id, 'covering')).length).toBe(1);
  });

  it('shows overtime minutes in the attendance register', async () => {
    const r = await w.http().get(`/api/register?siteId=${siteId}&date=${new Date().toISOString().slice(0, 10)}`).set(auth(manager));
    expect(r.status).toBe(200);
    const musa = r.body.guards.find((x: { id: string }) => x.id === g[3].id);
    const day = musa.days.find((d: { dutyFromAt: string | null }) => d.dutyFromAt);
    expect(day.overtime.after).toBeGreaterThanOrEqual(31);
    expect(day.reliefStatus).toBe('no_relief');
    expect(musa.summary.overtimeMinutes).toBeGreaterThanOrEqual(31);
  });
});
