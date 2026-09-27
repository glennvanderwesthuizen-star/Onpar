import { enrol, enrolmentData, ownerQuery, setupWorld, World } from './helpers';

/** Section 6.1: devices belong to posts; guards log in with employee number and PIN. */
describe('devices and guard login', () => {
  let w: World;
  let admin: string;
  let supervisor: string;
  let deviceToken: string;
  let deviceId: string;
  let pin: string;
  let employeeNumber: string;
  let officerId: string;

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    supervisor = await w.login('supervisor@a.test');
    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    pin = o.body.initialPin;
    employeeNumber = o.body.officer.employeeNumber;
    officerId = o.body.officer.id;
  });
  afterAll(() => w.app.close());

  const guardLogin = (p: string, token = deviceToken) =>
    w.http().post('/api/device/login').set('X-Device-Token', token).send({ employeeNumber, pin: p });

  it('registers a device to a post and shows its token once', async () => {
    const r = await w
      .http()
      .post('/api/devices')
      .set('Authorization', `Bearer ${admin}`)
      .send({ label: 'Device 001', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Gate 2' });
    expect(r.status).toBe(201);
    deviceToken = r.body.deviceToken;
    deviceId = r.body.device.id;
    expect(r.body.device).toMatchObject({ label: 'Device 001', siteName: 'Estate ABC', postName: 'Gate 2', status: 'registered' });
    const list = await w.http().get('/api/devices').set('Authorization', `Bearer ${admin}`);
    expect(JSON.stringify(list.body)).not.toContain(deviceToken);
  });

  it('only lets a system administrator register devices', async () => {
    const r = await w
      .http()
      .post('/api/devices')
      .set('Authorization', `Bearer ${supervisor}`)
      .send({ label: 'Device 002', serialOrImei: '356938035643810' });
    expect(r.status).toBe(403);
  });

  it('records heartbeat details and becomes active', async () => {
    const r = await w
      .http()
      .post('/api/device/heartbeat')
      .set('X-Device-Token', deviceToken)
      .send({ appVersion: '0.1.0', batteryPct: 87, kioskStatus: 'locked_task' });
    expect(r.status).toBe(200);
    expect(r.body.serverTime).toBeDefined();
    const [d] = await ownerQuery('SELECT status, battery_pct, app_version, last_seen_at FROM devices WHERE id = $1', [deviceId]);
    expect(d).toMatchObject({ status: 'active', battery_pct: 87, app_version: '0.1.0' });
    expect(d.last_seen_at).not.toBeNull();
  });

  it('rejects an unknown device', async () => {
    expect((await guardLogin(pin, 'not-a-real-token')).status).toBe(401);
  });

  it('logs a guard in with the right PIN', async () => {
    const r = await guardLogin(pin);
    expect(r.status).toBe(200);
    expect(r.body.employee.name).toBe('John Smith');
    expect(r.body.token).toBeDefined();
  });

  it('does not accept a guard token for management endpoints', async () => {
    const { token } = (await guardLogin(pin)).body;
    expect((await w.http().get('/api/sites').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('locks the account after five wrong PINs, even for the right PIN afterwards', async () => {
    const wrong = pin === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 4; i++) expect((await guardLogin(wrong)).status).toBe(401);
    expect((await guardLogin(wrong)).status).toBe(423);
    const r = await guardLogin(pin);
    expect(r.status).toBe(423);
    expect(r.body.message).toMatch(/Ask your supervisor/);
    const events = await ownerQuery(`SELECT action FROM audit_log WHERE action LIKE 'guard.%' ORDER BY id`);
    expect(events.map((e) => e.action)).toEqual([
      'guard.login',
      'guard.login',
      'guard.login_failed',
      'guard.login_failed',
      'guard.login_failed',
      'guard.login_failed',
      'guard.locked_out',
    ]);
  });

  it('is unlocked by a supervisor reset with a reason, which issues a new PIN', async () => {
    const noReason = await w.http().post(`/api/officers/${officerId}/reset-pin`).set('Authorization', `Bearer ${supervisor}`).send({});
    expect(noReason.status).toBe(400);
    const r = await w
      .http()
      .post(`/api/officers/${officerId}/reset-pin`)
      .set('Authorization', `Bearer ${supervisor}`)
      .send({ reason: 'Guard forgot PIN, identity confirmed in person' });
    expect(r.status).toBe(201);
    expect((await guardLogin(pin === r.body.newPin ? '999999' : pin)).status).toBe(401);
    expect((await guardLogin(r.body.newPin)).status).toBe(200);
  });

  it('stops a disabled device from being used, and audits the change', async () => {
    const r = await w
      .http()
      .put(`/api/devices/${deviceId}`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ siteId: w.a.siteId, postName: 'Gate 2', status: 'disabled', reason: 'Reported stolen' });
    expect(r.status).toBe(200);
    const login = await guardLogin(pin);
    expect(login.status).toBe(403);
    expect(login.body.message).toMatch(/disabled/);
    const [a] = await ownerQuery(`SELECT reason, before->>'status' AS b, after->>'status' AS a FROM audit_log WHERE action = 'device.update'`);
    expect(a).toEqual({ reason: 'Reported stolen', b: 'active', a: 'disabled' });
  });

  it("does not let company B's device log in company A's guard", async () => {
    const adminB = await w.login('admin@b.test');
    const d = await w
      .http()
      .post('/api/devices')
      .set('Authorization', `Bearer ${adminB}`)
      .send({ label: 'B-1', serialOrImei: '990000862471854', siteId: w.b.siteId });
    const r = await guardLogin(pin, d.body.deviceToken);
    expect(r.status).toBe(401);
  });
});
