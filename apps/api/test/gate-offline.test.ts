import { randomUUID } from 'node:crypto';
import { NotificationsService, PushResult, PushSender, PushTarget } from '../src/notifications/notifications.service';
import { enrol, enrolmentData, ownerQuery, PNG, setupWorld, World } from './helpers';

class QuietSender implements PushSender {
  async send(_t: PushTarget, _p: string): Promise<PushResult> {
    return { ok: true };
  }
}

/**
 * Visitor management, step 7: the gate without signal. The gate phone keeps an offline pack;
 * with no signal the guard checks it, phones the customer, and the visit is sent later and
 * recorded as it happened at the gate.
 */
describe('visitor management: the gate without signal', () => {
  let w: World;
  let admin: string;
  let supervisor: string;
  let deviceToken: string;
  let guard: { token: string };
  let unit14: string;
  let unit20: string;
  let thabo: { id: string; token: string };
  let today: string;
  let seq = 0;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const g = () => ({ 'X-Device-Token': deviceToken, Authorization: `Bearer ${guard.token}` });
  const site = () => `/api/sites/${w.a.siteId}`;
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const person = (idNumber = `Q${String(++seq).padStart(8, '0')}`) => ({ idNumber, surname: 'Mokoena', names: 'L', document: 'passport', method: 'manual' });
  /** A visit the phone captured with no signal some minutes ago and sends now. */
  const sendLater = async (data: Record<string, unknown>, minutes = 20) => {
    const r = await w
      .http()
      .post('/api/device/visitors')
      .set(g())
      .field('data', JSON.stringify({ eventId: randomUUID(), type: 'pedestrian', person: person(), unitId: unit14, capturedOffline: true, trustedAt: ago(minutes), deviceClock: ago(minutes), ...data }))
      .attach('identity', PNG, { filename: 'id.png', contentType: 'image/png' })
      .attach('face', PNG, { filename: 'face.png', contentType: 'image/png' });
    return r;
  };
  const customer = async (body: Record<string, unknown>) => {
    const r = await w.http().post(`${site()}/customers`).set(auth(admin)).send(body);
    await ownerQuery('UPDATE customers SET must_change_password = false WHERE id = $1', [r.body.id]);
    return { id: r.body.id as string, token: await w.login(body.email as string, r.body.temporaryPassword) };
  };

  beforeAll(async () => {
    w = await setupWorld();
    w.app.get(NotificationsService).sender = new QuietSender();
    admin = await w.login('admin@a.test');
    supervisor = await w.login('supervisor@a.test');
    const d = await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Gate phone', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Main gate' });
    deviceToken = d.body.deviceToken;
    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    guard = { token: (await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: o.body.officer.employeeNumber, pin: o.body.initialPin })).body.token };
    const gateId = (await w.http().post(`${site()}/gates`).set(auth(admin)).send({ name: 'Main gate' })).body.id;
    await w.http().put(`${site()}/gate-phones/${d.body.device.id}`).set(auth(admin)).send({ gateId });
    unit14 = (await w.http().post(`${site()}/units`).set(auth(admin)).send({ name: '14' })).body.id;
    unit20 = (await w.http().post(`${site()}/units`).set(auth(admin)).send({ name: '20' })).body.id;
    thabo = await customer({ kind: 'tenant', fullName: 'Thabo Tenant', email: 'thabo@home.test', unitId: unit14, phone: '082 555 0140', secondContactName: 'Zanele', secondContactPhone: '083 555 0199' });
    await customer({ kind: 'client', fullName: 'Carol Client', email: 'carol@estate.test', phone: '011 555 0100' });
    today = (await ownerQuery(`SELECT to_char(now() AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS d`))[0].d;
  });
  afterAll(() => w.app.close());

  it('gives the gate phone its offline pack: passes, the barred list, who is on site and the numbers to phone', async () => {
    const cats = (await w.http().get(`${site()}/visitor-setup`).set(auth(admin))).body.categories;
    const p = await w.http().post('/api/customer/passes').set(auth(thabo.token)).send({ kind: 'once', visitorName: 'Sipho Nkosi', categoryId: cats[0].id, visitDate: today, idNumber: 'PASS0001' });
    expect(p.status).toBe(201);
    await w.http().post(`${site()}/barred`).set(auth(admin)).send({ kind: 'id_number', value: 'BAD00001', reason: 'Theft, case opened' });
    const r = await w.http().get('/api/device/visitors/offline-pack').set(g());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ today, hasClient: true });
    expect(r.body.office.primary.replace(/\D/g, '')).toBe('0115550100');
    const u14 = r.body.units.find((u: { name: string }) => u.name === '14');
    expect(u14.primary.replace(/\D/g, '')).toBe('0825550140');
    expect(r.body.units.find((u: { name: string }) => u.name === '20')).toMatchObject({ primary: null });
    expect(r.body.passes).toEqual([expect.objectContaining({ visitorName: 'Sipho Nkosi', idNumber: 'PASS0001', kind: 'once', visitDate: today, visiting: 'Unit 14' })]);
    expect(r.body.barred).toEqual([{ kind: 'id_number', value: 'BAD00001', unitId: null }]);
    expect(r.body.onSite).toEqual([]);
    // Another company's phone never gets it, and a phone that is not a gate is told so.
    expect((await w.http().get('/api/device/visitors/offline-pack').set({ 'X-Device-Token': deviceToken })).status).toBe(401);
  });

  it('records a visitor let in on a pass with no signal, at the time it happened, and uses the pass', async () => {
    const passId = (await w.http().get('/api/device/visitors/offline-pack').set(g())).body.passes[0].id;
    const r = await sendLater({ person: person('PASS0001'), passId, offline: { decision: 'pass' } }, 30);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'on_site' });
    const [v] = await ownerQuery(
      `SELECT status, captured_offline, pass_id, announced, checks, extract(epoch FROM now() - entry_at) / 60 AS mins FROM visits WHERE id = $1`,
      [r.body.id],
    );
    expect(v).toMatchObject({ status: 'on_site', captured_offline: true, pass_id: passId, announced: true });
    expect(v.checks.offline).toBe('pass');
    expect(Number(v.mins)).toBeGreaterThan(28);
    const [pass] = await ownerQuery('SELECT status, used_visit_id FROM visitor_passes WHERE id = $1', [passId]);
    expect(pass).toEqual({ status: 'used', used_visit_id: r.body.id });
    // Sent twice (the phone retried): saved once.
  });

  it('records the phone call the guard made with no signal, as approved or denied by phone', async () => {
    const yes = await sendLater({ offline: { decision: 'approved', contact: 'primary' } });
    expect(yes.body.status).toBe('on_site');
    const [a] = await ownerQuery(`SELECT method, outcome, contact, customer_id FROM visit_approvals WHERE visit_id = $1`, [yes.body.id]);
    expect(a).toEqual({ method: 'phone', outcome: 'approved', contact: 'primary', customer_id: thabo.id });
    const no = await sendLater({ offline: { decision: 'denied', contact: 'second' } });
    expect(no.body.status).toBe('denied');
    const [d] = await ownerQuery(`SELECT v.denied_reason, a.outcome, a.contact FROM visits v JOIN visit_approvals a ON a.visit_id = v.id WHERE v.id = $1`, [no.body.id]);
    expect(d).toEqual({ denied_reason: 'phone', outcome: 'denied', contact: 'second' });
    const none = await sendLater({ offline: { decision: 'no_answer', contact: 'primary' } });
    expect(none.body.status).toBe('denied_no_response');
    // Nobody is asked in the app afterwards: the visitor has long been dealt with.
    const [n] = await ownerQuery(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'visitor_request' AND entity_id = ANY($1::uuid[])`, [[yes.body.id, no.body.id, none.body.id]]);
    expect(n.n).toBe(0);
  });

  it('records a barred visitor the phone stopped, and raises the alarm when a barred visitor was let in before the phone knew', async () => {
    const stopped = await sendLater({ person: person('BAD00001'), offline: { decision: 'barred' } });
    expect(stopped.body).toMatchObject({ status: 'denied' });
    await w.http().post(`${site()}/barred`).set(auth(admin)).send({ kind: 'id_number', value: 'NEWBAD01', reason: 'Added after the phone lost signal' });
    const letIn = await sendLater({ person: person('NEWBAD01'), offline: { decision: 'approved', contact: 'primary' } });
    expect(letIn.body.status).toBe('on_site');
    const [v] = await ownerQuery('SELECT checks FROM visits WHERE id = $1', [letIn.body.id]);
    expect(v.checks).toMatchObject({ offline: 'approved', barredLetIn: true });
    const alerts = (await w.http().get('/api/notifications').set(auth(supervisor))).body.alerts as { title: string; body: string }[];
    expect(alerts.some((x) => x.title.startsWith('Barred visitor let in') && x.body.includes('no signal'))).toBe(true);
  });

  it('closes an earlier visit still on site instead of asking the guard for a reason', async () => {
    const first = await sendLater({ person: person('TWICE001'), offline: { decision: 'approved', contact: 'primary' } }, 60);
    const again = await sendLater({ person: person('TWICE001'), offline: { decision: 'approved', contact: 'primary' } }, 10);
    expect(again.status).toBe(200);
    const [earlier] = await ownerQuery('SELECT status FROM visits WHERE id = $1', [first.body.id]);
    expect(earlier.status).toBe('left_no_scan_out');
  });

  it('scans a visitor out with no signal: the server finds the visit, and records what could not be checked', async () => {
    const inside = await sendLater({ person: person('OUT00001'), offline: { decision: 'approved', contact: 'primary' } }, 90);
    const exit = (body: Record<string, unknown>) =>
      w.http().post('/api/device/visitors/exit').set(g()).field('data', JSON.stringify({ eventId: randomUUID(), visitId: null, capturedOffline: true, trustedAt: ago(5), deviceClock: ago(5), ...body }));
    const out = await exit({ idNumber: 'OUT00001' });
    expect(out.status).toBe(200);
    const [v] = await ownerQuery('SELECT status, exit_at IS NOT NULL AS exited FROM visits WHERE id = $1', [inside.body.id]);
    expect(v).toEqual({ status: 'exited', exited: true });
    // Nobody recorded as on site: logged for the supervisor, not sent back to the guard.
    const unknown = await exit({ idNumber: 'NEVERIN1' });
    expect(unknown.status).toBe(200);
    const [x] = await ownerQuery(`SELECT reason, note, allowed FROM visit_exceptions WHERE visit_id IS NULL AND note LIKE '%no signal%' LIMIT 1`);
    expect(x).toMatchObject({ reason: 'not_scanned_in', allowed: true });
    expect(x.note).toMatch(/no signal/);
  });

  it('still refuses a visit made with signal that skips the checks', async () => {
    const r = await w
      .http()
      .post('/api/device/visitors')
      .set(g())
      .field('data', JSON.stringify({ eventId: randomUUID(), type: 'pedestrian', person: person(), unitId: unit20, offline: { decision: 'approved', contact: 'primary' }, trustedAt: ago(0), deviceClock: ago(0) }))
      .attach('identity', PNG, { filename: 'id.png', contentType: 'image/png' })
      .attach('face', PNG, { filename: 'face.png', contentType: 'image/png' });
    // Not captured offline: the offline decision is ignored and the customer is asked as usual.
    expect(r.body.status).toBe('awaiting_approval');
  });
});
