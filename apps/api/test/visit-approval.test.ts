import { randomUUID } from 'node:crypto';
import { DEFAULT_VISITOR_SETTINGS } from '@onpar/rules';
import { NotificationsService, PushResult, PushSender, PushTarget } from '../src/notifications/notifications.service';
import { enrol, enrolmentData, ownerQuery, PNG, setupWorld, World } from './helpers';

class RecordingSender implements PushSender {
  sent: { body: string; url: string }[] = [];
  async send(_target: PushTarget, payload: string): Promise<PushResult> {
    this.sent.push(JSON.parse(payload));
    return { ok: true };
  }
}

/** Visitor management, step 3 (plan approved 7 Oct 2026): the customer's approval, the wait, and the phone call. */
describe('visitor management: approval', () => {
  let w: World;
  let admin: string;
  let supervisor: string;
  let deviceToken: string;
  let guard: { token: string };
  let onceOff: string;
  let unit14: string;
  let unit9: string;
  let unit20: string;
  let thabo: { id: string; token: string };
  let lerato: { id: string; token: string };
  let nomsa: { id: string; token: string };
  let carol: { id: string; token: string };
  let seq = 0;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const g = () => ({ 'X-Device-Token': deviceToken, Authorization: `Bearer ${guard.token}` });
  const site = () => `/api/sites/${w.a.siteId}`;
  const now = () => new Date().toISOString();
  /** A new visitor at the gate, each a different person. */
  const arrive = async (data: Record<string, unknown> = {}, photos: string[] = ['identity']) => {
    seq += 1;
    const person = { idNumber: `P${String(seq).padStart(8, '0')}`, surname: 'Dlamini', names: 'T J', document: 'passport', method: 'manual' };
    const vehicle = { registration: `CA 55 ${seq}`, make: 'Toyota', model: 'Corolla', colour: 'White', vin: '', discExpiry: null, method: 'scan' };
    let r = w.http().post('/api/device/visitors').set(g()).field('data', JSON.stringify({ eventId: randomUUID(), type: 'vehicle', person, vehicle, pax: 1, categoryId: onceOff, unitId: unit14, trustedAt: now(), deviceClock: now(), ...data }));
    for (const p of photos) r = r.attach(p, PNG, { filename: `${p}.png`, contentType: 'image/png' });
    const res = await r;
    if (res.status !== 200) throw new Error(`arrive failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.id as string;
  };
  const state = async (id: string) => (await w.http().get(`/api/device/visitors/${id}`).set(g())).body;
  const decide = (who: { token: string }, id: string, decision: string) => w.http().post(`/api/customer/visits/${id}/decide`).set(auth(who.token)).send({ decision });
  const timeUp = (id: string) => ownerQuery(`UPDATE visits SET respond_by = now() - interval '1 second' WHERE id = $1`, [id]);
  const dial = (id: string, contact: string) => w.http().post(`/api/device/visitors/${id}/dial`).set(g()).send({ contact });
  const outcome = (id: string, contact: string, result: string, eventId = randomUUID()) => w.http().post(`/api/device/visitors/${id}/call-outcome`).set(g()).send({ eventId, contact, outcome: result });
  const myAlerts = async (who: { token: string }) => (await w.http().get('/api/notifications').set(auth(who.token))).body.alerts as { kind: string; title: string; body: string; url: string }[];
  const customer = async (body: Record<string, unknown>) => {
    const r = await w.http().post(`${site()}/customers`).set(auth(admin)).send(body);
    await ownerQuery('UPDATE customers SET must_change_password = false WHERE id = $1', [r.body.id]);
    return { id: r.body.id as string, token: await w.login(body.email as string, r.body.temporaryPassword) };
  };

  beforeAll(async () => {
    w = await setupWorld();
    w.app.get(NotificationsService).sender = new RecordingSender();
    admin = await w.login('admin@a.test');
    supervisor = await w.login('supervisor@a.test');
    const d = await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Gate phone', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Main gate' });
    deviceToken = d.body.deviceToken;
    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    guard = { token: (await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: o.body.officer.employeeNumber, pin: o.body.initialPin })).body.token };
    const gateId = (await w.http().post(`${site()}/gates`).set(auth(admin)).send({ name: 'Main gate' })).body.id;
    await w.http().put(`${site()}/gate-phones/${d.body.device.id}`).set(auth(admin)).send({ gateId });
    unit14 = (await w.http().post(`${site()}/units`).set(auth(admin)).send({ name: '14' })).body.id;
    unit9 = (await w.http().post(`${site()}/units`).set(auth(admin)).send({ name: '9' })).body.id;
    unit20 = (await w.http().post(`${site()}/units`).set(auth(admin)).send({ name: '20' })).body.id;
    onceOff = (await w.http().get(`${site()}/visitor-setup`).set(auth(admin))).body.categories[0].id;
    thabo = await customer({ kind: 'tenant', fullName: 'Thabo Tenant', email: 'thabo@home.test', unitId: unit14, phone: '082 555 0140', secondContactName: 'Zanele', secondContactPhone: '083 555 0199' });
    lerato = await customer({ kind: 'tenant', fullName: 'Lerato Molefe', email: 'lerato@home.test', unitId: unit14, phone: '084 555 0141' });
    nomsa = await customer({ kind: 'tenant', fullName: 'Nomsa Other', email: 'nomsa@home.test', unitId: unit20 });
    carol = await customer({ kind: 'client', fullName: 'Carol Client', email: 'carol@estate.test', phone: '011 555 0100' });
  });
  afterAll(() => w.app.close());

  it('asks everyone in the unit, with nothing about the visitor on a locked screen', async () => {
    const id = await arrive();
    for (const who of [thabo, lerato]) {
      const [a] = await myAlerts(who);
      expect(a).toMatchObject({ kind: 'visitor_request', title: 'Visitor at Main gate', body: 'Dlamini, T J. CA551 White Toyota Corolla, 1 passenger. Open to accept or refuse.', url: `/c/visits/${id}` });
    }
    expect(await myAlerts(nomsa)).toEqual([]);
    expect(await myAlerts(carol)).toEqual([]);
    const [n] = await ownerQuery(`SELECT lock_screen FROM notifications WHERE entity_id = $1 LIMIT 1`, [id]);
    expect(n.lock_screen).toBe('A visitor is at the gate. Open On Par to answer.');
    const s = await state(id);
    expect(s).toMatchObject({ status: 'awaiting_approval', visitor: 'Dlamini, T J', visiting: 'Unit 14', asked: 2, canDial: false, decided: null });
    expect(s.secondsLeft).toBeGreaterThan(110);
    expect(s.secondsLeft).toBeLessThanOrEqual(120);
    expect(s.dial).toEqual({ primary: { label: 'Unit 14', tried: false }, second: { label: 'Unit 14, second contact', tried: false } });
  });

  it('shows a tenant only the visitors for their own unit, and never an ID number', async () => {
    const mine = (await w.http().get('/api/customer/visits').set(auth(thabo.token))).body;
    expect(mine.waiting).toHaveLength(1);
    expect(mine.waiting[0]).toMatchObject({ visitor: 'Dlamini, T J', vehicle: 'CA551 White Toyota Corolla', pax: 1, gateName: 'Main gate', visiting: 'Unit 14', outcome: null });
    expect(JSON.stringify(mine)).not.toMatch(/P0000000|idNumber/);
    const id = mine.waiting[0].id;
    expect((await w.http().get('/api/customer/visits').set(auth(nomsa.token))).body).toEqual({ waiting: [], recent: [], onSite: [] });
    expect((await w.http().get(`/api/customer/visits/${id}`).set(auth(nomsa.token))).status).toBe(404);
    expect((await decide(nomsa, id, 'accept')).status).toBe(404);
    expect((await decide(carol, id, 'accept')).status).toBe(404);
    // Staff and guards are not customers.
    expect((await w.http().get('/api/customer/visits').set(auth(admin))).status).toBe(401);
    const bTenant = await w.login('admin@b.test');
    expect((await w.http().get(`/api/customer/visits/${id}`).set(auth(bTenant))).status).toBe(401);
  });

  it('lets the visitor in on the first Accept, and tells the other person in the unit', async () => {
    const id = (await w.http().get('/api/customer/visits').set(auth(thabo.token))).body.waiting[0].id;
    expect((await decide(thabo, id, 'maybe')).status).toBe(400);
    const r = await decide(thabo, id, 'accept');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'on_site', outcome: 'Accepted by Thabo Tenant' });
    const late = await decide(lerato, id, 'refuse');
    expect(late.status).toBe(409);
    expect(late.body.message).toBe('This visitor has already been let in.');
    expect(await state(id)).toMatchObject({ status: 'on_site', statusLabel: 'On site', decided: 'Accepted by Thabo Tenant in the app', canDial: false });
    const [v] = await ownerQuery('SELECT status, entry_at IS NOT NULL AS entered, decided_at IS NOT NULL AS decided FROM visits WHERE id = $1', [id]);
    expect(v).toEqual({ status: 'on_site', entered: true, decided: true });
    expect((await myAlerts(lerato))[0]).toMatchObject({ kind: 'visitor_answered', body: 'Thabo Tenant accepted Dlamini, T J.' });
    expect((await myAlerts(thabo))[0].kind).toBe('visitor_request');
    const [a] = await ownerQuery(`SELECT actor_type, actor_label, after FROM audit_log WHERE action = 'visit.approve' AND entity_id = $1`, [id]);
    expect(a).toEqual({ actor_type: 'customer', actor_label: 'Thabo Tenant', after: { method: 'push' } });
    expect((await w.http().get(`${site()}/visits`).set(auth(supervisor))).body[0]).toMatchObject({ status: 'on_site', answered: 'Thabo Tenant, in the app' });
  });

  it('turns the visitor away on Refuse', async () => {
    const id = await arrive();
    expect((await decide(lerato, id, 'refuse')).body).toMatchObject({ status: 'denied', outcome: 'Refused by Lerato Molefe' });
    expect(await state(id)).toMatchObject({ status: 'denied', decided: 'Refused by Lerato Molefe in the app' });
    const [v] = await ownerQuery('SELECT denied_reason, entry_at FROM visits WHERE id = $1', [id]);
    expect(v).toEqual({ denied_reason: 'customer', entry_at: null });
  });

  it('does not let the guard phone while the customer still has time to answer', async () => {
    const id = await arrive();
    expect((await dial(id, 'primary')).status).toBe(409);
    expect((await outcome(id, 'primary', 'approved')).status).toBe(409);
    expect((await w.http().post(`/api/device/visitors/${id}/no-response`).set(g()).send({ eventId: randomUUID() })).status).toBe(409);
    expect((await state(id)).status).toBe('awaiting_approval');
    await decide(thabo, id, 'refuse');
  });

  it('after the wait, has the guard phone the unit without showing him the number, then the second contact', async () => {
    const id = await arrive();
    await timeUp(id);
    expect(await state(id)).toMatchObject({ status: 'awaiting_approval', secondsLeft: 0, canDial: true });
    const first = await dial(id, 'primary');
    expect(first.body).toEqual({ number: '082 555 0140', label: 'Unit 14' });
    expect((await outcome(id, 'primary', 'busy')).status).toBe(400);
    const eventId = randomUUID();
    const none = await outcome(id, 'primary', 'no_answer', eventId);
    expect(none.body).toMatchObject({ status: 'awaiting_approval', canDial: true, dial: { primary: { tried: true }, second: { tried: false } } });
    // Sent twice by a weak signal: saved once.
    await outcome(id, 'primary', 'no_answer', eventId);
    const [{ n }] = await ownerQuery('SELECT count(*)::int AS n FROM visit_approvals WHERE visit_id = $1', [id]);
    expect(n).toBe(1);
    expect((await dial(id, 'second')).body).toEqual({ number: '083 555 0199', label: 'Unit 14, second contact' });
    const ok = await outcome(id, 'second', 'approved');
    expect(ok.body).toMatchObject({ status: 'on_site', decided: 'Approved by phone', canDial: false });
    expect((await myAlerts(thabo))[0]).toMatchObject({ kind: 'visitor_answered', body: 'Dlamini, T J was approved by phone at the gate.' });
    // An answer in the app after that comes too late.
    expect((await decide(thabo, id, 'refuse')).status).toBe(409);
    const audit = await ownerQuery(`SELECT action, after::text AS t FROM audit_log WHERE entity_id = $1 AND action LIKE 'visit.%' ORDER BY id`, [id]);
    expect(audit.map((a: { action: string }) => a.action)).toEqual(['visit.create', 'visit.dial', 'visit.call_outcome', 'visit.dial', 'visit.call_outcome']);
    for (const a of audit) expect(a.t).not.toMatch(/555 01|55501/);
    expect((await w.http().get(`${site()}/visits`).set(auth(supervisor))).body[0]).toMatchObject({ status: 'on_site', answered: 'By phone at the gate' });
  });

  it('still takes an answer in the app while the guard is phoning', async () => {
    const id = await arrive();
    await timeUp(id);
    await outcome(id, 'primary', 'no_answer');
    expect((await decide(lerato, id, 'accept')).status).toBe(200);
    expect((await outcome(id, 'second', 'denied')).status).toBe(409);
    expect((await state(id)).decided).toBe('Accepted by Lerato Molefe in the app');
  });

  it('closes the visit as "Denied, no response" when nobody can be reached', async () => {
    const id = await arrive();
    await timeUp(id);
    await outcome(id, 'primary', 'no_answer');
    await outcome(id, 'second', 'no_answer');
    const eventId = randomUUID();
    const r = await w.http().post(`/api/device/visitors/${id}/no-response`).set(g()).send({ eventId });
    expect(r.body).toMatchObject({ status: 'denied_no_response', statusLabel: 'Denied, no response', decided: 'Nobody answered' });
    expect((await w.http().post(`/api/device/visitors/${id}/no-response`).set(g()).send({ eventId })).status).toBe(200);
    expect((await myAlerts(lerato))[0].body).toBe('Nobody answered, so Dlamini, T J was turned away.');
    expect((await w.http().get(`/api/customer/visits/${id}`).set(auth(thabo.token))).body.outcome).toBe('Nobody answered, so the visitor was turned away');
  });

  it('goes straight to the phone when nobody in the unit uses the app', async () => {
    const id = await arrive({ unitId: unit9 });
    const s = await state(id);
    expect(s).toMatchObject({ asked: 0, secondsLeft: 0, canDial: true, dial: { primary: null, second: null } });
    expect((await dial(id, 'primary')).status).toBe(400);
    expect((await w.http().post(`/api/device/visitors/${id}/no-response`).set(g()).send({ eventId: randomUUID() })).body.status).toBe('denied_no_response');
  });

  it('asks the client when the visitor is here for the office', async () => {
    const id = await arrive({ unitId: null });
    expect((await myAlerts(carol))[0]).toMatchObject({ kind: 'visitor_request', url: `/c/visits/${id}` });
    expect((await state(id)).visiting).toBe('The office');
    expect((await decide(thabo, id, 'accept')).status).toBe(404);
    expect((await decide(carol, id, 'accept')).body.status).toBe('on_site');
  });

  it('shows the face photo of a visitor on foot to the unit they are here to see, and records each look', async () => {
    const id = await arrive({ type: 'pedestrian', vehicle: null, pax: null }, ['identity', 'face']);
    expect((await w.http().get(`/api/customer/visits/${id}`).set(auth(thabo.token))).body).toMatchObject({ type: 'pedestrian', vehicle: null, hasFace: true });
    const photo = await w.http().get(`/api/customer/visits/${id}/face`).set(auth(thabo.token));
    expect(photo.status).toBe(200);
    expect(photo.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(photo.body, PNG)).toBe(0);
    expect((await w.http().get(`/api/customer/visits/${id}/face`).set(auth(nomsa.token))).status).toBe(404);
    const [a] = await ownerQuery(`SELECT actor_label FROM audit_log WHERE action = 'visit.face_view' AND entity_id = $1`, [id]);
    expect(a.actor_label).toBe('Thabo Tenant');
    expect((await myAlerts(lerato))[0].body).toBe('Dlamini, T J. On foot. Open to accept or refuse.');
    await decide(thabo, id, 'accept');
  });

  it('follows the site’s settings for the wait and the second contact', async () => {
    await w.http().put(`${site()}/visitor-settings`).set(auth(admin)).send({ ...DEFAULT_VISITOR_SETTINGS, noResponseSeconds: 45, secondContact: false });
    const id = await arrive();
    const s = await state(id);
    expect(s.secondsLeft).toBeGreaterThan(40);
    expect(s.secondsLeft).toBeLessThanOrEqual(45);
    expect(s.dial.second).toBeNull();
    await timeUp(id);
    expect((await dial(id, 'second')).status).toBe(400);
    await decide(thabo, id, 'refuse');
  });

  it('never asks a customer about a barred visitor', async () => {
    await w.http().post(`${site()}/barred`).set(auth(admin)).send({ kind: 'registration', value: 'ND 1', reason: 'Theft' });
    const before = (await myAlerts(thabo)).length;
    seq += 1;
    const r = await w.http().post('/api/device/visitors').set(g()).field('data', JSON.stringify({ eventId: randomUUID(), type: 'vehicle', person: { idNumber: 'P99999999', surname: 'Barred', names: '', document: 'passport', method: 'manual' }, vehicle: { registration: 'ND 1', make: '', model: '', colour: '', vin: '', discExpiry: null, method: 'scan' }, pax: 0, categoryId: onceOff, unitId: unit14, trustedAt: now(), deviceClock: now() })).attach('identity', PNG, { filename: 'i.png', contentType: 'image/png' });
    expect(r.body.status).toBe('denied');
    expect(await myAlerts(thabo)).toHaveLength(before);
    expect((await w.http().get('/api/customer/visits').set(auth(thabo.token))).body.recent.some((v: { visitor: string }) => v.visitor === 'Barred')).toBe(false);
    expect((await state(r.body.id)).blocked).toMatch(/barred list/);
  });
});
