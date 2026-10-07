import { randomUUID } from 'node:crypto';
import { DEFAULT_VISITOR_SETTINGS } from '@onpar/rules';
import { NotificationsService, PushResult, PushSender } from '../src/notifications/notifications.service';
import { enrol, enrolmentData, ownerQuery, PNG, setupWorld, World } from './helpers';

class QuietSender implements PushSender {
  async send(): Promise<PushResult> {
    return { ok: true };
  }
}

/** Visitor management, step 5 (plan approved 7 Oct 2026): scanning a visitor out, exceptions, and a visitor already on site. */
describe('visitor management: leaving and exceptions', () => {
  let w: World;
  let admin: string;
  let supervisor: string;
  let bAdmin: string;
  let deviceToken: string;
  let guard: { token: string };
  let onceOff: string;
  let unit14: string;
  let thabo: { id: string; token: string };
  let lerato: { id: string; token: string };
  let seq = 0;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const g = () => ({ 'X-Device-Token': deviceToken, Authorization: `Bearer ${guard.token}` });
  const site = () => `/api/sites/${w.a.siteId}`;
  const now = () => new Date().toISOString();
  const send = (data: Record<string, unknown>, photos: string[]) => {
    let r = w.http().post('/api/device/visitors').set(g()).field('data', JSON.stringify({ eventId: randomUUID(), categoryId: onceOff, unitId: unit14, trustedAt: now(), deviceClock: now(), ...data }));
    for (const p of photos) r = r.attach(p, PNG, { filename: `${p}.png`, contentType: 'image/png' });
    return r;
  };
  /** A new visitor let in by the tenant: a driver with two passengers, or someone on foot. */
  const letIn = async (onFoot = false, data: Record<string, unknown> = {}) => {
    seq += 1;
    const idNumber = `P${String(seq).padStart(8, '0')}`;
    const registration = `CA77${seq}`;
    const person = { idNumber, surname: `Visitor${seq}`, names: 'T', document: 'id_card', method: 'scan' };
    const vehicle = { registration, make: 'Toyota', model: 'Corolla', colour: 'White', vin: '', discExpiry: null, method: 'scan' };
    const res = await send(onFoot ? { type: 'pedestrian', person, ...data } : { type: 'vehicle', person, vehicle, pax: 2, ...data }, onFoot ? ['face'] : []);
    if (res.status !== 200) throw new Error(`arrive failed: ${res.status} ${JSON.stringify(res.body)}`);
    const id = res.body.id as string;
    await w.http().post(`/api/customer/visits/${id}/decide`).set(auth(thabo.token)).send({ decision: 'accept' });
    return { id, idNumber, registration, person, vehicle };
  };
  const find = (body: Record<string, unknown>) => w.http().post('/api/device/visitors/exit/find').set(g()).send(body);
  const leave = (data: Record<string, unknown>, photo = false) => {
    let r = w.http().post('/api/device/visitors/exit').set(g()).field('data', JSON.stringify({ eventId: randomUUID(), trustedAt: now(), deviceClock: now(), ...data }));
    if (photo) r = r.attach('photo', PNG, { filename: 'photo.png', contentType: 'image/png' });
    return r;
  };
  const visitRow = async (id: string) => (await ownerQuery('SELECT status, pax_out, exit_at, exit_guard, exit_person_check FROM visits WHERE id = $1', [id]))[0];
  const exceptionsOf = (id: string) => ownerQuery('SELECT type, reason, note, allowed, pax_out, photo_key IS NOT NULL AS photo FROM visit_exceptions WHERE visit_id = $1 ORDER BY type', [id]);
  const alertKinds = async (who: { token: string }, entityId: string) => {
    await w.app.get(NotificationsService).settled();
    return ((await w.http().get('/api/notifications').set(auth(who.token))).body.alerts as { kind: string; url: string }[]).filter((a) => a.url.endsWith(entityId)).map((a) => a.kind);
  };
  const customer = async (body: Record<string, unknown>) => {
    const r = await w.http().post(`${site()}/customers`).set(auth(admin)).send(body);
    await ownerQuery('UPDATE customers SET must_change_password = false WHERE id = $1', [r.body.id]);
    return { id: r.body.id as string, token: await w.login(body.email as string, r.body.temporaryPassword) };
  };
  const saveSettings = (checks: Record<string, boolean>) =>
    w.http().put(`${site()}/visitor-settings`).set(auth(admin)).send({ ...DEFAULT_VISITOR_SETTINGS, checks: { ...DEFAULT_VISITOR_SETTINGS.checks, ...checks } });
  const staffExceptions = async (token = supervisor) => (await w.http().get(`${site()}/visit-exceptions`).set(auth(token))).body;

  beforeAll(async () => {
    w = await setupWorld();
    w.app.get(NotificationsService).sender = new QuietSender();
    admin = await w.login('admin@a.test');
    supervisor = await w.login('supervisor@a.test');
    bAdmin = await w.login('admin@b.test');
    const d = await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Gate phone', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Main gate' });
    deviceToken = d.body.deviceToken;
    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    guard = { token: (await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: o.body.officer.employeeNumber, pin: o.body.initialPin })).body.token };
    const gateId = (await w.http().post(`${site()}/gates`).set(auth(admin)).send({ name: 'Main gate' })).body.id;
    await w.http().put(`${site()}/gate-phones/${d.body.device.id}`).set(auth(admin)).send({ gateId });
    unit14 = (await w.http().post(`${site()}/units`).set(auth(admin)).send({ name: '14' })).body.id;
    onceOff = (await w.http().get(`${site()}/visitor-setup`).set(auth(admin))).body.categories[0].id;
    thabo = await customer({ kind: 'tenant', fullName: 'Thabo Tenant', email: 'thabo@home.test', unitId: unit14, phone: '082 555 0140' });
    lerato = await customer({ kind: 'tenant', fullName: 'Lerato Molefe', email: 'lerato@home.test', unitId: unit14, phone: '084 555 0141' });
  });
  afterAll(() => w.app.close());

  it('finds the open visit from the licence disc and shows the entry record', async () => {
    const v = await letIn();
    const r = await find({ registration: v.registration.toLowerCase() });
    expect(r.status).toBe(200);
    expect(r.body.visit).toMatchObject({ id: v.id, type: 'vehicle', visitor: `Visitor${seq}, T`, vehicle: `${v.registration} White Toyota Corolla`, visiting: 'Unit 14', paxIn: 2, hasFace: false });
    // The driver's licence cannot be read by the phone: the guard is asked to compare the driver himself.
    expect(r.body).toMatchObject({ askDriver: true, askPax: true, exceptions: [] });
    // With the driver's ID scanned as well there is nothing to ask.
    expect((await find({ registration: v.registration, idNumber: v.idNumber })).body.askDriver).toBe(false);
    expect((await find({})).status).toBe(400);
  });

  it('closes the visit with an exit time when everything matches, and tells the unit', async () => {
    const v = await letIn();
    expect((await leave({ visitId: v.id, registration: v.registration, paxOut: 2 })).status).toBe(400); // same driver not answered
    expect((await leave({ visitId: v.id, registration: v.registration, sameDriver: true })).status).toBe(400); // passengers not given
    const eventId = randomUUID();
    const r = await leave({ eventId, visitId: v.id, registration: v.registration, sameDriver: true, paxOut: 2 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'exited', message: 'Scanned out. The visit is closed.' });
    const row = await visitRow(v.id);
    expect(row).toMatchObject({ status: 'exited', pax_out: 2, exit_person_check: 'guard' });
    expect(row.exit_at).toBeTruthy();
    expect(row.exit_guard).toBeTruthy();
    expect(await exceptionsOf(v.id)).toEqual([]);
    // Sent twice: saved once, same answer.
    expect((await leave({ eventId, visitId: v.id, registration: v.registration, sameDriver: true, paxOut: 2 })).body.status).toBe('exited');
    expect(await alertKinds(thabo, v.id)).toContain('visitor_left');
    expect(await alertKinds(lerato, v.id)).toContain('visitor_left');
    // Gone: a second scan finds nobody on site.
    expect((await find({ registration: v.registration })).body.visit).toBeNull();
    const audit = await ownerQuery(`SELECT after FROM audit_log WHERE action = 'visit.exit' AND entity_id = $1`, [v.id]);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].after)).not.toContain(v.registration);
  });

  it('lets a customer switch off "your visitor has left" for themselves', async () => {
    expect((await w.http().get('/api/customer/me').set(auth(lerato.token))).body.muteExitAlerts).toBe(false);
    expect((await w.http().put('/api/customer/visitor-alerts').set(auth(lerato.token)).send({ muteExit: true })).status).toBe(200);
    const v = await letIn(true);
    expect((await leave({ visitId: v.id, idNumber: v.idNumber })).body.status).toBe('exited');
    expect(await alertKinds(thabo, v.id)).toContain('visitor_left');
    expect(await alertKinds(lerato, v.id)).not.toContain('visitor_left');
    expect((await visitRow(v.id)).exit_person_check).toBe('scan');
  });

  it('shows the guard the entry face photo of a visitor on foot, and records the look', async () => {
    const v = await letIn(true);
    expect((await find({ idNumber: v.idNumber })).body).toMatchObject({ visit: { id: v.id, type: 'pedestrian', vehicle: null, hasFace: true }, askDriver: false, askPax: false, exceptions: [] });
    const photo = await w.http().get(`/api/device/visitors/${v.id}/face`).set(g());
    expect(photo.status).toBe(200);
    expect(photo.headers['content-type']).toBe('image/png');
    expect(await ownerQuery(`SELECT 1 AS x FROM audit_log WHERE action = 'visit.face_view' AND entity_id = $1 AND actor_type = 'employee'`, [v.id])).toHaveLength(1);
    await leave({ visitId: v.id, idNumber: v.idNumber });
    expect((await w.http().get(`/api/device/visitors/${v.id}/face`).set(g())).status).toBe(404);
  });

  it('raises a passenger exception: the guard must give a reason and decide, and everyone is told', async () => {
    const v = await letIn();
    const first = await leave({ visitId: v.id, registration: v.registration, sameDriver: true, paxOut: 1 });
    expect(first.status).toBe(422);
    expect(first.body.exceptions).toEqual([{ type: 'pax_mismatch', label: 'Passenger count differs', text: 'The number of passengers leaving is not the number that came in.' }]);
    // The phone asks first what the exit would raise, with the guard's answers.
    expect((await find({ registration: v.registration, sameDriver: true, paxOut: 1 })).body.exceptions.map((x: { type: string }) => x.type)).toEqual(['pax_mismatch']);
    expect((await find({ registration: v.registration, sameDriver: false, paxOut: 2 })).body.exceptions.map((x: { type: string }) => x.type)).toEqual(['driver_mismatch']);
    expect(first.body.reasons.map((x: { id: string }) => x.id)).toContain('passengers_stayed');
    expect((await visitRow(v.id)).status).toBe('on_site');
    const noReason = await leave({ visitId: v.id, registration: v.registration, sameDriver: true, paxOut: 1, handling: { reason: null, note: '', allowed: true } });
    expect(noReason.status).toBe(400);
    expect(noReason.body.message).toBe('Choose a reason or type a note before you continue.');
    const r = await leave({ visitId: v.id, registration: v.registration, sameDriver: true, paxOut: 1, handling: { reason: 'passengers_stayed', note: '', allowed: true } }, true);
    expect(r.body.status).toBe('exited_exception');
    expect(await visitRow(v.id)).toMatchObject({ status: 'exited_exception', pax_out: 1 });
    expect(await exceptionsOf(v.id)).toEqual([{ type: 'pax_mismatch', reason: 'passengers_stayed', note: '', allowed: true, pax_out: 1, photo: true }]);
    expect(await alertKinds(thabo, v.id)).toContain('visitor_exit_exception');
    // An exception is never muted.
    expect(await alertKinds(lerato, v.id)).toContain('visitor_exit_exception');
    await w.app.get(NotificationsService).settled();
    const staff = (await w.http().get('/api/notifications').set(auth(supervisor))).body.alerts as { kind: string; body: string }[];
    expect(staff.find((a) => a.kind === 'visitor_exception')?.body).toMatch(/Passenger count differs at Main gate, Visitor\d+, T leaving unit 14\. The guard let them go\./);
    const [audit] = await ownerQuery(`SELECT after FROM audit_log WHERE action = 'visit.exit_exception' AND entity_id = $1`, [v.id]);
    expect(audit.after).toMatchObject({ exceptions: ['pax_mismatch'], reason: 'passengers_stayed', allowed: true, paxIn: 2, paxOut: 1 });
  });

  it('raises a different driver, and keeps the visitor on site when the guard does not let them go', async () => {
    const v = await letIn();
    // Confirmed by the guard, with the wrong passenger count too.
    const r = await leave({ visitId: v.id, registration: v.registration, sameDriver: false, paxOut: 0, handling: { reason: null, note: 'Different man driving, could not explain.', allowed: false } });
    expect(r.body).toEqual({ status: 'held', message: 'Exception recorded. The visitor is still on site. Your supervisor and the customer have been told.' });
    expect(await visitRow(v.id)).toMatchObject({ status: 'on_site', exit_at: null });
    expect((await exceptionsOf(v.id)).map((x) => [x.type, x.allowed])).toEqual([['driver_mismatch', false], ['pax_mismatch', false]]);
    // A scanned ID of somebody else is a different driver without asking the guard.
    const other = await letIn(true);
    expect((await find({ registration: v.registration, idNumber: other.idNumber })).body.exceptions.map((x: { type: string }) => x.type)).toEqual(['driver_mismatch']);
    // The same vehicle can still be scanned out properly afterwards.
    expect((await leave({ visitId: v.id, registration: v.registration, sameDriver: true, paxOut: 2 })).body.status).toBe('exited');
  });

  it('raises a different vehicle when a driver leaves on foot, or a walker leaves in a vehicle', async () => {
    const v = await letIn();
    const found = await find({ idNumber: v.idNumber });
    expect(found.body).toMatchObject({ visit: { id: v.id }, askDriver: false, askPax: false });
    expect(found.body.exceptions.map((x: { type: string }) => x.type)).toEqual(['vehicle_mismatch']);
    expect((await leave({ visitId: v.id, idNumber: v.idNumber, handling: { reason: 'vehicle_stayed', note: '', allowed: true } })).body.status).toBe('exited_exception');
    expect((await exceptionsOf(v.id)).map((x) => x.type)).toEqual(['vehicle_mismatch']);
    const walker = await letIn(true);
    expect((await find({ idNumber: walker.idNumber, registration: 'ZZ 999 GP' })).body.exceptions.map((x: { type: string }) => x.type)).toEqual(['vehicle_mismatch']);
  });

  it('records a scan that matches nobody on site, without keeping an unknown ID number', async () => {
    const r = await find({ idNumber: 'X99999999', registration: 'ND 404' });
    expect(r.body).toMatchObject({ visit: null, exceptions: [{ type: 'no_open_visit' }] });
    expect((await leave({ idNumber: 'X99999999', registration: 'ND 404' })).status).toBe(422);
    const eventId = randomUUID();
    const done = await leave({ eventId, idNumber: 'X99999999', registration: 'ND 404', handling: { reason: 'not_scanned_in', note: '', allowed: true } });
    expect(done.body.status).toBe('logged');
    expect((await leave({ eventId, idNumber: 'X99999999', registration: 'ND 404', handling: { reason: 'not_scanned_in', note: '', allowed: true } })).body.status).toBe('logged');
    const rows = await ownerQuery(`SELECT x.type, x.visit_id, x.person_id, ve.registration FROM visit_exceptions x LEFT JOIN visitor_vehicles ve ON ve.id = x.vehicle_id WHERE x.event_id = $1`, [eventId]);
    expect(rows).toEqual([{ type: 'no_open_visit', visit_id: null, person_id: null, registration: 'ND404' }]);
    expect(await ownerQuery(`SELECT 1 AS x FROM visitor_people WHERE id_number = 'X99999999'`)).toEqual([]);
  });

  it('does not raise what the site has switched off', async () => {
    await saveSettings({ exitMatch: false, paxCount: false });
    const v = await letIn(false, { pax: null });
    expect((await find({ registration: v.registration })).body).toMatchObject({ askDriver: false, askPax: false, exceptions: [] });
    expect((await leave({ visitId: v.id, registration: v.registration })).body.status).toBe('exited');
    await saveSettings({});
  });

  it('refuses an exit for a visit that is not the one on site, and one from another site’s phone', async () => {
    const v = await letIn();
    expect((await leave({ visitId: randomUUID(), registration: v.registration, sameDriver: true, paxOut: 2 })).status).toBe(409);
    expect((await leave({ registration: v.registration, sameDriver: true, paxOut: 2 })).status).toBe(409);
    expect((await w.http().post('/api/device/visitors/exit/find').send({ registration: v.registration })).status).toBe(401);
    await leave({ visitId: v.id, registration: v.registration, sameDriver: true, paxOut: 2 });
  });

  describe('a visitor scanned in while still recorded as on site (owner, 7 Oct 2026: warn and let the guard decide)', () => {
    it('warns the guard, wants a reason, then closes the earlier visit as left without scan-out', async () => {
      const v = await letIn();
      const again = { type: 'vehicle', person: v.person, vehicle: v.vehicle, pax: 0 };
      const c = await w.http().post('/api/device/visitors/check').set(g()).send({ idNumber: v.idNumber, registration: v.registration });
      expect(c.body.onSite).toHaveLength(1);
      expect(c.body.onSite[0]).toMatchObject({ what: 'vehicle', visitor: `Visitor${seq}, T`, visiting: 'Unit 14', gateName: 'Main gate' });
      const stopped = await send(again, []);
      expect(stopped.status).toBe(422);
      expect(stopped.body).toMatchObject({ onSite: true, message: 'This visitor is still recorded as on site from an earlier visit. Give a reason before you continue.' });
      expect((await send({ ...again, onSite: { reason: 'other', note: '' } }, [])).status).toBe(400);
      expect((await visitRow(v.id)).status).toBe('on_site');
      const ok = await send({ ...again, onSite: { reason: 'not_scanned_out', note: '' } }, []);
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('awaiting_approval');
      expect(await visitRow(v.id)).toMatchObject({ status: 'left_no_scan_out', exit_at: null });
      expect(await exceptionsOf(v.id)).toEqual([{ type: 'no_scan_out', reason: 'not_scanned_out', note: '', allowed: true, pax_out: null, photo: false }]);
      const [n] = await ownerQuery(`SELECT checks FROM visits WHERE id = $1`, [ok.body.id]);
      expect(n.checks.alreadyOnSite).toEqual([v.id]);
      // Scanned again while that one is waiting for an answer: the guard gets the waiting visit back, not a third one.
      const third = await send(again, []);
      expect(third.body).toMatchObject({ id: ok.body.id, status: 'awaiting_approval' });
    });
  });

  describe('the supervisor’s list', () => {
    it('lists open exceptions with what the guard recorded, never an ID number', async () => {
      const list = await staffExceptions();
      expect(list.open.length).toBeGreaterThanOrEqual(6);
      const pax = list.open.find((x: { type: string; allowed: boolean }) => x.type === 'pax_mismatch' && x.allowed);
      expect(pax).toMatchObject({ typeLabel: 'Passenger count differs', gateName: 'Main gate', reason: 'Passengers stayed behind', paxOut: 1, hasPhoto: true, clearedAt: null });
      expect(pax.visit).toMatchObject({ visiting: 'Unit 14', paxIn: 2 });
      expect(JSON.stringify(list)).not.toMatch(/P0000|X99999999/);
      expect((await w.http().get(`${site()}/visit-exceptions`).set(auth(bAdmin))).status).toBe(404);
    });

    it('lets the supervisor clear one with a note, once', async () => {
      const { open } = await staffExceptions();
      const id = open[0].id;
      const clear = (token: string, note: string) => w.http().post(`${site()}/visit-exceptions/${id}/clear`).set(auth(token)).send({ note });
      expect((await clear(supervisor, '')).status).toBe(400);
      expect((await clear(bAdmin, 'Checked.')).status).toBe(404);
      expect((await clear(supervisor, 'Spoke to the tenant: all in order.')).status).toBe(200);
      expect((await clear(admin, 'Again.')).status).toBe(409);
      const after = await staffExceptions();
      expect(after.open.map((x: { id: string }) => x.id)).not.toContain(id);
      expect(after.cleared[0]).toMatchObject({ id, clearNote: 'Spoke to the tenant: all in order.' });
      expect(after.cleared[0].clearedBy).toBeTruthy();
      expect(await ownerQuery(`SELECT 1 AS x FROM audit_log WHERE action = 'visit_exception.clear' AND entity_id = $1`, [id])).toHaveLength(1);
    });

    it('keeps what was raised: an exception cannot be rewritten or deleted', async () => {
      const [x] = await ownerQuery('SELECT id, company_id FROM visit_exceptions LIMIT 1');
      const { DbService } = await import('../src/db/db.service');
      const db = w.app.get(DbService);
      await expect(db.withTenant(x.company_id, (tx) => tx.query(`UPDATE visit_exceptions SET note = 'changed' WHERE id = $1`, [x.id]))).rejects.toThrow(/permission denied/);
      await expect(db.withTenant(x.company_id, (tx) => tx.query(`DELETE FROM visit_exceptions WHERE id = $1`, [x.id]))).rejects.toThrow(/permission denied/);
    });
  });
});
