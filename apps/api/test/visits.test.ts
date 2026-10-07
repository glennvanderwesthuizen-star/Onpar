import { randomUUID } from 'node:crypto';
import { DEFAULT_VISITOR_SETTINGS } from '@onpar/rules';
import { NotificationsService, PushResult, PushSender } from '../src/notifications/notifications.service';
import { enrol, enrolmentData, ownerQuery, PNG, setupWorld, World } from './helpers';

class QuietSender implements PushSender {
  async send(): Promise<PushResult> {
    return { ok: true };
  }
}

/** Visitor management, step 2 (plan approved 7 Oct 2026): scanning a visitor in at a gate. */
describe('visitor management: scanning a visitor in at the gate', () => {
  let w: World;
  let admin: string;
  let supervisor: string;
  let bAdmin: string;
  let deviceToken: string;
  let deviceId: string;
  let guard: { token: string };
  let gateId: string;
  let unit14: string;
  let onceOff: string;
  let contractor: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const g = () => ({ 'X-Device-Token': deviceToken, Authorization: `Bearer ${guard.token}` });
  const site = () => `/api/sites/${w.a.siteId}`;
  const now = () => new Date().toISOString();
  const driver = { idNumber: '900101 5009 086', surname: 'Dlamini', names: 'T J', document: 'drivers_licence', method: 'manual' };
  const car = { registration: 'ca 123-456', make: 'Toyota', model: 'Corolla', colour: 'White', vin: 'ahtzz1234567890ab', discExpiry: '2027-03-31', method: 'scan' };
  /** A visit from the gate phone. `photos` are the files attached. */
  const visit = (data: Record<string, unknown>, photos: string[] = ['identity']) => {
    let r = w
      .http()
      .post('/api/device/visitors')
      .set(g())
      .field('data', JSON.stringify({ eventId: randomUUID(), type: 'vehicle', person: driver, vehicle: car, pax: 1, categoryId: onceOff, unitId: unit14, trustedAt: now(), deviceClock: now(), ...data }));
    for (const p of photos) r = r.attach(p, PNG, { filename: `${p}.png`, contentType: 'image/png' });
    return r;
  };
  const check = (body: Record<string, unknown>) => w.http().post('/api/device/visitors/check').set(g()).send(body);
  const saveSettings = (checks: Record<string, boolean>) =>
    w.http().put(`${site()}/visitor-settings`).set(auth(admin)).send({ ...DEFAULT_VISITOR_SETTINGS, checks: { ...DEFAULT_VISITOR_SETTINGS.checks, ...checks } });

  beforeAll(async () => {
    w = await setupWorld();
    w.app.get(NotificationsService).sender = new QuietSender();
    admin = await w.login('admin@a.test');
    supervisor = await w.login('supervisor@a.test');
    bAdmin = await w.login('admin@b.test');
    const d = await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Gate phone', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Main gate' });
    deviceToken = d.body.deviceToken;
    deviceId = d.body.device.id;
    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    guard = { token: (await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: o.body.officer.employeeNumber, pin: o.body.initialPin })).body.token };
    unit14 = (await w.http().post(`${site()}/units`).set(auth(admin)).send({ name: '14' })).body.id;
    const setup = (await w.http().get(`${site()}/visitor-setup`).set(auth(admin))).body;
    onceOff = setup.categories.find((c: { name: string }) => c.name === 'Once-off visitor').id;
    contractor = setup.categories.find((c: { name: string }) => c.name === 'Contractor, once-off').id;
  });
  afterAll(() => w.app.close());

  it('does nothing on a phone that is not at a gate', async () => {
    const s = await w.http().get('/api/device/visitors/setup').set(g());
    expect(s.body.gate).toBeNull();
    expect(s.body.message).toMatch(/not set up as a gate phone/);
    expect((await visit({})).status).toBe(400);
    expect((await check({ registration: 'CA 1' })).status).toBe(400);
  });

  it('lets the administrator put a post phone at a gate of its own site', async () => {
    gateId = (await w.http().post(`${site()}/gates`).set(auth(admin)).send({ name: 'Main gate' })).body.id;
    const put = (token: string, gate: string | null) => w.http().put(`${site()}/gate-phones/${deviceId}`).set(auth(token)).send({ gateId: gate });
    expect((await put(supervisor, gateId)).status).toBe(403);
    expect((await put(bAdmin, gateId)).status).toBe(404);
    expect((await put(admin, randomUUID())).status).toBe(400);
    expect((await put(admin, gateId)).status).toBe(200);
    const phones = (await w.http().get(`${site()}/visitor-setup`).set(auth(admin))).body.phones;
    expect(phones).toEqual([{ id: deviceId, label: 'Gate phone', postName: 'Main gate', gateId }]);
    const s = (await w.http().get('/api/device/visitors/setup').set(g())).body;
    expect(s.gate).toEqual({ id: gateId, name: 'Main gate' });
    expect(s.checks.paxCount).toBe(true);
    expect(s.categories).toHaveLength(5);
    expect(s.units).toEqual([{ id: unit14, name: '14' }]);
    expect(s.hasClient).toBe(false);
    expect(s.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('saves a vehicle visitor as awaiting approval, keeping only the listed fields', async () => {
    const r = await visit({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'awaiting_approval', statusLabel: 'Awaiting approval', blocked: null });
    const [v] = await ownerQuery(
      `SELECT v.type, v.status, v.pax_in, v.capture_method, v.identity_method, v.disc_method, v.gate_id, v.unit_id, to_char(v.disc_expiry, 'YYYY-MM-DD') AS disc_expiry, v.face_photo_key,
              p.id_number, p.surname, p.names, ve.registration, ve.make, ve.vin
         FROM visits v JOIN visitor_people p ON p.id = v.person_id JOIN visitor_vehicles ve ON ve.id = v.vehicle_id WHERE v.id = $1`,
      [r.body.id],
    );
    expect(v).toEqual({
      type: 'vehicle', status: 'awaiting_approval', pax_in: 1, capture_method: 'manual', identity_method: 'manual', disc_method: 'scan', gate_id: gateId, unit_id: unit14,
      disc_expiry: '2027-03-31', face_photo_key: null, id_number: '9001015009086', surname: 'Dlamini', names: 'T J', registration: 'CA123456', make: 'Toyota', vin: 'AHTZZ1234567890AB',
    });
    // The typed licence has its photo; the scanned disc has none, even if one is sent.
    const sent = await visit({ person: { ...driver, idNumber: '9202025009081' } }, ['identity', 'disc']);
    const docs = await ownerQuery('SELECT visit_id, kind FROM visit_documents ORDER BY created_at');
    expect(docs).toEqual([{ visit_id: r.body.id, kind: 'identity' }, { visit_id: sent.body.id, kind: 'identity' }]);
  });

  it('saves a visit once when the phone sends it twice', async () => {
    const eventId = randomUUID();
    const first = await visit({ eventId, person: { ...driver, idNumber: '9303035009088' } });
    const again = await visit({ eventId, person: { ...driver, idNumber: '9303035009088' } });
    expect(again.body.id).toBe(first.body.id);
    const [{ n }] = await ownerQuery('SELECT count(*)::int AS n FROM visits WHERE event_id = $1', [eventId]);
    expect(n).toBe(1);
  });

  it('refuses a visit with pieces missing, saying what is missing', async () => {
    const errors = async (data: Record<string, unknown>, photos: string[] = ['identity']) => (await visit(data, photos)).body.errors;
    expect(await errors({ pax: null })).toEqual({ pax: 'Enter the number of passengers (0 if the driver is alone).' });
    expect(await errors({}, [])).toEqual({ identity: 'Photograph the document you typed the details from.' });
    expect(await errors({ vehicle: { ...car, method: 'manual' } })).toEqual({ disc: 'Photograph the licence disc you typed the details from.' });
    expect(await errors({ vehicle: null })).toEqual({ vehicle: 'Scan the licence disc, or type the vehicle’s details.' });
    expect(await errors({ categoryId: randomUUID() })).toEqual({ categoryId: 'Choose the kind of visitor.' });
    // No client has been added to this site, so "the office" is not a choice.
    expect(await errors({ unitId: null })).toEqual({ unitId: 'Choose who the visitor is here to see.' });
    expect(await errors({ type: 'pedestrian', vehicle: null, pax: null })).toEqual({ face: 'Take a photo of the visitor’s face.' });
    const other = (await ownerQuery(`INSERT INTO site_units (company_id, site_id, name) SELECT company_id, id, 'B1' FROM sites WHERE id = $1 RETURNING id`, [w.b.siteId]))[0].id;
    expect(await errors({ unitId: other })).toEqual({ unitId: 'Choose who the visitor is here to see.' });
  });

  it('saves a visitor on foot with a face photo and a scanned ID, and no document photo', async () => {
    const walker = { idNumber: '8505055009083', surname: 'Nkosi', names: 'Sipho Peter', document: 'id_card', method: 'scan' };
    const r = await visit({ type: 'pedestrian', vehicle: null, pax: null, person: walker, categoryId: contractor }, ['face']);
    expect(r.status).toBe(200);
    const [v] = await ownerQuery('SELECT type, capture_method, pax_in, face_photo_key IS NOT NULL AS face, vehicle_id, (SELECT count(*)::int FROM visit_documents d WHERE d.visit_id = v.id) AS docs FROM visits v WHERE id = $1', [r.body.id]);
    expect(v).toEqual({ type: 'pedestrian', capture_method: 'scan', pax_in: null, face: true, vehicle_id: null, docs: 0 });
    // With the check off, the photo is not needed.
    await saveSettings({ facePhoto: false, paxCount: false });
    expect((await visit({ type: 'pedestrian', vehicle: null, pax: null, person: { ...walker, idNumber: '8606065009080' } }, [])).status).toBe(200);
    expect((await visit({ pax: null, person: { ...driver, idNumber: '8707075009087' } })).status).toBe(200);
    await saveSettings({});
  });

  it('recognises a returning visitor and vehicle, at this site only', async () => {
    const r = await check({ idNumber: '9001015009086', registration: 'CA 123 456' });
    expect(r.status).toBe(200);
    expect(r.body.person).toMatchObject({ surname: 'Dlamini', names: 'T J' });
    expect(r.body.vehicle).toMatchObject({ make: 'Toyota', model: 'Corolla', colour: 'White' });
    expect(r.body.barred).toEqual([]);
    expect((await check({ idNumber: '7001015009085' })).body).toMatchObject({ person: null, vehicle: null, barred: [], expected: null, onSite: [] });
    const [a] = await ownerQuery(`SELECT actor_type, after FROM audit_log WHERE action = 'visitor.scan_check' ORDER BY id LIMIT 1`);
    expect(a.actor_type).toBe('employee');
    expect(a.after).toMatchObject({ checked: ['id_number', 'registration'], knownPerson: true, knownVehicle: true, barred: [] });
    expect(JSON.stringify(a.after)).not.toContain('9001015009086');
  });

  it('warns about an expired disc or licence only when the site does not accept them, and records that the guard went on', async () => {
    const old = { ...car, registration: 'CA 777', discExpiry: '2020-01-31' };
    expect((await visit({ vehicle: old, person: { ...driver, idNumber: '8808085009084' } })).status).toBe(200);
    await saveSettings({ expiredLicenceOk: false });
    const noDate = await visit({ vehicle: old });
    expect(noDate.body.errors).toEqual({ licenceExpiry: 'Enter the date the licence expires.' });
    const late = { ...driver, idNumber: '8111115009089' };
    const warned = await visit({ vehicle: old, person: late, licenceExpiry: '2019-06-30' });
    expect(warned.status).toBe(422);
    expect(warned.body.warnings).toEqual(['licence_expired', 'disc_expired']);
    const went = await visit({ vehicle: old, person: late, licenceExpiry: '2019-06-30', acknowledged: ['licence_expired', 'disc_expired'] });
    expect(went.status).toBe(200);
    const [v] = await ownerQuery('SELECT checks FROM visits WHERE id = $1', [went.body.id]);
    expect(v.checks.warnings).toEqual(['licence_expired', 'disc_expired']);
    await saveSettings({});
  });

  it('stops a barred number plate, saves the attempt as denied and alerts the supervisor', async () => {
    await w.http().post(`${site()}/barred`).set(auth(admin)).send({ kind: 'registration', value: 'ND 999 000', reason: 'Theft, case opened' });
    expect((await check({ registration: 'nd999-000' })).body.barred).toEqual([{ kind: 'registration', kindLabel: 'Number plate', from: 'site' }]);
    const r = await visit({ vehicle: { ...car, registration: 'ND 999 000' }, person: { ...driver, idNumber: '8909095009081' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'denied', blocked: 'This visitor is on the barred list. Do not let them in. Your supervisor has been told.' });
    const [v] = await ownerQuery('SELECT status, denied_reason, checks FROM visits WHERE id = $1', [r.body.id]);
    expect(v).toMatchObject({ status: 'denied', denied_reason: 'barred' });
    expect(v.checks.barred).toHaveLength(1);
    const alerts = (await w.http().get('/api/notifications').set(auth(supervisor))).body.alerts;
    expect(alerts[0]).toMatchObject({ kind: 'visitor_barred', kindLabel: 'Barred visitor', title: 'Barred visitor at Estate ABC' });
    expect(alerts[0].body).not.toMatch(/ND999000|Dlamini/);
    // A unit's own entry stops a visitor to that unit only; with the check off, nothing is stopped.
    await w.http().post(`${site()}/barred`).set(auth(admin)).send({ kind: 'id_number', value: '9404045009085', unitId: unit14, reason: 'Unit 14 asked' });
    const unit9 = (await w.http().post(`${site()}/units`).set(auth(admin)).send({ name: '9' })).body.id;
    const person = { ...driver, idNumber: '9404045009085' };
    expect((await visit({ person, unitId: unit9 })).body.status).toBe('awaiting_approval');
    expect((await visit({ person })).body.status).toBe('denied');
    await saveSettings({ barredList: false });
    expect((await visit({ person })).body.status).toBe('awaiting_approval');
    await saveSettings({});
  });

  it('shows the gate today’s visitors, and staff the site’s visitors with ID numbers masked', async () => {
    const recent = (await w.http().get('/api/device/visitors/recent').set(g())).body;
    expect(recent.length).toBeGreaterThan(8);
    expect(recent[0]).toMatchObject({ surname: 'Dlamini', statusLabel: 'Awaiting approval', unitName: '14', gateName: 'Main gate' });
    expect(JSON.stringify(recent)).not.toContain('9404045009085');
    const list = await w.http().get(`${site()}/visits`).set(auth(supervisor));
    expect(list.status).toBe(200);
    expect(list.body[0]).toMatchObject({ surname: 'Dlamini', idNumber: '•••••••••9085', guard: 'John Smith', captureMethod: 'manual', documentLabel: 'Driver’s licence' });
    expect(JSON.stringify(list.body)).not.toContain('9404045009085');
    expect((await w.http().get(`${site()}/visits`).set(auth(bAdmin))).status).toBe(404);
    expect((await w.http().get(`/api/sites/${w.b.siteId}/visits`).set(auth(bAdmin))).body).toEqual([]);
    expect((await w.http().get(`${site()}/visits`)).status).toBe(401);
  });

  it('records each visit in the audit trail without the visitor’s numbers', async () => {
    const [a] = await ownerQuery(`SELECT actor_type, actor_label, after FROM audit_log WHERE action = 'visit.create' ORDER BY id LIMIT 1`);
    expect(a).toMatchObject({ actor_type: 'employee', actor_label: 'John Smith' });
    expect(a.after).toMatchObject({ gateId, type: 'vehicle', status: 'awaiting_approval', captureMethod: 'manual', pax: 1 });
    const all = await ownerQuery(`SELECT after::text AS t FROM audit_log WHERE action IN ('visit.create', 'visitor.scan_check')`);
    for (const row of all) expect(row.t).not.toMatch(/9001015009086|CA123456|Dlamini/);
  });

  it('frees a phone when its gate is retired', async () => {
    await w.http().put(`${site()}/gates/${gateId}`).set(auth(admin)).send({ name: 'Main gate', active: false });
    expect((await w.http().get('/api/device/visitors/setup').set(g())).body.gate).toBeNull();
    const [d] = await ownerQuery('SELECT gate_id FROM devices WHERE id = $1', [deviceId]);
    expect(d.gate_id).toBeNull();
  });
});
