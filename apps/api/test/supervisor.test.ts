import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { DutyService } from '../src/attendance/duty.service';
import { NotificationsService, PushKeys, PushResult, PushSender, PushTarget } from '../src/notifications/notifications.service';
import { PatrolsService } from '../src/patrols/patrols.service';
import { enrol, enrolmentData, ownerQuery, setupWorld, World } from './helpers';

class RecordingSender implements PushSender {
  sent: { endpoint: string; payload: { id: string; title: string; body: string; url: string } }[] = [];
  async send(target: PushTarget, payload: string, _keys: PushKeys): Promise<PushResult> {
    this.sent.push({ endpoint: target.endpoint, payload: JSON.parse(payload) });
    return { ok: true };
  }
}

function browser(name: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

/** Phase 2 of the plan of 6 Oct 2026: real events alert the people responsible, and the supervisor app's home. */
describe('the supervisor app', () => {
  let w: World;
  let alerts: NotificationsService;
  let sender: RecordingSender;
  let admin: string;
  let manager: string;
  let supervisor: string;
  let bAdmin: string;
  let deviceToken: string;
  let otherSiteId: string;
  let otherSiteDevice: string;
  let guard: { token: string; id: string; pin: string };
  const phone = browser('supervisor-phone');
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const now = () => new Date().toISOString();
  const myAlerts = async (t: string) => (await w.http().get('/api/notifications').set(auth(t))).body.alerts as { kind: string; title: string; body: string; url: string; siteId: string | null }[];
  const home = async (t: string) => (await w.http().get('/api/supervisor/home').set(auth(t))).body;
  const panic = (device: string, eventId = randomUUID(), guardToken?: string) => {
    const r = w.http().post('/api/device/panic').set('X-Device-Token', device);
    if (guardToken) r.set(auth(guardToken));
    return r.send({ eventId, trustedAt: now(), deviceClock: now(), lat: -26.1076, lng: 28.0567, accuracyM: 12, callStarted: true });
  };
  /** Sends whatever has been recorded, as the server does a moment after each event. */
  const send = async () => {
    await alerts.dispatch(w.a.companyId);
    await alerts.dispatch(w.b.companyId);
    // The service's own short timer may have picked an alert up first: wait for that send too.
    await alerts.settled();
  };

  beforeAll(async () => {
    w = await setupWorld();
    alerts = w.app.get(NotificationsService);
    sender = new RecordingSender();
    alerts.sender = sender;
    admin = await w.login('admin@a.test');
    manager = await w.login('manager@a.test');
    supervisor = await w.login('supervisor@a.test');
    bAdmin = await w.login('admin@b.test');
    await ownerQuery(`UPDATE site_contacts SET name = 'Control room', phone = '011 555 0100' WHERE site_id = $1 AND kind = 'control_room'`, [w.a.siteId]);
    deviceToken = (await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Device 001', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Main gate' })).body.deviceToken;
    otherSiteId = (
      await w.http().post('/api/sites').set(auth(manager)).send({
        name: 'Office Park',
        address: 'Rosebank',
        client: 'Office Park Body Corporate',
        province: 'GP',
        minimumGrade: 'E',
        armed: false,
        shifts: [{ name: 'Day', kind: 'day', startTime: '06:00', endTime: '18:00', guardsRequired: 1 }],
      })
    ).body.id;
    otherSiteDevice = (await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Device 002', serialOrImei: '356938035643817', siteId: otherSiteId })).body.deviceToken;
    const o = await enrol(w, admin, enrolmentData(w.a.siteId, { fullName: 'John Smith' }));
    const token = (await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: o.body.officer.employeeNumber, pin: o.body.initialPin })).body.token;
    guard = { token, id: o.body.officer.id, pin: o.body.initialPin };
    expect((await w.http().post('/api/notifications/push/subscribe').set(auth(supervisor)).send(phone)).status).toBe(200);
  });
  afterAll(() => w.app.close());
  beforeEach(() => {
    sender.sent = [];
  });

  describe('real alerts', () => {
    it('a panic reaches the phones of the people responsible for that site, once, with only the site on the locked screen', async () => {
      const eventId = randomUUID();
      expect((await panic(deviceToken, eventId, guard.token)).status).toBe(200);
      await send();
      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0].endpoint).toBe(phone.endpoint);
      expect(sender.sent[0].payload).toMatchObject({ title: 'On Par', body: 'Panic at Estate ABC' });
      expect(JSON.stringify(sender.sent[0].payload)).not.toContain('John');
      for (const who of [supervisor, manager, admin]) {
        const [a] = await myAlerts(who);
        expect(a).toMatchObject({ kind: 'panic', title: 'Panic at Estate ABC', body: 'John Smith at Estate ABC has pressed the panic button (Main gate).', url: `/m/panic/${eventId}`, siteId: w.a.siteId });
      }
      expect(await myAlerts(bAdmin)).toEqual([]);
      // The phone retries after a dropped connection: still one panic and one alert each.
      expect((await panic(deviceToken, eventId, guard.token)).status).toBe(200);
      await send();
      expect(sender.sent).toHaveLength(1);
      expect(await myAlerts(supervisor)).toHaveLength(1);
    });

    it('is not sent twice when two checks overlap', async () => {
      await panic(deviceToken);
      await Promise.all([alerts.dispatch(w.a.companyId), alerts.dispatch(w.a.companyId), alerts.dispatch(w.a.companyId)]);
      await alerts.settled();
      expect(sender.sent).toHaveLength(1);
    });

    it('a panic at another site does not reach a supervisor who is not linked to it, but does reach the managers', async () => {
      const before = (await myAlerts(supervisor)).length;
      await panic(otherSiteDevice);
      await send();
      expect(sender.sent).toHaveLength(0);
      expect(await myAlerts(supervisor)).toHaveLength(before);
      expect((await myAlerts(manager))[0]).toMatchObject({ kind: 'panic', title: 'Panic at Office Park', siteId: otherSiteId });
    });

    it('a BOLO alerts the site, except people who switched BOLO alerts off', async () => {
      const bolo = () => w.http().post('/api/device/bolo').set('X-Device-Token', deviceToken).send({ eventId: randomUUID(), note: 'White bakkie circling the gate', trustedAt: now(), deviceClock: now() });
      expect((await bolo()).status).toBe(200);
      await send();
      expect(sender.sent[0].payload.body).toBe('BOLO at Estate ABC');
      expect((await myAlerts(supervisor))[0]).toMatchObject({ kind: 'bolo', title: 'BOLO at Estate ABC', body: 'Main gate · White bakkie circling the gate', url: '/reports/bolo' });
      await w.http().put('/api/notifications/preferences').set(auth(supervisor)).send({ off: ['bolo'] });
      sender.sent = [];
      const before = (await myAlerts(supervisor)).length;
      await bolo();
      await send();
      expect(sender.sent).toHaveLength(0);
      expect(await myAlerts(supervisor)).toHaveLength(before);
      expect((await myAlerts(manager))[0].kind).toBe('bolo');
    });

    it('a Red report alerts the site; an Amber one does not', async () => {
      const report = (priority: string) => w.http().post('/api/reports').set(auth(manager)).send({ siteId: w.a.siteId, category: 'security', priority, description: 'Perimeter fence cut near the north gate' });
      const amber = await report('amber');
      expect(amber.status).toBeLessThan(300);
      await send();
      expect(sender.sent).toHaveLength(0);
      const red = await report('red');
      await send();
      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0].payload.body).toBe('Red report at Estate ABC');
      const [a] = await myAlerts(supervisor);
      expect(a.kind).toBe('red_report');
      expect(a.title).toBe('Red report at Estate ABC');
      expect(a.body).toMatch(/^#\d+ Security: Perimeter fence cut near the north gate$/);
      expect(a.url).toBe(`/m/reports/${red.body.id}`);
    });

    it('an alert is undone together with the event when the event fails to save', async () => {
      const before = (await ownerQuery('SELECT count(*)::int AS n FROM notifications'))[0].n;
      const bad = await w.http().post('/api/reports').set(auth(manager)).send({ siteId: randomUUID(), category: 'security', priority: 'red', description: 'A report for a site that does not exist' });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect((await ownerQuery('SELECT count(*)::int AS n FROM notifications'))[0].n).toBe(before);
    });
  });

  describe('shift change and patrols', () => {
    let attendanceId: string;

    it('shows who is on duty at each of the supervisor’s own sites, with the numbers to call', async () => {
      const t = now();
      expect((await w.http().post('/api/device/duty').set('X-Device-Token', deviceToken).set(auth(guard.token)).send({ eventId: randomUUID(), kind: 'duty_on', pin: guard.pin, trustedAt: t, deviceClock: t })).status).toBe(200);
      attendanceId = (await ownerQuery('SELECT id FROM attendance WHERE employee_id = $1', [guard.id]))[0].id;
      const h = await home(supervisor);
      expect(h.sites.map((s: { name: string }) => s.name)).toEqual(['Estate ABC']);
      expect(h.sites[0].contacts).toContainEqual({ kind: 'control_room', name: 'Control room', phone: '011 555 0100' });
      expect(h.sites[0].onDuty).toEqual([expect.objectContaining({ attendanceId, name: 'John Smith', cell: '082 555 0199', relief: null })]);
      // The manager sees every site; another company sees none of this.
      expect((await home(manager)).sites.map((s: { name: string }) => s.name)).toEqual(['Estate ABC', 'Office Park']);
      const b = await home(bAdmin);
      expect(JSON.stringify(b)).not.toContain('John Smith');
      expect(b.alerts).toEqual([]);
    });

    it('alerts once when a relief has not arrived 30 minutes after the shift, and shows the post as uncovered', async () => {
      const duty = w.app.get(DutyService);
      const end = new Date(Date.now() - 10 * 60_000);
      await ownerQuery(`UPDATE attendance SET scheduled_start = $2, scheduled_end = $3, roster_status = 'rostered' WHERE id = $1`, [attendanceId, new Date(end.getTime() - 12 * 3600_000), end]);
      // Ten minutes after the shift: still waiting, nobody is alerted.
      expect(await duty.reliefTick(new Date())).toBe(0);
      expect((await home(supervisor)).sites[0].onDuty[0].relief).toBe('waiting');
      // Thirty-one minutes after: the post is uncovered.
      await ownerQuery(`UPDATE attendance SET scheduled_end = $2 WHERE id = $1`, [attendanceId, new Date(Date.now() - 31 * 60_000)]);
      expect(await duty.reliefTick(new Date())).toBe(1);
      expect(await duty.reliefTick(new Date())).toBe(0);
      await send();
      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0].payload.body).toBe('Post uncovered at Estate ABC');
      const [a] = await myAlerts(supervisor);
      expect(a).toMatchObject({ kind: 'post_uncovered', title: 'Post uncovered at Estate ABC', url: '/m/duty' });
      expect(a.body).toContain("John Smith's relief has not arrived.");
      const h = await home(supervisor);
      expect(h.sites[0].onDuty[0].relief).toBe('uncovered');
      expect(h.alerts.find((x: { type: string }) => x.type === 'post_uncovered')).toMatchObject({ id: attendanceId, siteName: 'Estate ABC', url: '/m/duty' });
    });

    it('alerts when a patrol runs over its time', async () => {
      const [type] = await ownerQuery(`INSERT INTO patrol_types (company_id, site_id, code, name) VALUES ($1, $2, 'B', 'Perimeter') RETURNING id`, [w.a.companyId, w.a.siteId]);
      const started = new Date(Date.now() - 45 * 60_000);
      await ownerQuery(
        `INSERT INTO patrol_instances (id, company_id, site_id, patrol_type_id, attendance_id, employee_id, window_index, window_start, window_end, state, started_at, max_duration_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, 'active', $7, 30)`,
        [randomUUID(), w.a.companyId, w.a.siteId, type.id, attendanceId, guard.id, started, new Date(Date.now() + 3600_000)],
      );
      const r = await w.app.get(PatrolsService).tick(new Date());
      expect(r.raised).toBe(1);
      await send();
      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0].payload.body).toBe('Patrol overdue at Estate ABC');
      expect((await myAlerts(supervisor))[0]).toMatchObject({ kind: 'patrol_overdue', body: 'Perimeter · John Smith', url: '/m/alerts' });
      expect((await w.app.get(PatrolsService).tick(new Date())).raised).toBe(0);
      const h = await home(supervisor);
      expect(h.alerts.find((x: { type: string }) => x.type === 'patrol_overdue')).toMatchObject({ detail: 'Perimeter · John Smith', guardCell: '082 555 0199' });
    });

    it('lists everything open, most urgent first, and drops each item once it is dealt with', async () => {
      const h = await home(supervisor);
      const types = h.alerts.map((a: { type: string }) => a.type);
      expect(types[0]).toBe('panic');
      expect(new Set(types)).toEqual(new Set(['panic', 'post_uncovered', 'patrol_overdue', 'bolo', 'red_report']));
      expect(h.alerts.every((a: { siteName: string }) => a.siteName === 'Estate ABC')).toBe(true);
      expect(h.sites[0].openAlerts).toBe(h.alerts.length);
      // Resolve every panic from the phone, with the same rules as the website.
      for (const p of h.alerts.filter((a: { type: string }) => a.type === 'panic')) {
        expect((await w.http().post(`/api/panic/${p.id}/resolve`).set(auth(supervisor)).send({ note: 'False alarm, guard confirmed safe by phone.' })).status).toBe(200);
      }
      expect((await home(supervisor)).alerts.some((a: { type: string }) => a.type === 'panic')).toBe(false);
    });

    it('lets the supervisor release the guard with a reason, which clears the uncovered post', async () => {
      const noReason = await w.http().post('/api/attendance/on-behalf').set(auth(supervisor)).send({ employeeId: guard.id, kind: 'duty_from', reason: '' });
      expect(noReason.status).toBe(400);
      const r = await w.http().post('/api/attendance/on-behalf').set(auth(supervisor)).send({ employeeId: guard.id, kind: 'duty_from', reason: 'Relief did not arrive; released after the control room sent a patrol car.' });
      expect(r.status).toBeLessThan(300);
      const h = await home(supervisor);
      expect(h.sites[0].onDuty).toEqual([]);
      expect(h.alerts.some((a: { type: string }) => a.type === 'post_uncovered')).toBe(false);
      const [a] = await ownerQuery(`SELECT actor_label, reason FROM audit_log WHERE action = 'attendance.duty_from_on_behalf'`);
      expect(a).toEqual({ actor_label: 'Peter Supervisor', reason: 'Relief did not arrive; released after the control room sent a patrol car.' });
    });
  });

  describe('one panic in full', () => {
    it('gives the place, the guard, the location and the numbers to call, only to people who may see that site', async () => {
      const mine = randomUUID();
      const elsewhere = randomUUID();
      await panic(deviceToken, mine, guard.token);
      await panic(otherSiteDevice, elsewhere);
      const p = await w.http().get(`/api/supervisor/panic/${mine}`).set(auth(supervisor));
      expect(p.body).toMatchObject({ siteName: 'Estate ABC', postName: 'Main gate', guard: 'John Smith', guardCell: '082 555 0199', controlRoom: '011 555 0100', lat: -26.1076, lng: 28.0567, callStarted: true, resolvedAt: null, canManage: true });
      expect((await w.http().get(`/api/supervisor/panic/${elsewhere}`).set(auth(supervisor))).status).toBe(404);
      expect((await w.http().get(`/api/supervisor/panic/${elsewhere}`).set(auth(manager))).body.siteName).toBe('Office Park');
      expect((await w.http().get(`/api/supervisor/panic/${mine}`).set(auth(bAdmin))).status).toBe(404);
    });

    it('is closed to roles that may not see attendance or panics', async () => {
      const made = await w.http().post('/api/users').set(auth(admin)).send({ fullName: 'Carol Client', email: 'client@a.test', role: 'client_manager', siteIds: [w.a.siteId] });
      const t = (await w.http().post('/api/auth/login').send({ email: 'client@a.test', password: made.body.temporaryPassword })).body.token;
      await w.http().post('/api/auth/password').set(auth(t)).send({ currentPassword: made.body.temporaryPassword, newPassword: 'green gate at dawn' });
      expect((await w.http().get('/api/supervisor/home').set(auth(t))).status).toBe(403);
      expect((await w.http().get(`/api/supervisor/panic/${randomUUID()}`).set(auth(t))).status).toBe(403);
      // And no panic or other alert was ever written to a client's alerts list.
      expect((await w.http().get('/api/notifications').set(auth(t))).body.alerts).toEqual([]);
    });
  });
});
