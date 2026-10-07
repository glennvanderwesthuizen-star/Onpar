import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_VISITOR_SETTINGS } from '@onpar/rules';
import { NotificationsService, PushResult, PushSender } from '../src/notifications/notifications.service';
import { enrol, enrolmentData, ownerQuery, setupWorld, World } from './helpers';

class QuietSender implements PushSender {
  async send(): Promise<PushResult> {
    return { ok: true };
  }
}
const photo = (name: string) => readFileSync(join(__dirname, 'fixtures', 'faces', name));

/** Staff of a unit (owner, 7 Oct 2026; D-47): cleaners, gardeners and others who work for a tenant. */
describe('visitor management: staff of a unit', () => {
  jest.setTimeout(120_000);
  let w: World;
  let admin: string;
  let supervisor: string;
  let bAdmin: string;
  let deviceToken: string;
  let guard: { token: string };
  let unit14: string;
  let unit20: string;
  let thabo: { id: string; token: string };
  let nomsa: { id: string; token: string };
  let graceId: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const g = () => ({ 'X-Device-Token': deviceToken, Authorization: `Bearer ${guard.token}` });
  const site = () => `/api/sites/${w.a.siteId}`;
  const now = () => new Date().toISOString();
  const find = async (code: string) => (await w.http().post('/api/device/staff/find').set(g()).send({ code })).body.staff as Record<string, any>[];
  const enter = (id: string, data: Record<string, unknown>, face: string | null = 'person-a.jpg', identity = false) => {
    let r = w.http().post(`/api/device/staff/${id}/enter`).set(g()).field('data', JSON.stringify({ eventId: randomUUID(), trustedAt: now(), deviceClock: now(), ...data }));
    if (face) r = r.attach('face', photo(face), { filename: 'face.jpg', contentType: 'image/jpeg' });
    if (identity) r = r.attach('identity', photo('person-a.jpg'), { filename: 'id.jpg', contentType: 'image/jpeg' });
    return r;
  };
  const leave = (id: string, eventId = randomUUID()) => w.http().post(`/api/device/staff/${id}/leave`).set(g()).send({ eventId, trustedAt: now(), deviceClock: now() });
  const alertsOf = async (token: string) => {
    await w.app.get(NotificationsService).settled();
    return (await w.http().get('/api/notifications').set(auth(token))).body.alerts as { kind: string; title: string; body: string }[];
  };
  const customer = async (body: Record<string, unknown>) => {
    const r = await w.http().post(`${site()}/customers`).set(auth(admin)).send(body);
    await ownerQuery('UPDATE customers SET must_change_password = false WHERE id = $1', [r.body.id]);
    return { id: r.body.id as string, token: await w.login(body.email as string, r.body.temporaryPassword) };
  };
  const faceCheck = (on: boolean) => w.http().put(`${site()}/visitor-settings`).set(auth(admin)).send({ ...DEFAULT_VISITOR_SETTINGS, checks: { ...DEFAULT_VISITOR_SETTINGS.checks, staffFaceMatch: on } });
  const idCard = { idNumber: '850101 5009 087', surname: 'Mokoena', names: 'Grace', document: 'id_card', method: 'scan' };

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
    unit20 = (await w.http().post(`${site()}/units`).set(auth(admin)).send({ name: '20' })).body.id;
    thabo = await customer({ kind: 'tenant', fullName: 'Thabo Tenant', email: 'thabo@home.test', unitId: unit14, phone: '082 555 0140' });
    nomsa = await customer({ kind: 'tenant', fullName: 'Nomsa Other', email: 'nomsa@home.test', unitId: unit20 });
    // Automatic photo matching starts on (owner, 7 Oct 2026). It is switched off here so the guard's own decisions are tested first.
    expect((await w.http().get(`${site()}/visitor-setup`).set(auth(admin))).body.settings.checks.staffFaceMatch).toBe(true);
    await faceCheck(false);
  });
  afterAll(() => w.app.close());

  it('lets a tenant register the people who work for their own unit', async () => {
    const add = (who: { token: string }, body: Record<string, unknown>) => w.http().post('/api/customer/staff').set(auth(who.token)).send(body);
    expect((await add(thabo, { fullName: 'G', cell: '555 0147' })).body.errors).toEqual({ fullName: 'Enter their name.', cell: 'Enter their full cell number. They give its last six digits at the gate.' });
    const made = await add(thabo, { fullName: 'Grace Mokoena', cell: '+27 82 555 0147', days: [1, 2, 3, 4, 5, 6, 7] });
    expect(made.status).toBe(201);
    graceId = made.body.id;
    expect((await add(thabo, { fullName: 'Grace again', cell: '082 555 0147' })).status).toBe(409);
    const mine = (await w.http().get('/api/customer/staff').set(auth(thabo.token))).body;
    expect(mine).toEqual([{ id: graceId, fullName: 'Grace Mokoena', visiting: 'Unit 14', cell: '0825550147', code: '550147', vehicle: null, when: 'Every day, any time', enrolled: false, ended: false, onSite: false, lastIn: null, lastOut: null }]);
    // Another unit sees and removes nothing of it.
    expect((await w.http().get('/api/customer/staff').set(auth(nomsa.token))).body).toEqual([]);
    expect((await w.http().post(`/api/customer/staff/${graceId}/remove`).set(auth(nomsa.token))).status).toBe(404);
    const [a] = await ownerQuery(`SELECT actor_type, after FROM audit_log WHERE action = 'unit_staff.add'`);
    expect(a.actor_type).toBe('customer');
    expect(JSON.stringify(a.after)).not.toMatch(/0147/);
  });

  it('lets only the administrator register staff for a unit on the website', async () => {
    const body = { fullName: 'Sam Gardener', cell: '083 555 0147', unitId: unit20, hoursFrom: '00:00', hoursTo: '00:01' };
    expect((await w.http().post(`${site()}/unit-staff`).set(auth(supervisor)).send(body)).status).toBe(403);
    expect((await w.http().post(`${site()}/unit-staff`).set(auth(bAdmin)).send(body)).status).toBe(404);
    expect((await w.http().post(`${site()}/unit-staff`).set(auth(admin)).send({ ...body, unitId: randomUUID() })).status).toBe(400);
    expect((await w.http().post(`${site()}/unit-staff`).set(auth(admin)).send(body)).status).toBe(201);
    const list = (await w.http().get(`${site()}/unit-staff`).set(auth(supervisor))).body;
    expect(list.map((s: { fullName: string; visiting: string }) => [s.fullName, s.visiting])).toEqual([['Grace Mokoena', 'Unit 14'], ['Sam Gardener', 'Unit 20']]);
  });

  it('finds staff at the gate by the last six digits of their cell number, and says who is not due', async () => {
    // Two people on the site share the same last six digits: the guard picks.
    const both = await find('55 0147');
    expect(both.map((s) => [s.fullName, s.visiting, s.enrolled, s.onSite, s.dueNow])).toEqual([
      ['Grace Mokoena', 'Unit 14', false, false, true],
      ['Sam Gardener', 'Unit 20', false, false, false],
    ]);
    expect(both[1].notDue).toBe('They are not due at work at this time.');
    expect(await find('000000')).toEqual([]);
    expect((await w.http().post('/api/device/staff/find').set(g()).send({ code: '147' })).status).toBe(400);
    const refused = await enter(both[1].id, { enrol: idCard });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toBe('Sam Gardener is not due at work at this time. Scan them in as a visitor, and the customer will be asked.');
  });

  it('on the first day takes the ID and the reference photo, lets them in without asking, and tells the unit', async () => {
    expect((await enter(graceId, {})).status).toBe(400); // no ID yet
    expect((await enter(graceId, { enrol: idCard }, null)).status).toBe(400); // no photo
    expect((await enter(graceId, { enrol: { ...idCard, method: 'manual' } })).status).toBe(400); // typed ID, no photo of it
    const eventId = randomUUID();
    const r = await enter(graceId, { eventId, enrol: idCard });
    expect(r.body).toMatchObject({ status: 'on_site', message: 'Registered. Let them in.' });
    expect((await enter(graceId, { eventId, enrol: idCard })).body.visitId).toBe(r.body.visitId); // sent twice, saved once
    const [v] = await ownerQuery(
      `SELECT v.type, v.status, v.capture_method, v.identity_method, v.announced, v.face_photo_key IS NOT NULL AS face, c.name AS category, p.id_number, v.staff_id FROM visits v
         JOIN visitor_categories c ON c.id = v.category_id JOIN visitor_people p ON p.id = v.person_id WHERE v.id = $1`,
      [r.body.visitId],
    );
    expect(v).toEqual({ type: 'pedestrian', status: 'on_site', capture_method: 'scan', identity_method: 'scan', announced: true, face: true, category: 'Staff', id_number: '8501015009087', staff_id: graceId });
    expect((await find('550147'))[0]).toMatchObject({ fullName: 'Grace Mokoena', enrolled: true, onSite: true });
    expect((await alertsOf(thabo.token))[0]).toMatchObject({ kind: 'visitor_arrived', title: 'Your staff member has arrived', body: expect.stringMatching(/^Grace Mokoena came in at Main gate at \d\d:\d\d\.$/) });
    // On the gate's on-site list under the name the unit gave.
    const onSite = (await w.http().get('/api/device/visitors/on-site').set(g())).body.visitors;
    expect(onSite[0]).toMatchObject({ visitor: 'Grace Mokoena', visiting: 'Unit 14', category: 'Staff', staff: true, vehicle: null });
    // The reference photo can be shown to the guard, and each look is recorded.
    const ref = await w.http().get(`/api/device/staff/${graceId}/photo`).set(g());
    expect([ref.status, ref.headers['content-type']]).toEqual([200, 'image/jpeg']);
    expect(await ownerQuery(`SELECT 1 AS x FROM audit_log WHERE action = 'unit_staff.photo_view' AND entity_id = $1`, [graceId])).toHaveLength(1);
  });

  it('scans them out with their code, and shows the tenant when they came and went', async () => {
    expect((await enter(graceId, {})).status).toBe(409); // already on site
    const eventId = randomUUID();
    expect((await leave(graceId, eventId)).body).toEqual({ status: 'exited', message: 'Scanned out.' });
    expect((await leave(graceId, eventId)).status).toBe(200);
    expect((await leave(graceId)).status).toBe(409);
    const [mine] = (await w.http().get('/api/customer/staff').set(auth(thabo.token))).body;
    expect(mine).toMatchObject({ enrolled: true, onSite: false });
    expect(mine.lastIn && mine.lastOut).toBeTruthy();
    expect((await alertsOf(thabo.token))[0]).toMatchObject({ kind: 'visitor_left', title: 'Your staff member has left' });
  });

  it('on later days needs only the snapshot when the guard says it is the same person', async () => {
    const r = await enter(graceId, { samePerson: true });
    expect(r.body).toMatchObject({ status: 'on_site', message: 'Let them in.' });
    const [v] = await ownerQuery('SELECT capture_method, checks FROM visits WHERE id = $1', [r.body.visitId]);
    expect(v).toMatchObject({ capture_method: 'staff', checks: { staff: true, firstDay: false, face: { guardSaysSame: true, comparison: 'off', automatic: false } } });
    await leave(graceId);
  });

  it('when the guard doubts the photo, wants a reason and his decision, and tells the supervisor and the unit', async () => {
    expect((await enter(graceId, { samePerson: false })).status).toBe(400);
    const r = await enter(graceId, { samePerson: false, handling: { note: 'A different woman, says she is the sister.', allowed: false } });
    expect(r.body).toEqual({ status: 'refused', visitId: null, message: 'Not let in. Your supervisor and the customer have been told.' });
    expect((await find('550147'))[0].onSite).toBe(false);
    const [x] = await ownerQuery(`SELECT type, allowed, note, staff_id, photo_key IS NOT NULL AS photo FROM visit_exceptions WHERE staff_id = $1`, [graceId]);
    expect(x).toEqual({ type: 'face_mismatch', allowed: false, note: 'A different woman, says she is the sister.', staff_id: graceId, photo: true });
    expect((await alertsOf(supervisor))[0]).toMatchObject({ kind: 'visitor_exception', body: 'Staff photo in doubt at Main gate: someone arrived as Grace Mokoena, unit 14. The guard did not let them in.' });
    expect((await alertsOf(thabo.token))[0]).toMatchObject({ kind: 'visitor_exit_exception', title: 'The gate was not sure about your staff member' });
    const list = (await w.http().get(`${site()}/visit-exceptions`).set(auth(supervisor))).body.open;
    expect(list[0]).toMatchObject({ typeLabel: 'Staff photo in doubt', allowed: false, note: 'A different woman, says she is the sister.' });
  });

  describe('with automatic photo matching switched on for the site', () => {
    it('lets a clear match in on the photos alone, and gives any doubt to the guard', async () => {
      expect((await faceCheck(true)).status).toBe(200);
      const compare = (face: string) => w.http().post(`/api/device/staff/${graceId}/compare`).set(g()).attach('face', photo(face), { filename: 'face.jpg', contentType: 'image/jpeg' });
      expect((await compare('person-a-selfie.jpg')).body).toEqual({ result: 'match', text: 'The photos look like the same person.' });
      expect((await compare('person-b.jpg')).body).toEqual({ result: 'no_match', text: 'This may be a different person. Look carefully.' });
      expect((await compare('no-face.jpg')).body.result).toBe('no_face');
      // The comparison is in doubt: even if the guard says "same person", he must give a reason.
      expect((await enter(graceId, { samePerson: true }, 'person-b.jpg')).status).toBe(400);
      const let_in = await enter(graceId, { samePerson: true, handling: { note: 'New hairstyle, ID checked again.', allowed: true } }, 'person-b.jpg');
      expect(let_in.body.status).toBe('on_site');
      const [a] = await ownerQuery(`SELECT after FROM audit_log WHERE action = 'unit_staff.face_doubt' ORDER BY id DESC LIMIT 1`);
      expect(a.after).toMatchObject({ guardSaysSame: true, comparison: 'no_match', allowed: true });
      await leave(graceId);
      // A clear match: let in at once, recorded as decided by the comparison and not by the guard.
      const auto = await enter(graceId, { samePerson: true }, 'person-a-selfie.jpg');
      expect(auto.body).toMatchObject({ status: 'on_site', message: 'The photos match. Let them in.' });
      const [v] = await ownerQuery('SELECT checks FROM visits WHERE id = $1', [auto.body.visitId]);
      expect(v.checks.face).toEqual({ guardSaysSame: null, comparison: 'match', automatic: true });
      await leave(graceId);
      // No clear face in the snapshot: not automatic; the guard looked and said it is her.
      const byEye = await enter(graceId, { samePerson: true }, 'no-face.jpg');
      expect(byEye.body).toMatchObject({ status: 'on_site', message: 'Let them in.' });
      expect((await ownerQuery('SELECT checks FROM visits WHERE id = $1', [byEye.body.visitId]))[0].checks.face).toEqual({ guardSaysSame: true, comparison: 'no_face', automatic: false });
      await leave(graceId);
      await faceCheck(false);
    });
  });

  it('records staff who come in their own vehicle, and the vehicle they came in each day', async () => {
    const add = (body: Record<string, unknown>) => w.http().post('/api/customer/staff').set(auth(thabo.token)).send({ fullName: 'David Driver', cell: '071 555 0333', ...body });
    expect((await add({ byVehicle: true })).body.errors).toEqual({ registration: 'Enter the number plate of their vehicle.' });
    const made = await add({ byVehicle: true, registration: 'ca 900-100' });
    expect(made.status).toBe(201);
    expect((await find('550333'))[0]).toMatchObject({ fullName: 'David Driver', vehicle: 'CA900100' });
    const day1 = await enter(made.body.id, { enrol: { ...idCard, idNumber: '7001015009081', surname: 'Driver', names: 'David' }, registration: 'CA 900 100' });
    expect(day1.body.status).toBe('on_site');
    const [v] = await ownerQuery('SELECT v.type, ve.registration, v.checks FROM visits v JOIN visitor_vehicles ve ON ve.id = v.vehicle_id WHERE v.id = $1', [day1.body.visitId]);
    expect(v).toMatchObject({ type: 'vehicle', registration: 'CA900100' });
    expect(v.checks.otherVehicle).toBeUndefined();
    expect((await w.http().get('/api/device/visitors/on-site').set(g())).body.visitors.find((x: { id: string }) => x.id === day1.body.visitId)).toMatchObject({ visitor: 'David Driver', vehicle: 'CA900100', staff: true });
    await leave(made.body.id);
    // Another day in a different vehicle, and one on foot: both are let in, and it is noted.
    const other = await enter(made.body.id, { samePerson: true, registration: 'GP 1' });
    expect((await ownerQuery('SELECT type, checks FROM visits WHERE id = $1', [other.body.visitId]))[0]).toMatchObject({ type: 'vehicle', checks: { otherVehicle: true } });
    await leave(made.body.id);
    const walked = await enter(made.body.id, { samePerson: true });
    expect((await ownerQuery('SELECT type, checks FROM visits WHERE id = $1', [walked.body.visitId]))[0]).toMatchObject({ type: 'pedestrian', checks: { onFootToday: true } });
    await leave(made.body.id);
    await w.http().post(`/api/customer/staff/${made.body.id}/remove`).set(auth(thabo.token));
  });

  it('stops access at once when the tenant takes them off the list', async () => {
    expect((await w.http().post(`/api/customer/staff/${graceId}/remove`).set(auth(thabo.token))).status).toBe(200);
    expect((await find('550147')).map((s) => s.fullName)).toEqual(['Sam Gardener']);
    expect((await enter(graceId, { samePerson: true })).status).toBe(404);
    expect((await w.http().get('/api/customer/staff').set(auth(thabo.token))).body).toEqual([]);
    // The record is kept.
    expect(await ownerQuery('SELECT removed_at IS NOT NULL AS removed FROM unit_staff WHERE id = $1', [graceId])).toEqual([{ removed: true }]);
  });

  it('refuses an ID on the first day that is not the one the unit registered', async () => {
    const made = await w.http().post('/api/customer/staff').set(auth(thabo.token)).send({ fullName: 'Peter Painter', cell: '084 555 0222', idNumber: '9001015009087' });
    const r = await enter(made.body.id, { enrol: idCard });
    expect(r.status).toBe(409);
    expect(r.body.message).toBe('This ID is not the one registered for this staff member. Scan them in as a visitor, and the customer will be asked.');
  });
});
