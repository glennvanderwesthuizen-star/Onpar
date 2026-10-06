import { randomUUID } from 'node:crypto';
import { enrol, enrolmentData, ownerQuery, PNG, setupWorld, World } from './helpers';

/**
 * A supervisor is also an employee (decision D-42): his sign-in can be joined to his own
 * officer record, and he then logs Duty On and Duty From from the supervisor app on his own
 * phone, with his PIN, a declaration and a selfie, no location and no waiting for a relief.
 */
describe('a supervisor as an employee (D-42)', () => {
  let w: World;
  let admin: string;
  let manager: string;
  let supervisor: string;
  let supervisorUserId: string;
  let me: { id: string; pin: string };
  let guard: { id: string; pin: string; token: string };
  let deviceToken: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const users = async () => (await w.http().get('/api/users').set(auth(admin))).body as { id: string; email: string; fullName: string; role: string; siteIds: string[]; employeeId: string | null; employeeLabel: string | null }[];
  const link = (token: string, userId: string, employeeId: string | null, extra: Record<string, unknown> = {}) =>
    w.http().put(`/api/users/${userId}`).set(auth(token)).send({ fullName: 'Peter Supervisor', role: 'site_supervisor', siteIds: [w.a.siteId], active: true, employeeId, ...extra });
  const duty = (token: string, kind: 'duty_on' | 'duty_from', pin: string) => {
    const now = new Date().toISOString();
    return w.http().post('/api/device/duty').set(auth(token)).send({ eventId: randomUUID(), kind, pin, trustedAt: now, deviceClock: now });
  };

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    manager = await w.login('manager@a.test');
    supervisor = await w.login('supervisor@a.test');
    supervisorUserId = (await users()).find((u) => u.email === 'supervisor@a.test')!.id;
    const o = await enrol(w, admin, enrolmentData(w.a.siteId, { fullName: 'Peter Supervisor' }));
    me = { id: o.body.officer.id, pin: o.body.initialPin };
    const g = await enrol(w, admin, enrolmentData(w.a.siteId, { fullName: 'John Smith', idNumber: '9001015009086' }));
    if (g.status !== 201) throw new Error(JSON.stringify(g.body));
    deviceToken = (await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Device 001', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Main gate' })).body.deviceToken;
    const token = (await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: g.body.officer.employeeNumber, pin: g.body.initialPin })).body.token;
    guard = { id: g.body.officer.id, pin: g.body.initialPin, token };
  });
  afterAll(() => w.app.close());

  describe('joining a sign-in to an officer record', () => {
    it('is refused until the two are joined, with words that say what to do', async () => {
      const r = await w.http().get('/api/device/me').set(auth(supervisor));
      expect(r.status).toBe(403);
      expect(r.body.message).toBe('Your sign-in is not joined to your officer record yet. Ask an administrator to join them on the Users page.');
      expect((await w.http().get('/api/auth/me').set(auth(supervisor))).body).toMatchObject({ employeeId: null, selfService: true });
    });

    it('is done by the administrator on the Users page, and audited', async () => {
      expect((await link(admin, supervisorUserId, randomUUID())).status).toBe(400);
      const r = await link(admin, supervisorUserId, me.id);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ employeeId: me.id });
      expect(r.body.employeeLabel).toMatch(/^Peter Supervisor \(/);
      expect((await w.http().get('/api/auth/me').set(auth(supervisor))).body).toMatchObject({ employeeId: me.id, selfService: true });
      const [a] = await ownerQuery(`SELECT after->>'employeeId' AS e FROM audit_log WHERE action = 'user.update' ORDER BY id DESC LIMIT 1`);
      expect(a.e).toBe(me.id);
    });

    it('joins one officer record to one sign-in only, and never across companies', async () => {
      const managerId = (await users()).find((u) => u.email === 'manager@a.test')!.id;
      const twice = await w.http().put(`/api/users/${managerId}`).set(auth(admin)).send({ fullName: 'Thandi Manager', role: 'company_manager', active: true, employeeId: me.id });
      expect(twice.status).toBe(409);
      expect(twice.body.message).toBe("That officer record is already joined to Peter Supervisor's sign-in.");
      const bAdmin = await w.login('admin@b.test');
      const bUsers = (await w.http().get('/api/users').set(auth(bAdmin))).body as { id: string; email: string }[];
      const other = await w.http().put(`/api/users/${bUsers.find((u) => u.email === 'supervisor@b.test')!.id}`).set(auth(bAdmin)).send({ fullName: 'Peter Supervisor', role: 'site_supervisor', siteIds: [w.b.siteId], active: true, employeeId: guard.id });
      expect(other.status).toBe(400);
    });

    it('is only for supervisors and site managers: other roles and guards keep to their own way in', async () => {
      const managerId = (await users()).find((u) => u.email === 'manager@a.test')!.id;
      await w.http().put(`/api/users/${managerId}`).set(auth(admin)).send({ fullName: 'Thandi Manager', role: 'company_manager', active: true, employeeId: guard.id });
      const r = await w.http().get('/api/device/me').set(auth(manager));
      expect(r.status).toBe(403);
      expect((await w.http().get('/api/auth/me').set(auth(manager))).body.selfService).toBe(false);
      await w.http().put(`/api/users/${managerId}`).set(auth(admin)).send({ fullName: 'Thandi Manager', role: 'company_manager', active: true, employeeId: null });
      // The guard's sign-in from a post phone still needs the phone: his token alone is not a way in.
      expect((await w.http().get('/api/device/me').set(auth(guard.token))).status).toBe(401);
    });
  });

  describe('his own shift, from his own phone', () => {
    let dutyEventId: string;

    it('shows him his own record and roster', async () => {
      const r = await w.http().get('/api/device/me').set(auth(supervisor));
      expect(r.status).toBe(200);
      expect(r.body.employee).toMatchObject({ id: me.id, name: 'Peter Supervisor' });
      expect(r.body.attendance).toBeNull();
      expect(r.body.roster).toBeDefined();
      expect((await w.http().get('/api/device/roster').set(auth(supervisor))).status).toBe(200);
    });

    it('logs Duty On with his PIN, at his home site, with no phone and no location recorded', async () => {
      const wrong = await duty(supervisor, 'duty_on', me.pin === '000000' ? '111111' : '000000');
      expect(wrong.status).toBe(401);
      const r = await duty(supervisor, 'duty_on', me.pin);
      expect(r.status).toBe(200);
      dutyEventId = r.body.dutyEventId;
      // The wording without the wait-for-relief statement.
      expect(r.body.declaration.statements).toHaveLength(3);
      expect(r.body.declaration.statements.join(' ')).not.toMatch(/relief/);
      const [a] = await ownerQuery('SELECT a.site_id, a.own_phone, d.device_id FROM attendance a JOIN duty_events d ON d.attendance_id = a.id WHERE a.employee_id = $1', [me.id]);
      expect(a).toEqual({ site_id: w.a.siteId, own_phone: true, device_id: null });
      const [audit] = await ownerQuery(`SELECT actor_type, actor_id FROM audit_log WHERE action = 'attendance.duty_on' ORDER BY id DESC LIMIT 1`);
      expect(audit).toEqual({ actor_type: 'employee', actor_id: me.id });
    });

    it('still owes the declaration and selfie, and records them under the wording he was shown', async () => {
      const state = (await w.http().get('/api/device/me').set(auth(supervisor))).body;
      expect(state.pendingDeclaration).toMatchObject({ kind: 'duty_on', dutyEventId });
      expect(state.pendingDeclaration.wording.statements).toHaveLength(3);
      const now = new Date().toISOString();
      const data = { eventId: randomUUID(), dutyEventId, accepted: [true, true, true], comment: '', trustedAt: now, deviceClock: now };
      const noSelfie = await w.http().post('/api/device/declarations').set(auth(supervisor)).send(data);
      expect(noSelfie.status).toBe(400);
      const r = await w.http().post('/api/device/declarations').set(auth(supervisor)).field('data', JSON.stringify(data)).attach('selfie', PNG, { filename: 'selfie.png', contentType: 'image/png' });
      expect(r.status).toBe(200);
      const [d] = await ownerQuery('SELECT wording_version, device_id, selfie_key IS NOT NULL AS selfie FROM declarations WHERE employee_id = $1', [me.id]);
      expect(d).toEqual({ wording_version: 1, device_id: null, selfie: true });
      expect((await w.http().get('/api/device/me').set(auth(supervisor))).body.pendingDeclaration).toBeNull();
    });

    it('does not count as a guard’s relief, and a guard’s relief rule is unchanged', async () => {
      const now = new Date().toISOString();
      expect((await w.http().post('/api/device/duty').set('X-Device-Token', deviceToken).set(auth(guard.token)).send({ eventId: randomUUID(), kind: 'duty_on', pin: guard.pin, trustedAt: now, deviceClock: now })).status).toBe(200);
      // The guard's shift ended ten minutes ago; the supervisor's own shift is set to start exactly then,
      // as a relief's would. The guard must still wait.
      const end = new Date(Date.now() - 10 * 60_000);
      await ownerQuery(`UPDATE attendance SET scheduled_start = $2, scheduled_end = $3, roster_status = 'rostered' WHERE employee_id = $1`, [guard.id, new Date(end.getTime() - 12 * 3600_000), end]);
      await ownerQuery(`UPDATE attendance SET scheduled_start = $2, scheduled_end = $3, roster_status = 'rostered' WHERE employee_id = $1`, [me.id, end, new Date(end.getTime() + 12 * 3600_000)]);
      const state = (await w.http().get('/api/device/me').set('X-Device-Token', deviceToken).set(auth(guard.token))).body;
      expect(state.attendance.relief).toMatchObject({ canLeave: false, outcome: 'wait' });
      const refused = await w.http().post('/api/device/duty').set('X-Device-Token', deviceToken).set(auth(guard.token)).send({ eventId: randomUUID(), kind: 'duty_from', pin: guard.pin, trustedAt: now, deviceClock: now });
      expect(refused.status).toBe(409);
    });

    it('logs Duty From whenever he leaves, without waiting for a relief, and the points rules still apply', async () => {
      const state = (await w.http().get('/api/device/me').set(auth(supervisor))).body;
      expect(state.attendance.relief).toMatchObject({ canLeave: true, outcome: 'no_rule' });
      expect((await w.http().post('/api/device/relief/give-turn').set(auth(supervisor)).send({ pin: me.pin })).status).toBe(400);
      const r = await duty(supervisor, 'duty_from', me.pin);
      expect(r.status).toBe(200);
      expect(r.body.declaration.statements).toHaveLength(1);
      const [a] = await ownerQuery('SELECT relief_status, departure_status, duty_from_at IS NOT NULL AS off FROM attendance WHERE employee_id = $1', [me.id]);
      // He left 12 hours before his (test) shift ended: recorded as an early departure, as for any employee.
      expect(a).toEqual({ relief_status: 'no_rule', departure_status: 'EARLY_DEPARTURE', off: true });
    });

    it('shows him his own score, training and uniform, and nobody else’s', async () => {
      for (const path of ['/api/device/score', '/api/device/qualifications', '/api/device/uniform']) {
        const r = await w.http().get(path).set(auth(supervisor));
        expect(r.status).toBe(200);
        expect(JSON.stringify(r.body)).not.toContain('John Smith');
      }
      const quals = (await w.http().get('/api/device/qualifications').set(auth(supervisor))).body;
      expect(JSON.stringify(quals)).toContain('First aid level 1');
    });

    it('keeps the post-phone-only pages closed to him', async () => {
      for (const path of ['/api/device/tasks', '/api/device/patrols', '/api/device/reports', '/api/device/reorders']) {
        expect((await w.http().get(path).set(auth(supervisor))).status).toBe(401);
      }
    });
  });

  describe('his own uniform order', () => {
    it('cannot be decided by himself; another manager decides it', async () => {
      // A site manager who is also an employee, with an order of his own waiting.
      const o = await enrol(w, admin, enrolmentData(w.a.siteId, { fullName: 'Mary Manager', idNumber: '8502025009082' }));
      if (o.status !== 201) throw new Error(JSON.stringify(o.body));
      const made = await w.http().post('/api/users').set(auth(admin)).send({ fullName: 'Mary Manager', email: 'mary@a.test', role: 'site_manager', siteIds: [w.a.siteId], employeeId: o.body.officer.id });
      expect(made.status).toBe(201);
      let mary = (await w.http().post('/api/auth/login').send({ email: 'mary@a.test', password: made.body.temporaryPassword })).body.token;
      await w.http().post('/api/auth/password').set(auth(mary)).send({ currentPassword: made.body.temporaryPassword, newPassword: 'green gate at dawn' });
      mary = (await w.http().post('/api/auth/login').send({ email: 'mary@a.test', password: 'green gate at dawn' })).body.token;
      const [order] = await ownerQuery(`INSERT INTO uniform_orders (company_id, number, employee_id, site_id, requested_at) VALUES ($1, 900, $2, $3, now()) RETURNING id`, [w.a.companyId, o.body.officer.id, w.a.siteId]);
      const body = { lines: [{ lineId: randomUUID(), decision: 'company' }] };
      const own = await w.http().post(`/api/uniform/orders/${order.id}/decide`).set(auth(mary)).send(body);
      expect(own.status).toBe(403);
      expect(own.body.message).toBe('This is your own order. Another manager must decide it.');
      // The company manager gets past that check (and is then asked to decide the order's real lines).
      const other = await w.http().post(`/api/uniform/orders/${order.id}/decide`).set(auth(manager)).send(body);
      expect(other.status).not.toBe(403);
    });
  });
});
