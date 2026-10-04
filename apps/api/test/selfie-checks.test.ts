import { randomUUID } from 'node:crypto';
import { sastDate } from '@onpar/rules';
import { enrol, enrolmentData, ownerQuery, PNG, setupWorld, World } from './helpers';

/**
 * Selfie checks (D-36, face recognition stage 1): people compare Duty On selfies with the
 * enrolment photo. "Not him" is a flag only; nothing happens to the guard automatically.
 */
describe('selfie checks', () => {
  let w: World;
  let admin: string;
  let supervisor: string;
  let deviceToken: string;
  let guardToken: string;
  let pin: string;
  let employeeId: string;
  let declarationId: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const guard = () => ({ 'X-Device-Token': deviceToken, Authorization: `Bearer ${guardToken}` });
  const list = (t: string, view: string) => w.http().get(`/api/selfie-checks?view=${view}`).set(auth(t));

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    supervisor = await w.login('supervisor@a.test');
    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    pin = o.body.initialPin;
    employeeId = o.body.officer.id;
    deviceToken = (
      await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Gate', serialOrImei: '356938035643809', siteId: w.a.siteId })
    ).body.deviceToken;
    guardToken = (await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ login: o.body.officer.employeeNumber, pin })).body.token;
    const at = `${sastDate(new Date(Date.now() - 24 * 3600 * 1000))}T05:57:00+02:00`;
    const on = await w.http().post('/api/device/duty').set(guard()).send({ eventId: randomUUID(), kind: 'duty_on', pin, trustedAt: at, deviceClock: at });
    expect(on.status).toBe(200);
    declarationId = randomUUID();
    const pending = (await w.http().get('/api/device/me').set(guard())).body.pendingDeclaration;
    const data = { eventId: declarationId, dutyEventId: pending.dutyEventId, accepted: [true, true, true, true], trustedAt: at, deviceClock: at };
    const d = await w.http().post('/api/device/declarations').set(guard()).field('data', JSON.stringify(data)).attach('selfie', PNG, { filename: 's.png', contentType: 'image/png' });
    expect(d.status).toBe(200);
  });
  afterAll(() => w.app.close());

  it('lists the new selfie to check', async () => {
    const r = await list(supervisor, 'todo');
    expect(r.status).toBe(200);
    expect(r.body.rows).toEqual([expect.objectContaining({ declarationId, employeeId, kind: 'duty_on', hasFacePhoto: true, result: null })]);
    expect(r.body.counts).toMatchObject({ todo: 1, flagged: 0 });
    // The weekly spot check picks from the same unchecked selfies.
    expect((await list(supervisor, 'spot')).body.rows).toHaveLength(1);
  });

  it('records "not him" as a flag, with nothing done to the guard', async () => {
    const r = await w.http().post('/api/selfie-checks').set(auth(supervisor)).send({ declarationId, result: 'not_match', note: 'Different person', source: 'spot_check' });
    expect(r.status).toBe(201);
    expect((await list(supervisor, 'todo')).body.rows).toHaveLength(0);
    const flagged = (await list(admin, 'flagged')).body;
    expect(flagged.rows[0]).toMatchObject({ declarationId, result: 'not_match', note: 'Different person' });
    expect(flagged.counts.flagged).toBe(1);
    // No score change and no account change for the guard.
    expect(await ownerQuery("SELECT 1 FROM performance_events WHERE employee_id = $1 AND source_type = 'selfie_check'", [employeeId])).toHaveLength(0);
    const [e] = await ownerQuery('SELECT status, pin_locked_at FROM employees WHERE id = $1', [employeeId]);
    expect(e).toMatchObject({ status: 'active', pin_locked_at: null });
    const audit = await ownerQuery("SELECT 1 FROM audit_log WHERE action = 'attendance.selfie_check' AND entity_id = $1", [employeeId]);
    expect(audit).toHaveLength(1);
  });

  it('a second look adds a new check and the latest counts; checks are never changed', async () => {
    await w.http().post('/api/selfie-checks').set(auth(admin)).send({ declarationId, result: 'match', note: 'Checked with the site: it was him, new haircut' });
    expect((await list(admin, 'flagged')).body.rows).toHaveLength(0);
    expect((await list(admin, 'done')).body.rows[0]).toMatchObject({ result: 'match' });
    await expect(ownerQuery("UPDATE selfie_checks SET result = 'match'")).rejects.toThrow(/immutable/);
    await expect(ownerQuery('DELETE FROM selfie_checks')).rejects.toThrow(/immutable/);
  });

  it('shows the latest check on the attendance record', async () => {
    const [{ attendance_id }] = await ownerQuery('SELECT attendance_id FROM declarations WHERE id = $1', [declarationId]);
    const r = await w.http().get(`/api/attendance/${attendance_id}`).set(auth(admin));
    expect(r.body.declarations[0].selfie_check).toMatchObject({ result: 'match' });
  });

  it('another company sees nothing and cannot check', async () => {
    const b = await w.login('admin@b.test');
    expect((await list(b, 'done')).body.rows).toHaveLength(0);
    expect((await w.http().post('/api/selfie-checks').set(auth(b)).send({ declarationId, result: 'match' })).status).toBe(404);
  });
});
