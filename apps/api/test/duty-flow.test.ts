import { randomUUID } from 'node:crypto';
import { NotificationsService, PushResult, PushSender } from '../src/notifications/notifications.service';
import { enrol, enrolmentData, ownerQuery, setupWorld, World } from './helpers';

class QuietSender implements PushSender {
  async send(): Promise<PushResult> {
    return { ok: true };
  }
}

/** Coming on duty (owner, 7 Oct 2026): the sign-in list of guards due now, and lock or roam. */
describe('coming on duty: who is due, and lock or roam', () => {
  let w: World;
  let admin: string;
  let supervisor: string;
  let bAdmin: string;
  let gate: { token: string; id: string };
  let warehouse: { token: string; id: string };
  let michael: { id: string; number: string; pin: string };
  let abram: { id: string; number: string; pin: string };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const site = () => `/api/sites/${w.a.siteId}`;
  const now = () => new Date().toISOString();
  const device = async (label: string, serial: string, postName: string) => {
    const d = await w.http().post('/api/devices').set(auth(admin)).send({ label, serialOrImei: serial, siteId: w.a.siteId, postName });
    return { token: d.body.deviceToken as string, id: d.body.device.id as string };
  };
  const guard = async (fullName: string, idNumber: string) => {
    const o = await enrol(w, admin, enrolmentData(w.a.siteId, { fullName, idNumber }));
    return { id: o.body.officer.id as string, number: o.body.officer.employeeNumber as string, pin: o.body.initialPin as string };
  };
  const signIn = async (d: { token: string }, who: { number: string; pin: string }) =>
    ({ 'X-Device-Token': d.token, Authorization: `Bearer ${(await w.http().post('/api/device/login').set('X-Device-Token', d.token).send({ login: who.number, pin: who.pin })).body.token}` });
  const dutyOn = (headers: Record<string, string>, who: { pin: string }) => w.http().post('/api/device/duty').set(headers).send({ eventId: randomUUID(), kind: 'duty_on', pin: who.pin, trustedAt: now(), deviceClock: now() });
  const expected = async (d: { token: string }) => (await w.http().get('/api/device/expected-guards').set('X-Device-Token', d.token)).body as { login: string; name: string; shift: string }[];

  beforeAll(async () => {
    w = await setupWorld();
    w.app.get(NotificationsService).sender = new QuietSender();
    admin = await w.login('admin@a.test');
    supervisor = await w.login('supervisor@a.test');
    bAdmin = await w.login('admin@b.test');
    gate = await device('Gate phone', '356938035643809', 'Main gate');
    warehouse = await device('Warehouse phone', '356938035643817', 'Warehouse entrance');
    michael = await guard('Michael Themba', '8001015009087');
    abram = await guard('Abram Komapi', '9202204720083');
  });
  afterAll(() => w.app.close());

  describe('the sign-in list', () => {
    it('needs the phone’s key', async () => {
      expect((await w.http().get('/api/device/expected-guards')).status).toBe(401);
    });

    it('with nobody rostered now, lists the site’s guards so a name can still be tapped', async () => {
      const list = await expected(gate);
      expect(list.map((g) => [g.name, g.shift])).toEqual([
        ['Abram Komapi', 'Not on the roster now'],
        ['Michael Themba', 'Not on the roster now'],
      ]);
      expect(JSON.stringify(list)).not.toMatch(/8001015009087|pin/i);
    });

    it('lists the guards whose shift at this site is starting or running, by name, and drops one who is on duty', async () => {
      // A shift that is running now at this site, and both guards rostered on it today.
      const t = (offsetHours: number) => new Date(Date.now() + (2 + offsetHours) * 3600_000).toISOString().slice(11, 16);
      const [shift] = await ownerQuery(
        `INSERT INTO site_shifts (company_id, site_id, name, kind, start_time, end_time, guards_required) SELECT company_id, id, 'Test shift', 'day', $2::time, $3::time, 2 FROM sites WHERE id = $1 RETURNING id`,
        [w.a.siteId, t(-1), t(6) > t(-1) ? t(6) : '23:59'],
      );
      const today = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
      for (const g of [michael, abram]) {
        const r = await w.http().post('/api/roster/changes').set(auth(admin)).send({ employeeId: g.id, date: today, shiftId: shift.id, reason: 'Test' });
        if (r.status >= 300) throw new Error(`roster change failed: ${r.status} ${JSON.stringify(r.body)}`);
      }
      const list = await expected(gate);
      expect(list.map((g) => g.name)).toEqual(['Abram Komapi', 'Michael Themba']);
      expect(list[0]).toMatchObject({ login: expect.stringMatching(/^[A-Z0-9]{3,}$/), shift: expect.stringMatching(/^Test shift \d\d:\d\d to \d\d:\d\d$/) });
      expect(JSON.stringify(list)).not.toMatch(/8001015009087|pin/i);
      // Michael comes on duty: only Abram is still due.
      const mh = await signIn(gate, michael);
      expect((await dutyOn(mh, michael)).status).toBe(200);
      expect((await expected(gate)).map((g) => g.name)).toEqual(['Abram Komapi']);
      // He goes off duty during the shift (a mistake, or sent home and called back): his name is on the list again.
      await ownerQuery('UPDATE attendance SET scheduled_end = NULL WHERE employee_id = $1 AND duty_from_at IS NULL', [michael.id]);
      const off = await w.http().post('/api/device/duty').set(mh).send({ eventId: randomUUID(), kind: 'duty_from', pin: michael.pin, trustedAt: now(), deviceClock: now() });
      expect(off.status).toBe(200);
      expect((await expected(gate)).map((g) => g.name)).toEqual(['Abram Komapi', 'Michael Themba']);
    });
  });

  describe('lock or roam', () => {
    it('lists the site’s positions and guards, everyone roaming to start', async () => {
      const r = await w.http().get(`${site()}/postings`).set(auth(supervisor));
      expect(r.status).toBe(200);
      expect(r.body.positions).toEqual([{ deviceId: gate.id, name: 'Main gate' }, { deviceId: warehouse.id, name: 'Warehouse entrance' }]);
      expect(r.body.guards.map((g: { name: string; deviceId: string | null }) => [g.name, g.deviceId])).toEqual([['Abram Komapi', null], ['Michael Themba', null]]);
      expect((await w.http().get(`${site()}/postings`).set(auth(bAdmin))).status).toBe(404);
    });

    it('locks a guard to a position of the site, and lets him roam again', async () => {
      const set = (token: string, employeeId: string, deviceId: string | null) => w.http().put(`${site()}/postings/${employeeId}`).set(auth(token)).send({ deviceId });
      expect((await set(supervisor, abram.id, randomUUID())).status).toBe(400);
      expect((await set(bAdmin, abram.id, warehouse.id)).status).toBe(404);
      expect((await set(supervisor, abram.id, warehouse.id)).status).toBe(200);
      expect((await set(supervisor, abram.id, gate.id)).status).toBe(200);
      const guards = (await w.http().get(`${site()}/postings`).set(auth(supervisor))).body.guards;
      expect(guards.find((g: { name: string }) => g.name === 'Abram Komapi').deviceId).toBe(gate.id);
      expect(await ownerQuery(`SELECT 1 AS x FROM audit_log WHERE action = 'guard_posting.set' AND entity_id = $1`, [abram.id])).toHaveLength(2);
    });

    it('tells the phone a locked guard is at his own position', async () => {
      const h = await signIn(gate, abram);
      expect((await w.http().get('/api/device/me').set(h)).body.posting).toEqual({ postName: 'Main gate', here: true });
      // Michael roams.
      const mh = await signIn(gate, michael);
      expect((await w.http().get('/api/device/me').set(mh)).body.posting).toBeNull();
    });

    it('lets a locked guard come on duty at another position, with a warning for him and an alert for the supervisor', async () => {
      const h = await signIn(warehouse, abram);
      expect((await w.http().get('/api/device/me').set(h)).body.posting).toEqual({ postName: 'Main gate', here: false });
      expect((await dutyOn(h, abram)).status).toBe(200);
      await w.app.get(NotificationsService).settled();
      const [a] = (await w.http().get('/api/notifications').set(auth(supervisor))).body.alerts;
      expect(a).toMatchObject({ kind: 'wrong_post', title: 'Guard at another position', body: 'Abram Komapi is posted at Main gate but came on duty on the Warehouse entrance phone.' });
      const [audit] = await ownerQuery(`SELECT after FROM audit_log WHERE action = 'attendance.duty_on' ORDER BY id DESC LIMIT 1`);
      expect(audit.after.postedAt).toBe('Main gate');
    });
  });
});
