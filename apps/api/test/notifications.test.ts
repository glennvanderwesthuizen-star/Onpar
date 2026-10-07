import { createECDH, randomBytes } from 'node:crypto';
import * as webpush from 'web-push';
import { NotificationsService, PushKeys, PushResult, PushSender, PushTarget } from '../src/notifications/notifications.service';
import { ownerQuery, setupWorld, World } from './helpers';

/** Stands in for Google and Apple: records what would have been sent, and can pretend a device is gone. */
class RecordingSender implements PushSender {
  sent: { target: PushTarget; payload: { id: string; title: string; body: string; url: string; tag: string }; keys: PushKeys }[] = [];
  answer: (endpoint: string) => PushResult = () => ({ ok: true });
  async send(target: PushTarget, payload: string, keys: PushKeys) {
    this.sent.push({ target, payload: JSON.parse(payload), keys });
    return this.answer(target.endpoint);
  }
}

/** A browser's side of a subscription: a real key pair, as a phone would make. */
function browser(name: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

/** Phase 1 of the plan of 6 Oct 2026: alerts to a person's own phone. */
describe('alerts to a phone', () => {
  let w: World;
  let service: NotificationsService;
  let sender: RecordingSender;
  let admin: string;
  let supervisor: string;
  let bAdmin: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const userId = async (email: string) => (await ownerQuery('SELECT id FROM users WHERE email = $1', [email]))[0].id as string;
  const phone = browser('supervisor-phone');

  beforeAll(async () => {
    w = await setupWorld();
    service = w.app.get(NotificationsService);
    sender = new RecordingSender();
    service.sender = sender;
    admin = await w.login('admin@a.test');
    supervisor = await w.login('supervisor@a.test');
    bAdmin = await w.login('admin@b.test');
  });
  afterAll(() => w.app.close());
  beforeEach(() => {
    sender.sent = [];
    sender.answer = () => ({ ok: true });
  });

  it('makes the server keys once, keeps the private half encrypted, and hands browsers the public half', async () => {
    const first = (await w.http().get('/api/notifications/push').set(auth(supervisor))).body;
    const again = (await w.http().get('/api/notifications/push').set(auth(bAdmin))).body;
    expect(first.publicKey).toHaveLength(87);
    expect(again.publicKey).toBe(first.publicKey);
    expect(first.devices).toEqual([]);
    const rows = await ownerQuery('SELECT public_key, private_key_enc FROM push_keys');
    expect(rows).toHaveLength(1);
    const { privateKey } = await service.keys();
    expect(rows[0].private_key_enc).not.toContain(privateKey);
    // The keys really work: the standard library can build an encrypted, signed alert with them.
    const details = webpush.generateRequestDetails(phone, 'hello', { vapidDetails: { subject: 'https://onpar.example', publicKey: first.publicKey, privateKey } });
    expect(details.headers['Content-Encoding']).toBe('aes128gcm');
    expect(String(details.headers.Authorization)).toMatch(/^vapid t=/);
  });

  it('needs a signed-in person', async () => {
    expect((await w.http().get('/api/notifications').send()).status).toBe(401);
    expect((await w.http().post('/api/notifications/test').send()).status).toBe(401);
  });

  it('still records a test alert when no device is set up, and says so', async () => {
    const r = await w.http().post('/api/notifications/test').set(auth(supervisor));
    expect(r.body).toEqual({ alerts: 1, sent: 0, failed: 0, noDevice: 1 });
    expect(sender.sent).toHaveLength(0);
    const list = (await w.http().get('/api/notifications').set(auth(supervisor))).body;
    expect(list.unread).toBe(1);
    expect(list.alerts[0]).toMatchObject({ kind: 'test', kindLabel: 'Test alert', title: 'Test alert', readAt: null, openedAt: null });
    expect(await ownerQuery('SELECT status FROM notification_deliveries')).toEqual([{ status: 'no_device' }]);
  });

  it('switches alerts on for a device, refusing addresses that are not a real delivery service', async () => {
    for (const endpoint of ['https://evil.test/hook', 'http://fcm.googleapis.com/fcm/send/x', 'https://localhost:4000/api/users']) {
      const bad = await w.http().post('/api/notifications/push/subscribe').set(auth(supervisor)).send({ ...phone, endpoint });
      expect(bad.status).toBe(400);
      expect(bad.body.errors).toEqual({ endpoint: 'This browser cannot receive On Par alerts.' });
    }
    const ok = await w.http().post('/api/notifications/push/subscribe').set(auth(supervisor)).set('User-Agent', ANDROID).send(phone);
    expect(ok.status).toBe(200);
    expect(ok.body.label).toBe('Android phone (Chrome)');
    const { devices } = (await w.http().get('/api/notifications/push').set(auth(supervisor))).body;
    expect(devices).toEqual([expect.objectContaining({ id: ok.body.id, label: 'Android phone (Chrome)', endpoint: phone.endpoint, lastAlertAt: null })]);
    const [a] = await ownerQuery(`SELECT actor_label, after FROM audit_log WHERE action = 'alerts.device_add'`);
    expect(a).toEqual({ actor_label: 'Peter Supervisor', after: { label: 'Android phone (Chrome)' } });
  });

  it('sends a test alert to the device with only a general line, and keeps the details for after sign-in', async () => {
    const r = await w.http().post('/api/notifications/test').set(auth(supervisor));
    expect(r.body).toEqual({ alerts: 1, sent: 1, failed: 0, noDevice: 0 });
    expect(sender.sent).toHaveLength(1);
    const { target, payload, keys } = sender.sent[0];
    expect(target).toMatchObject(phone.keys);
    expect(target.endpoint).toBe(phone.endpoint);
    expect(keys.subject).toBe('http://localhost:3000');
    const list = (await w.http().get('/api/notifications').set(auth(supervisor))).body;
    expect(payload).toEqual({ id: list.alerts[0].id, title: 'On Par', body: 'Test alert: alerts are working on this device.', url: `/alerts?open=${list.alerts[0].id}`, tag: `test:${list.alerts[0].id}` });
    expect(JSON.stringify(payload)).not.toContain('Peter');
    const [d] = await ownerQuery(`SELECT status, device_label FROM notification_deliveries WHERE notification_id = $1`, [list.alerts[0].id]);
    expect(d).toEqual({ status: 'sent', device_label: 'Android phone (Chrome)' });
    expect((await w.http().get('/api/notifications/push').set(auth(supervisor))).body.devices[0].lastAlertAt).not.toBeNull();
    expect((await ownerQuery(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'alerts.test'`))[0].n).toBe(2);
  });

  it('records that an alert was seen, and that it was opened by tapping it', async () => {
    const before = (await w.http().get('/api/notifications').set(auth(supervisor))).body;
    expect(before.unread).toBe(2);
    const [newest, older] = before.alerts;
    const opened = await w.http().post(`/api/notifications/${newest.id}/read`).set(auth(supervisor)).send({ opened: true });
    expect(opened.body).toEqual({ ok: true, url: '/alerts' });
    let list = (await w.http().get('/api/notifications').set(auth(supervisor))).body;
    expect(list.unread).toBe(1);
    expect(list.alerts[0].readAt).not.toBeNull();
    expect(list.alerts[0].openedAt).not.toBeNull();
    expect((await w.http().post('/api/notifications/read-all').set(auth(supervisor))).body).toEqual({ marked: 1 });
    list = (await w.http().get('/api/notifications').set(auth(supervisor))).body;
    expect(list.unread).toBe(0);
    expect(list.alerts.find((a: { id: string }) => a.id === older.id)).toMatchObject({ openedAt: null });
  });

  it('keeps each person to their own alerts and devices, within a company and across companies (scenario 14)', async () => {
    const mine = (await w.http().get('/api/notifications').set(auth(supervisor))).body.alerts[0];
    const device = (await w.http().get('/api/notifications/push').set(auth(supervisor))).body.devices[0];
    for (const other of [admin, bAdmin]) {
      const list = (await w.http().get('/api/notifications').set(auth(other))).body;
      expect(list).toEqual({ unread: 0, alerts: [] });
      expect((await w.http().get('/api/notifications/push').set(auth(other))).body.devices).toEqual([]);
      expect((await w.http().post(`/api/notifications/${mine.id}/read`).set(auth(other)).send({})).status).toBe(404);
      expect((await w.http().delete(`/api/notifications/push/devices/${device.id}`).set(auth(other))).status).toBe(404);
      expect((await w.http().post('/api/notifications/push/unsubscribe').set(auth(other)).send({ endpoint: phone.endpoint })).body).toEqual({ removed: 0 });
    }
    expect((await w.http().get('/api/notifications/push').set(auth(supervisor))).body.devices).toHaveLength(1);
    // An alert raised for a person of another company is not recorded at all.
    const cross = await service.notify(w.b.companyId, { userIds: [await userId('supervisor@a.test')], kind: 'test', title: 'x', lockScreen: 'x' });
    expect(cross.alerts).toBe(0);
  });

  it('lets a person choose which alerts they receive, but never switch off a panic', async () => {
    const prefs = (await w.http().get('/api/notifications/preferences').set(auth(supervisor))).body;
    expect(prefs.map((p: { kind: string; on: boolean; optional: boolean }) => [p.kind, p.on, p.optional])).toEqual([
      ['panic', true, false],
      ['bolo', true, true],
      ['patrol_overdue', true, true],
      ['post_uncovered', true, true],
      ['wrong_post', true, true],
      ['red_report', true, true],
      ['visitor_barred', true, true],
      ['visitor_exception', true, true],
      ['visitor_overstay', true, true],
      ['visitor_handover', true, true],
    ]);
    const noPanic = await w.http().put('/api/notifications/preferences').set(auth(supervisor)).send({ off: ['panic'] });
    expect(noPanic.status).toBe(400);
    expect(noPanic.body.message).toBe('Panic alerts cannot be switched off.');
    expect((await w.http().put('/api/notifications/preferences').set(auth(supervisor)).send({ off: ['payroll'] })).status).toBe(400);
    expect((await w.http().put('/api/notifications/preferences').set(auth(supervisor)).send({ off: ['bolo'] })).body).toEqual({ off: ['bolo'] });
    const after = (await w.http().get('/api/notifications/preferences').set(auth(supervisor))).body;
    expect(after.find((p: { kind: string }) => p.kind === 'bolo').on).toBe(false);
    const [a] = await ownerQuery(`SELECT before, after FROM audit_log WHERE action = 'alerts.preferences'`);
    expect(a).toEqual({ before: { off: [] }, after: { off: ['bolo'] } });

    const people = [await userId('supervisor@a.test'), await userId('admin@a.test')];
    const bolo = await service.notify(w.a.companyId, { userIds: people, kind: 'bolo', title: 'BOLO at Estate ABC', lockScreen: 'BOLO at Estate ABC', siteId: w.a.siteId, url: '/reports/bolo' });
    // The administrator gets it (no device, so only in the list); the supervisor switched it off.
    expect(bolo).toEqual({ alerts: 1, sent: 0, failed: 0, noDevice: 1 });
    expect(sender.sent).toHaveLength(0);
    const panic = await service.notify(w.a.companyId, { userIds: people, kind: 'panic', title: 'Panic at Estate ABC', body: 'Gate 2 · John Smith', lockScreen: 'Panic at Estate ABC', siteId: w.a.siteId, url: '/panic' });
    expect(panic).toEqual({ alerts: 2, sent: 1, failed: 0, noDevice: 1 });
    expect(sender.sent[0].payload.body).toBe('Panic at Estate ABC');
    expect(JSON.stringify(sender.sent[0].payload)).not.toContain('John Smith');
    const top = (await w.http().get('/api/notifications').set(auth(supervisor))).body.alerts[0];
    expect(top).toMatchObject({ kind: 'panic', kindLabel: 'Panic', body: 'Gate 2 · John Smith', url: '/panic', siteId: w.a.siteId });
    expect(top.siteName).toBeTruthy();
  });

  it('does not alert people whose role may not receive that kind', async () => {
    const [hr] = await ownerQuery(
      `INSERT INTO users (company_id, email, full_name, password_hash, role) VALUES ($1, 'hr@a.test', 'Hannah HR', 'x', 'hr_admin') RETURNING id`,
      [w.a.companyId],
    );
    const r = await service.notify(w.a.companyId, { userIds: [hr.id], kind: 'panic', title: 'Panic', lockScreen: 'Panic' });
    expect(r.alerts).toBe(0);
  });

  it('moves a shared phone to the person who allowed alerts on it last', async () => {
    const taken = await w.http().post('/api/notifications/push/subscribe').set(auth(bAdmin)).set('User-Agent', ANDROID).send(phone);
    expect(taken.status).toBe(200);
    expect((await w.http().get('/api/notifications/push').set(auth(supervisor))).body.devices).toEqual([]);
    expect((await w.http().post('/api/notifications/test').set(auth(supervisor))).body).toMatchObject({ sent: 0, noDevice: 1 });
    expect((await w.http().post('/api/notifications/test').set(auth(bAdmin))).body).toMatchObject({ sent: 1 });
    // Someone who knows only the address, not the browser's key, cannot take it over.
    const thief = await w.http().post('/api/notifications/push/subscribe').set(auth(supervisor)).send({ endpoint: phone.endpoint, keys: browser('x').keys });
    expect(thief.status).toBe(400);
    expect((await w.http().get('/api/notifications/push').set(auth(bAdmin))).body.devices).toHaveLength(1);
  });

  it('forgets a device that no longer accepts alerts, keeps one that only failed this time, and can remove one by hand', async () => {
    const tablet = browser('admin-tablet');
    const laptop = browser('admin-laptop');
    await w.http().post('/api/notifications/push/subscribe').set(auth(admin)).send(tablet);
    await w.http().post('/api/notifications/push/subscribe').set(auth(admin)).send(laptop);
    sender.answer = (endpoint) => (endpoint === tablet.endpoint ? { ok: false, gone: true, detail: 'The delivery service answered 410.' } : { ok: false, gone: false, detail: 'The delivery service could not be reached.' });
    expect((await w.http().post('/api/notifications/test').set(auth(admin))).body).toEqual({ alerts: 1, sent: 0, failed: 2, noDevice: 0 });
    let devices = (await w.http().get('/api/notifications/push').set(auth(admin))).body.devices;
    expect(devices.map((d: { endpoint: string }) => d.endpoint)).toEqual([laptop.endpoint]);
    const failed = await ownerQuery(`SELECT detail FROM notification_deliveries WHERE status = 'failed' ORDER BY id`);
    expect(failed.map((f) => f.detail).sort()).toEqual(['The delivery service answered 410.', 'The delivery service could not be reached.']);
    expect((await w.http().delete(`/api/notifications/push/devices/${devices[0].id}`).set(auth(admin))).body).toEqual({ removed: 1 });
    devices = (await w.http().get('/api/notifications/push').set(auth(admin))).body.devices;
    expect(devices).toEqual([]);
    expect((await ownerQuery(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'alerts.device_remove'`))[0].n).toBe(1);
  });

  it('keeps the record of what was sent from being changed', async () => {
    await expect(ownerQuery(`UPDATE notification_deliveries SET status = 'sent'`)).rejects.toThrow(/immutable/);
  });
});
