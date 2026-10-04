import { randomUUID } from 'node:crypto';
import { sastDate } from '@onpar/rules';
import { enrol, enrolmentData, ownerQuery, PNG, setupWorld, World } from './helpers';

/**
 * Milestone 2: Duty On, Duty From, declarations and attendance.
 * Acceptance scenarios 1 (attendance part), 10 (declarations) and 13 (offline).
 *
 * Shift times are tested with events that happened 1–2 days ago and synced
 * late, so the official time is the device's trusted time and the results do
 * not depend on when the tests run.
 */
describe('Duty On, Duty From and attendance', () => {
  let w: World;
  let admin: string;
  let supervisor: string;
  let deviceToken: string;
  let guardToken: string;
  let pin: string;
  let employeeId: string;

  const daysAgo = (n: number) => sastDate(new Date(Date.now() - n * 24 * 3600 * 1000));
  const D2 = daysAgo(2);
  const D1 = daysAgo(1);
  const sast = (date: string, hhmm: string) => `${date}T${hhmm}:00+02:00`;

  const guard = () => ({ 'X-Device-Token': deviceToken, Authorization: `Bearer ${guardToken}` });
  const duty = (kind: 'duty_on' | 'duty_from', at: string, extra: Record<string, unknown> = {}) =>
    w
      .http()
      .post('/api/device/duty')
      .set(guard())
      .send({ eventId: randomUUID(), kind, pin, trustedAt: at, deviceClock: at, ...extra });
  const declare = (dutyEventId: string, at: string, extra: Record<string, unknown> = {}, withSelfie = true) => {
    const data = { eventId: randomUUID(), dutyEventId, accepted: [true, true, true, true], trustedAt: at, deviceClock: at, ...extra };
    let req = w.http().post('/api/device/declarations').set(guard()).field('data', JSON.stringify(data));
    if (withSelfie) req = req.attach('selfie', PNG, { filename: 'selfie.png', contentType: 'image/png' });
    return req;
  };

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    supervisor = await w.login('supervisor@a.test');
    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    pin = o.body.initialPin;
    employeeId = o.body.officer.id;
    const d = await w
      .http()
      .post('/api/devices')
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'Device 001', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Gate 2' });
    deviceToken = d.body.deviceToken;
    const l = await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: '0001', pin });
    guardToken = l.body.token;
  });
  afterAll(() => w.app.close());

  it('shows nothing open before the first Duty On', async () => {
    const r = await w.http().get('/api/device/me').set(guard());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ employee: { name: 'John Smith' }, attendance: null, pendingDeclaration: null });
  });

  it('needs the PIN again for Duty On', async () => {
    const wrong = pin === '000000' ? '111111' : '000000';
    const r = await duty('duty_on', sast(D2, '05:57'), { pin: wrong });
    expect(r.status).toBe(401);
  });

  let dutyOnEventId: string;
  let attendanceId: string;

  it('records 05:57 for the 06:00 shift as ON TIME (scenario 1) and asks for the declaration', async () => {
    dutyOnEventId = randomUUID();
    const r = await duty('duty_on', sast(D2, '05:57'), { eventId: dutyOnEventId });
    expect(r.status).toBe(200);
    attendanceId = r.body.attendance.id;
    expect(r.body.attendance).toMatchObject({
      shiftName: 'Day',
      shiftDate: D2,
      arrivalStatus: 'ON_TIME',
      lateMinutes: 0,
      siteName: 'Estate ABC',
      declarations: { duty_on: false, duty_from: false },
    });
    expect(r.body.declaration.statements).toHaveLength(4);

    const me = await w.http().get('/api/device/me').set(guard());
    expect(me.body.pendingDeclaration).toMatchObject({ kind: 'duty_on', dutyEventId: dutyOnEventId });
    expect(me.body.pendingDeclaration.wording.statements[0]).toBe(
      'I am fit and free of injury and ready to commence and complete my shift',
    );
  });

  it('does not duplicate a retried Duty On (scenario 13)', async () => {
    const r = await duty('duty_on', sast(D2, '05:57'), { eventId: dutyOnEventId });
    expect(r.status).toBe(200);
    expect(r.body.attendance.id).toBe(attendanceId);
    const rows = await ownerQuery('SELECT count(*)::int AS n FROM attendance WHERE employee_id = $1', [employeeId]);
    expect(rows[0].n).toBe(1);
  });

  it('flags the event as late-synced, since it arrived days after it happened', async () => {
    const [ev] = await ownerQuery('SELECT late_synced, official_at FROM duty_events WHERE id = $1', [dutyOnEventId]);
    expect(ev.late_synced).toBe(true);
    expect(new Date(ev.official_at).toISOString()).toBe(new Date(sast(D2, '05:57')).toISOString());
  });

  it('will not accept a declaration unless every statement is accepted (scenario 10)', async () => {
    const r = await declare(dutyOnEventId, sast(D2, '05:58'), { accepted: [true, false, true, true] });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Every statement must be accepted.');
  });

  it('will not accept a declaration without a selfie (scenario 10)', async () => {
    const r = await declare(dutyOnEventId, sast(D2, '05:58'), {}, false);
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('A selfie is required.');
  });

  it('records the declaration with the wording shown, a comment and the selfie', async () => {
    const r = await declare(dutyOnEventId, sast(D2, '05:58'), { comment: 'Torch at Gate 2 is broken', raiseEquipmentReport: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: 'duty_on', wordingVersion: 2, selfieReceived: true });
    const me = await w.http().get('/api/device/me').set(guard());
    expect(me.body.pendingDeclaration).toBeNull();
    expect(me.body.attendance.declarations.duty_on).toBe(true);
    const [d] = await ownerQuery('SELECT statements, comment FROM declarations WHERE attendance_id = $1', [attendanceId]);
    expect(d.statements).toHaveLength(4);
    expect(d.statements.every((s: { accepted: boolean }) => s.accepted)).toBe(true);
    expect(d.comment).toBe('Torch at Gate 2 is broken');
  });

  it('makes declarations and duty events impossible to edit or delete (scenario 10)', async () => {
    await expect(ownerQuery(`UPDATE declarations SET comment = 'changed'`)).rejects.toThrow(/immutable/);
    await expect(ownerQuery('DELETE FROM declarations')).rejects.toThrow(/immutable/);
    await expect(ownerQuery(`UPDATE duty_events SET official_at = now()`)).rejects.toThrow(/immutable/);
    await expect(ownerQuery('DELETE FROM duty_events')).rejects.toThrow(/immutable/);
  });

  it('refuses a second Duty On while the shift is open', async () => {
    const r = await duty('duty_on', sast(D2, '09:00'));
    expect(r.status).toBe(409);
  });

  let fromDeclarationId: string;

  it('records an early Duty From, with the photo sent after the text', async () => {
    const r = await duty('duty_from', sast(D2, '17:30'));
    expect(r.status).toBe(200);
    expect(r.body.attendance).toMatchObject({ departureStatus: 'EARLY_DEPARTURE', earlyMinutes: 30 });
    expect(r.body.declaration.statements).toHaveLength(1);

    const me = await w.http().get('/api/device/me').set(guard());
    expect(me.body.attendance).toBeNull();
    expect(me.body.pendingDeclaration.kind).toBe('duty_from');

    fromDeclarationId = randomUUID();
    const d = await declare(me.body.pendingDeclaration.dutyEventId, sast(D2, '17:31'), {
      eventId: fromDeclarationId,
      accepted: [true],
      selfieToFollow: true,
    }, false);
    expect(d.status).toBe(200);
    expect(d.body.selfieReceived).toBe(false);

    const photo = await w
      .http()
      .post(`/api/device/declarations/${fromDeclarationId}/selfie`)
      .set(guard())
      .attach('selfie', PNG, { filename: 's.png', contentType: 'image/png' });
    expect(photo.status).toBe(200);
    expect(photo.body.selfieReceived).toBe(true);
  });

  it('ignores a second copy of the same selfie', async () => {
    const [before] = await ownerQuery('SELECT selfie_key FROM declarations WHERE id = $1', [fromDeclarationId]);
    const again = await w
      .http()
      .post(`/api/device/declarations/${fromDeclarationId}/selfie`)
      .set(guard())
      .attach('selfie', PNG, { filename: 's.png', contentType: 'image/png' });
    expect(again.status).toBe(200);
    const [after] = await ownerQuery('SELECT selfie_key FROM declarations WHERE id = $1', [fromDeclarationId]);
    expect(after.selfie_key).toBe(before.selfie_key);
  });

  it('records 06:17 the next day as LATE by 17 minutes (scenario 1)', async () => {
    const r = await duty('duty_on', sast(D1, '06:17'));
    expect(r.status).toBe(200);
    expect(r.body.attendance).toMatchObject({ shiftDate: D1, arrivalStatus: 'LATE', lateMinutes: 17 });
  });

  it('flags a phone clock that is more than 2 minutes out (scenario 13)', async () => {
    const me = await w.http().get('/api/device/me').set(guard());
    const r = await declare(me.body.pendingDeclaration.dutyEventId, sast(D1, '06:18'), {
      deviceClock: sast(D1, '06:25'),
    });
    expect(r.status).toBe(200);
    const [d] = await ownerQuery('SELECT drift_seconds, drift_flagged FROM declarations WHERE id = (SELECT id FROM declarations ORDER BY received_at DESC LIMIT 1)');
    expect(d).toEqual({ drift_seconds: 420, drift_flagged: true });
  });

  it('refuses events more than 72 hours old', async () => {
    const old = new Date(Date.now() - 73 * 3600 * 1000).toISOString();
    const r = await duty('duty_from', old);
    expect(r.status).toBe(422);
  });

  it('uses server time for an event sent straight away', async () => {
    const now = new Date().toISOString();
    const r = await duty('duty_from', now);
    expect(r.status).toBe(200);
    const [ev] = await ownerQuery(`SELECT late_synced FROM duty_events WHERE kind = 'duty_from' ORDER BY received_at DESC LIMIT 1`);
    expect(ev.late_synced).toBe(false);
  });

  describe('management view', () => {
    it("lists a day's attendance with statuses and flags", async () => {
      const r = await w.http().get(`/api/attendance?date=${D2}`).set('Authorization', `Bearer ${supervisor}`);
      expect(r.status).toBe(200);
      expect(r.body.rows).toHaveLength(1);
      expect(r.body.rows[0]).toMatchObject({
        employeeName: 'John Smith',
        shiftName: 'Day',
        arrivalStatus: 'ON_TIME',
        departureStatus: 'EARLY_DEPARTURE',
        onDeclared: true,
        fromDeclared: true,
        selfiePending: false,
        lateSynced: true,
        hasComment: true,
      });
    });

    it('shows a shift in full with the declaration wording', async () => {
      const r = await w.http().get(`/api/attendance/${attendanceId}`).set('Authorization', `Bearer ${supervisor}`);
      expect(r.status).toBe(200);
      expect(r.body.events.map((e: { kind: string }) => e.kind)).toEqual(['duty_on', 'duty_from']);
      expect(r.body.declarations[0].statements[2].text).toMatch(/taken receipt of all equipment/);
      expect(r.body.events[0].device_label).toBe('Device 001');
    });

    it('serves the selfie and logs the view', async () => {
      const r = await w.http().get(`/api/attendance/${attendanceId}/selfie/duty_on`).set('Authorization', `Bearer ${supervisor}`);
      expect(r.status).toBe(200);
      const log = await ownerQuery(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'attendance.selfie_view'`);
      expect(log[0].n).toBe(1);
    });

    it('shows the registration photo of whoever worked a shift at the site, even with a different home site', async () => {
      const elsewhere = await w
        .http()
        .post('/api/sites')
        .set('Authorization', `Bearer ${admin}`)
        .send({ name: 'Home Site', address: 'x', client: 'x', province: 'GP', minimumGrade: 'E', armed: false,
                shifts: [{ name: 'Day', kind: 'day', startTime: '06:00', endTime: '18:00', guardsRequired: 1 }] });
      const o = await enrol(w, admin, enrolmentData(elsewhere.body.id, { idNumber: '9202204720083', fullName: 'Relief Guard' }));
      const on = await w
        .http()
        .post('/api/attendance/on-behalf')
        .set('Authorization', `Bearer ${supervisor}`)
        .send({ employeeId: o.body.officer.id, kind: 'duty_on', reason: 'Relief cover at Estate ABC' });
      // The supervisor cannot see this officer at all: their home site is not one of the supervisor's sites.
      expect(on.status).toBe(404);
      const d = await w
        .http()
        .post('/api/devices')
        .set('Authorization', `Bearer ${admin}`)
        .send({ label: 'Device 003', serialOrImei: '356938035643811', siteId: w.a.siteId });
      const l = await w.http().post('/api/device/login').set('X-Device-Token', d.body.deviceToken).send({ employeeNumber: o.body.officer.employeeNumber, pin: o.body.initialPin });
      const g = { 'X-Device-Token': d.body.deviceToken, Authorization: `Bearer ${l.body.token}` };
      const now = new Date().toISOString();
      const r = await w.http().post('/api/device/duty').set(g).send({ eventId: randomUUID(), kind: 'duty_on', pin: o.body.initialPin, trustedAt: now, deviceClock: now });
      expect(r.status).toBe(200);
      expect(r.body.attendance.siteName).toBe('Estate ABC');
      const photo = await w.http().get(`/api/attendance/${r.body.attendance.id}/registration-photo`).set('Authorization', `Bearer ${supervisor}`);
      expect(photo.status).toBe(200);
      expect(photo.headers['content-type']).toBe('image/png');
      const other = await w.http().get(`/api/officers/${o.body.officer.id}/photos/face`).set('Authorization', `Bearer ${supervisor}`);
      expect(other.status).toBe(404);
    });

    it('lets a supervisor approve an exception with a reason', async () => {
      const r = await w
        .http()
        .post(`/api/attendance/${attendanceId}/exception`)
        .set('Authorization', `Bearer ${supervisor}`)
        .send({ reason: 'Left early with permission to take child to hospital' });
      expect(r.status).toBe(201);
      const list = await w.http().get(`/api/attendance?date=${D2}`).set('Authorization', `Bearer ${supervisor}`);
      expect(list.body.rows[0].exceptionReason).toMatch(/hospital/);
    });

    it('lets a supervisor log Duty On for a guard only with a reason, and audits it', async () => {
      const none = await w
        .http()
        .post('/api/attendance/on-behalf')
        .set('Authorization', `Bearer ${supervisor}`)
        .send({ employeeId, kind: 'duty_on' });
      expect(none.status).toBe(400);
      const r = await w
        .http()
        .post('/api/attendance/on-behalf')
        .set('Authorization', `Bearer ${supervisor}`)
        .send({ employeeId, kind: 'duty_on', reason: 'Guard phone battery flat' });
      expect(r.status).toBe(201);
      expect(r.body.declarations.duty_on).toBe(false);
      const [a] = await ownerQuery(`SELECT actor_label, reason FROM audit_log WHERE action = 'attendance.duty_on_on_behalf'`);
      expect(a).toEqual({ actor_label: 'Peter Supervisor', reason: 'Guard phone battery flat' });
      // The guard still owes the declaration on the device.
      const me = await w.http().get('/api/device/me').set(guard());
      expect(me.body.pendingDeclaration.kind).toBe('duty_on');
    });

    it('does not let an administrator without the role log attendance for guards', async () => {
      const r = await w
        .http()
        .post('/api/attendance/on-behalf')
        .set('Authorization', `Bearer ${admin}`)
        .send({ employeeId, kind: 'duty_from', reason: 'x x x' });
      expect(r.status).toBe(403);
    });

    it("keeps attendance invisible to another company (scenario 14)", async () => {
      const b = await w.login('manager@b.test');
      const list = await w.http().get(`/api/attendance?date=${D2}`).set('Authorization', `Bearer ${b}`);
      expect(list.body.rows).toEqual([]);
      const one = await w.http().get(`/api/attendance/${attendanceId}`).set('Authorization', `Bearer ${b}`);
      expect(one.status).toBe(404);
    });
  });

  it("rejects a guard token used from a different device", async () => {
    const other = await w
      .http()
      .post('/api/devices')
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'Device 002', serialOrImei: '356938035643810', siteId: w.a.siteId });
    const r = await w
      .http()
      .get('/api/device/me')
      .set({ 'X-Device-Token': other.body.deviceToken, Authorization: `Bearer ${guardToken}` });
    expect(r.status).toBe(401);
  });
});
