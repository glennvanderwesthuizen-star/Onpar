import { createECDH, randomBytes } from 'node:crypto';
import { NotificationsService, PushResult, PushSender, PushTarget } from '../src/notifications/notifications.service';
import { ownerQuery, setupWorld, World } from './helpers';

class RecordingSender implements PushSender {
  sent: { endpoint: string; payload: { body: string; url: string } }[] = [];
  async send(target: PushTarget, payload: string): Promise<PushResult> {
    this.sent.push({ endpoint: target.endpoint, payload: JSON.parse(payload) });
    return { ok: true };
  }
}
function browser(name: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint: `https://web.push.apple.com/${name}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

/** Phase 3 of the plan of 6 Oct 2026 (D-39): units, the client and tenants of a site, and the customer app's foundation. */
describe('customers: the client and tenants of a site', () => {
  let w: World;
  let sender: RecordingSender;
  let admin: string;
  let manager: string;
  let supervisor: string;
  let bAdmin: string;
  let unit14: string;
  let thabo: { id: string; temp: string; token: string };
  let lerato: { id: string; temp: string };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const site = () => `/api/sites/${w.a.siteId}`;
  const signIn = (email: string, password: string) => w.http().post('/api/auth/login').send({ email, password });
  const list = async (t = admin) => (await w.http().get(`${site()}/customers`).set(auth(t))).body as { units: { id: string; name: string; active: boolean; people: number }[]; customers: Record<string, unknown>[] };

  beforeAll(async () => {
    w = await setupWorld();
    sender = new RecordingSender();
    w.app.get(NotificationsService).sender = sender;
    admin = await w.login('admin@a.test');
    manager = await w.login('manager@a.test');
    supervisor = await w.login('supervisor@a.test');
    bAdmin = await w.login('admin@b.test');
  });
  afterAll(() => w.app.close());

  describe('set up by the administrator', () => {
    it('adds units to a site, each name once', async () => {
      const r = await w.http().post(`${site()}/units`).set(auth(admin)).send({ name: '14' });
      expect(r.status).toBe(201);
      unit14 = r.body.id;
      expect((await w.http().post(`${site()}/units`).set(auth(admin)).send({ name: '14' })).status).toBe(409);
      await w.http().post(`${site()}/units`).set(auth(admin)).send({ name: 'Shop 7' });
      expect((await list()).units.map((u) => [u.name, u.people])).toEqual([['14', 0], ['Shop 7', 0]]);
    });

    it('adds a tenant to a unit and the client to the site, each with a temporary password shown once', async () => {
      const noUnit = await w.http().post(`${site()}/customers`).set(auth(admin)).send({ kind: 'tenant', fullName: 'Thabo Tenant', email: 'thabo@home.test' });
      expect(noUnit.status).toBe(400);
      expect(noUnit.body.errors).toEqual({ unitId: 'Choose a unit.' });
      const t = await w.http().post(`${site()}/customers`).set(auth(admin)).send({ kind: 'tenant', fullName: 'Thabo Tenant', email: 'Thabo@Home.test', unitId: unit14, phone: '082 555 0140' });
      expect(t.status).toBe(201);
      expect(t.body.temporaryPassword).toHaveLength(16);
      thabo = { id: t.body.id, temp: t.body.temporaryPassword, token: '' };
      const c = await w.http().post(`${site()}/customers`).set(auth(admin)).send({ kind: 'client', fullName: 'Carol Client', email: 'carol@estate.test', phone: '011 555 0100' });
      expect(c.status).toBe(201);
      const { customers, units } = await list();
      expect(customers.map((x) => [x.fullName, x.kind, x.unitName, x.email, x.mustChangePassword, x.alertsOn])).toEqual([
        ['Carol Client', 'client', null, 'carol@estate.test', true, false],
        ['Thabo Tenant', 'tenant', '14', 'thabo@home.test', true, false],
      ]);
      expect(units.find((u) => u.name === '14')!.people).toBe(1);
      const [a] = await ownerQuery(`SELECT actor_label, after->>'fullName' AS name, after ? 'password' AS leaked FROM audit_log WHERE action = 'customer.create' ORDER BY id LIMIT 1`);
      expect(a).toEqual({ actor_label: 'Sam Admin', name: 'Thabo Tenant', leaked: false });
    });

    it('keeps one email to one sign-in, across staff, customers and companies', async () => {
      const again = await w.http().post(`${site()}/customers`).set(auth(admin)).send({ kind: 'tenant', fullName: 'Other', email: 'thabo@home.test', unitId: unit14 });
      expect(again.status).toBe(409);
      const staff = await w.http().post(`${site()}/customers`).set(auth(admin)).send({ kind: 'tenant', fullName: 'Not Staff', email: 'manager@b.test', unitId: unit14 });
      expect(staff.status).toBe(409);
      expect(staff.body.message).toBe('That email address already has an On Par sign-in.');
      const asStaff = await w.http().post('/api/users').set(auth(bAdmin)).send({ fullName: 'Thabo Staff', email: 'thabo@home.test', role: 'company_manager' });
      expect(asStaff.status).toBe(409);
    });

    it('is the administrator’s job only: managers may look, supervisors and other companies may not', async () => {
      expect((await w.http().get(`${site()}/customers`).set(auth(manager))).status).toBe(200);
      expect((await w.http().post(`${site()}/units`).set(auth(manager)).send({ name: '15' })).status).toBe(403);
      expect((await w.http().post(`${site()}/customers`).set(auth(manager)).send({ kind: 'client', fullName: 'X Y', email: 'x@y.test' })).status).toBe(403);
      expect((await w.http().get(`${site()}/customers`).set(auth(supervisor))).status).toBe(403);
      expect((await w.http().get(`${site()}/customers`).set(auth(bAdmin))).status).toBe(404);
      expect((await w.http().post(`${site()}/units`).set(auth(bAdmin)).send({ name: '99' })).status).toBe(404);
      expect((await w.http().put(`/api/sites/${w.b.siteId}/customers/${thabo.id}`).set(auth(bAdmin)).send({ kind: 'tenant', fullName: 'Hijack', unitId: null, active: true })).status).not.toBe(200);
      // A unit of another site (here another company's) cannot be used.
      const [bUnit] = await ownerQuery(`INSERT INTO site_units (company_id, site_id, name) VALUES ($1, $2, '1') RETURNING id`, [w.b.companyId, w.b.siteId]);
      const wrong = await w.http().post(`${site()}/customers`).set(auth(admin)).send({ kind: 'tenant', fullName: 'Wrong Unit', email: 'wrong@home.test', unitId: bUnit.id });
      expect(wrong.status).toBe(400);
    });

    it('imports a list of tenants in one go, creating units as needed, or nothing at all if a row is wrong', async () => {
      const bad = await w.http().post(`${site()}/customers/import`).set(auth(admin)).send({
        rows: [
          { unit: '20', fullName: 'Lerato Molefe', email: 'lerato@home.test', phone: '083 555 0020' },
          { unit: '21', fullName: 'Copy Cat', email: 'thabo@home.test' },
          { unit: '22', fullName: 'Twice One', email: 'twice@home.test' },
          { unit: '23', fullName: 'Twice Two', email: 'twice@home.test' },
        ],
      });
      expect(bad.status).toBe(400);
      expect(Object.values(bad.body.errors)).toEqual(['Row 2: thabo@home.test already has an On Par sign-in.', 'Row 4: twice@home.test appears more than once in the list.']);
      expect((await list()).customers).toHaveLength(2);
      const ok = await w.http().post(`${site()}/customers/import`).set(auth(admin)).send({
        rows: [
          { unit: '20', fullName: 'Lerato Molefe', email: 'lerato@home.test', phone: '083 555 0020' },
          { unit: '14', fullName: 'Naledi Tenant', email: 'naledi@home.test', secondContactName: 'Thabo', secondContactPhone: '082 555 0140' },
        ],
      });
      expect(ok.status).toBe(200);
      expect(ok.body.created.map((c: { fullName: string; unit: string; temporaryPassword: string }) => [c.fullName, c.unit, c.temporaryPassword.length])).toEqual([['Lerato Molefe', '20', 16], ['Naledi Tenant', '14', 16]]);
      const after = await list();
      expect(after.units.map((u) => [u.name, u.people])).toEqual([['14', 2], ['20', 1], ['Shop 7', 0]]);
      const l = after.customers.find((c) => c.email === 'lerato@home.test')!;
      lerato = { id: l.id as string, temp: ok.body.created[0].temporaryPassword };
    });

    it('will not retire a unit that still has active tenants', async () => {
      const r = await w.http().put(`${site()}/units/${unit14}`).set(auth(admin)).send({ name: '14', active: false });
      expect(r.status).toBe(409);
      expect(r.body.message).toBe('2 active tenants still belong to this unit. Deactivate or move them first.');
    });
  });

  describe('the customer app', () => {
    it('signs a customer in on the same sign-in page as staff, and makes them choose their own password first', async () => {
      expect((await signIn('thabo@home.test', 'not-the-password')).status).toBe(401);
      const r = await signIn('thabo@home.test', thabo.temp);
      expect(r.status).toBe(200);
      expect(r.body.account).toBe('customer');
      expect((await signIn('admin@a.test', 'OnPar-demo-2026')).body.account).toBe('staff');
      const t = r.body.token as string;
      const me = await w.http().get('/api/customer/me').set(auth(t));
      expect(me.body).toMatchObject({ fullName: 'Thabo Tenant', kindLabel: 'Tenant', unitName: '14', siteName: 'Estate ABC', mustChangePassword: true, phone: '082 555 0140' });
      expect((await w.http().put('/api/customer/contact').set(auth(t)).send({ phone: '082 555 0141' })).status).toBe(403);
      expect((await w.http().get('/api/notifications').set(auth(t))).status).toBe(403);
      expect((await w.http().post('/api/customer/password').set(auth(t)).send({ currentPassword: thabo.temp, newPassword: 'short' })).status).toBe(400);
      expect((await w.http().post('/api/customer/password').set(auth(t)).send({ currentPassword: thabo.temp, newPassword: 'walking the east fence' })).status).toBe(200);
      thabo.token = (await signIn('thabo@home.test', 'walking the east fence')).body.token;
      expect((await w.http().get('/api/customer/me').set(auth(thabo.token))).body.mustChangePassword).toBe(false);
      const [a] = await ownerQuery(`SELECT actor_type, actor_label FROM audit_log WHERE action = 'customer.password_change'`);
      expect(a).toEqual({ actor_type: 'customer', actor_label: 'Thabo Tenant' });
    });

    it('is the only thing a customer’s sign-in opens: every staff page refuses it', async () => {
      for (const path of ['/api/auth/me', '/api/sites', '/api/officers', '/api/users', '/api/attendance', '/api/reports', '/api/panic', '/api/supervisor/home', `${site()}/customers`, '/api/audit', '/api/device/me']) {
        const r = await w.http().get(path).set(auth(thabo.token));
        expect([401, 403]).toContain(r.status);
      }
      // And a member of staff is not a customer.
      expect((await w.http().get('/api/customer/me').set(auth(admin))).status).toBe(401);
    });

    it('lets a customer keep their own phone numbers current, and records the change under their name', async () => {
      const noName = await w.http().put('/api/customer/contact').set(auth(thabo.token)).send({ phone: '082 555 0141', secondContactPhone: '083 555 0199' });
      expect(noName.status).toBe(400);
      const r = await w.http().put('/api/customer/contact').set(auth(thabo.token)).send({ phone: '082 555 0141', secondContactName: 'Zanele', secondContactPhone: '083 555 0199' });
      expect(r.status).toBe(200);
      expect((await w.http().get('/api/customer/me').set(auth(thabo.token))).body).toMatchObject({ phone: '082 555 0141', secondContactName: 'Zanele', secondContactPhone: '083 555 0199' });
      const [a] = await ownerQuery(`SELECT actor_type, actor_label, before->>'phone' AS was, after->>'phone' AS now FROM audit_log WHERE action = 'customer.contact_update'`);
      expect(a).toEqual({ actor_type: 'customer', actor_label: 'Thabo Tenant', was: '082 555 0140', now: '082 555 0141' });
    });

    it('sends a customer alerts on their own phone, and keeps each customer to their own', async () => {
      const phone = browser('thabo-iphone');
      expect((await w.http().post('/api/notifications/push/subscribe').set(auth(thabo.token)).set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1').send(phone)).body.label).toBe('iPhone (Safari)');
      const test = await w.http().post('/api/notifications/test').set(auth(thabo.token));
      expect(test.body).toEqual({ alerts: 1, sent: 1, failed: 0, noDevice: 0 });
      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0].endpoint).toBe(phone.endpoint);
      expect(sender.sent[0].payload.url).toMatch(/^\/c\/alerts\?open=/);
      const mine = (await w.http().get('/api/notifications').set(auth(thabo.token))).body;
      expect(mine.unread).toBe(1);
      expect(mine.alerts[0]).toMatchObject({ kind: 'test', title: 'Test alert' });
      expect((await w.http().get('/api/notifications/preferences').set(auth(thabo.token))).body).toEqual([]);
      expect((await list()).customers.find((c) => c.id === thabo.id)!.alertsOn).toBe(true);
      // Another tenant of the same site sees none of it, and cannot touch it.
      const other = (await signIn('lerato@home.test', lerato.temp)).body.token as string;
      await w.http().post('/api/customer/password').set(auth(other)).send({ currentPassword: lerato.temp, newPassword: 'green gate at dawn' });
      expect((await w.http().get('/api/notifications').set(auth(other))).body).toEqual({ unread: 0, alerts: [] });
      expect((await w.http().get('/api/notifications/push').set(auth(other))).body.devices).toEqual([]);
      expect((await w.http().post(`/api/notifications/${mine.alerts[0].id}/read`).set(auth(other)).send({})).status).toBe(404);
      expect((await w.http().get('/api/customer/me').set(auth(other))).body).toMatchObject({ fullName: 'Lerato Molefe', unitName: '20' });
      // Staff do not see a customer's alerts either.
      expect((await w.http().get('/api/notifications').set(auth(admin))).body.alerts).toEqual([]);
    });

    it('stops working the moment the administrator deactivates the customer, and their phone gets no more alerts', async () => {
      const r = await w.http().put(`${site()}/customers/${thabo.id}`).set(auth(admin)).send({ kind: 'tenant', fullName: 'Thabo Tenant', unitId: unit14, phone: '082 555 0141', active: false });
      expect(r.status).toBe(200);
      expect((await w.http().get('/api/customer/me').set(auth(thabo.token))).status).toBe(401);
      expect((await signIn('thabo@home.test', 'walking the east fence')).status).toBe(401);
      expect((await ownerQuery('SELECT count(*)::int AS n FROM push_subscriptions WHERE customer_id = $1', [thabo.id]))[0].n).toBe(0);
      sender.sent = [];
      const told = await w.app.get(NotificationsService).notify(w.a.companyId, { userIds: [], customerIds: [thabo.id], kind: 'test', title: 'x', lockScreen: 'x' });
      expect(told.alerts).toBe(0);
    });

    it('gives a forgotten password a new temporary one', async () => {
      const r = await w.http().post(`${site()}/customers/${lerato.id}/reset-password`).set(auth(admin));
      expect(r.body.temporaryPassword).toHaveLength(16);
      expect((await signIn('lerato@home.test', 'green gate at dawn')).status).toBe(401);
      const t = (await signIn('lerato@home.test', r.body.temporaryPassword)).body.token;
      expect((await w.http().get('/api/customer/me').set(auth(t))).body.mustChangePassword).toBe(true);
    });
  });
});
