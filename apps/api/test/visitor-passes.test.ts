import { randomUUID } from 'node:crypto';
import { DEFAULT_VISITOR_SETTINGS } from '@onpar/rules';
import { NotificationsService, PushResult, PushSender } from '../src/notifications/notifications.service';
import { VisitPassService } from '../src/visitors/visit-pass.service';
import { enrol, enrolmentData, ownerQuery, PNG, setupWorld, World } from './helpers';

class QuietSender implements PushSender {
  async send(): Promise<PushResult> {
    return { ok: true };
  }
}

/** Visitor management, step 4 (plan approved 7 Oct 2026): announced visitors, regulars and fixed-period contractors. */
describe('visitor management: announced visitors', () => {
  let w: World;
  let admin: string;
  let supervisor: string;
  let deviceToken: string;
  let guard: { token: string };
  let mainGate: string;
  let backGate: string;
  let unit14: string;
  let unit20: string;
  let cats: Record<string, string>;
  let thabo: { id: string; token: string };
  let nomsa: { id: string; token: string };
  let carol: { id: string; token: string };
  let today: string;
  let seq = 0;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const g = () => ({ 'X-Device-Token': deviceToken, Authorization: `Bearer ${guard.token}` });
  const site = () => `/api/sites/${w.a.siteId}`;
  const now = () => new Date().toISOString();
  const day = (offset: number) => new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
  const pass = (who: { token: string }, body: Record<string, unknown>) =>
    w.http().post('/api/customer/passes').set(auth(who.token)).send({ kind: 'once', visitorName: 'Sipho Nkosi', categoryId: cats['Visitor'], visitDate: today, ...body });
  const check = async (body: Record<string, unknown>) => (await w.http().post('/api/device/visitors/check').set(g()).send(body)).body;
  /** A visitor scanned in at the gate. */
  const arrive = (data: Record<string, unknown> = {}) => {
    seq += 1;
    const person = { idNumber: `P${String(seq).padStart(8, '0')}`, surname: 'Nkosi', names: 'Sipho', document: 'passport', method: 'manual' };
    const vehicle = { registration: `GP 77 ${seq}`, make: 'VW', model: 'Polo', colour: 'Red', vin: '', discExpiry: null, method: 'scan' };
    return w.http().post('/api/device/visitors').set(g()).field('data', JSON.stringify({ eventId: randomUUID(), type: 'vehicle', person, vehicle, pax: 0, categoryId: cats['Visitor'], unitId: unit20, trustedAt: now(), deviceClock: now(), ...data })).attach('identity', PNG, { filename: 'i.png', contentType: 'image/png' });
  };
  const myAlerts = async (who: { token: string }) => (await w.http().get('/api/notifications').set(auth(who.token))).body.alerts as { kind: string; title: string; body: string; url: string }[];
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
    mainGate = (await w.http().post(`${site()}/gates`).set(auth(admin)).send({ name: 'Main gate' })).body.id;
    backGate = (await w.http().post(`${site()}/gates`).set(auth(admin)).send({ name: 'Back gate' })).body.id;
    await w.http().put(`${site()}/gate-phones/${d.body.device.id}`).set(auth(admin)).send({ gateId: mainGate });
    unit14 = (await w.http().post(`${site()}/units`).set(auth(admin)).send({ name: '14' })).body.id;
    unit20 = (await w.http().post(`${site()}/units`).set(auth(admin)).send({ name: '20' })).body.id;
    const setup = (await w.http().get(`${site()}/visitor-setup`).set(auth(admin))).body;
    cats = Object.fromEntries(setup.categories.map((c: { name: string; id: string }) => [c.name, c.id]));
    thabo = await customer({ kind: 'tenant', fullName: 'Thabo Tenant', email: 'thabo@home.test', unitId: unit14, phone: '082 555 0140' });
    nomsa = await customer({ kind: 'tenant', fullName: 'Nomsa Other', email: 'nomsa@home.test', unitId: unit20 });
    carol = await customer({ kind: 'client', fullName: 'Carol Client', email: 'carol@estate.test' });
    today = (await ownerQuery(`SELECT to_char(now() AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS d`))[0].d;
  });
  afterAll(() => w.app.close());

  it('offers the customer the site’s kinds of visitor and its gates', async () => {
    const r = (await w.http().get('/api/customer/passes').set(auth(thabo.token))).body;
    expect(r.current).toEqual([]);
    expect(r.gates.map((x: { name: string }) => x.name)).toEqual(['Main gate', 'Back gate']);
    expect(r.categories).toHaveLength(2);
    expect(r.today).toBe(today);
  });

  it('will not save an announcement without a way to recognise the visitor', async () => {
    expect((await pass(thabo, {})).body.errors).toEqual({ identifier: 'Give at least one: their ID number, cell number or number plate.' });
    expect((await pass(thabo, { registration: 'CA 1', visitDate: day(-1) })).body.errors).toEqual({ visitDate: 'That day has passed.' });
    expect((await pass(thabo, { registration: 'CA 1', gateId: randomUUID() })).body.errors).toEqual({ gateId: 'Unknown gate.' });
    expect((await pass(thabo, { registration: 'CA 1', categoryId: randomUUID() })).status).toBe(400);
  });

  it('lets an announced visitor straight in on a matching number plate, tells the customer, and uses the announcement up', async () => {
    const made = await pass(thabo, { registration: 'gp 100-200', gateId: backGate });
    expect(made.status).toBe(201);
    expect((await w.http().get('/api/customer/passes').set(auth(thabo.token))).body.current[0]).toMatchObject({ visitorName: 'Sipho Nkosi', registration: 'GP100200', gateName: 'Back gate', when: `${today}, any time`, stateLabel: 'Expected' });
    const found = await check({ idNumber: 'P11112222', registration: 'GP 100 200' });
    expect(found.expected).toEqual({ passId: made.body.id, visitorName: 'Sipho Nkosi', visiting: 'Unit 14', category: 'Visitor', by: 'Thabo Tenant', regular: false, namedGate: 'Back gate', mismatch: [] });
    const before = (await myAlerts(thabo)).length;
    // The guard had unit 20 chosen; the announcement decides who the visitor is for.
    const r = await arrive({ passId: made.body.id, vehicle: { registration: 'GP 100 200', make: 'VW', model: 'Polo', colour: 'Red', vin: '', discExpiry: null, method: 'scan' }, categoryId: null, unitId: null });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'on_site', blocked: null });
    const [v] = await ownerQuery('SELECT status, announced, pass_id, unit_id, entry_at IS NOT NULL AS entered, asked FROM visits WHERE id = $1', [r.body.id]);
    expect(v).toEqual({ status: 'on_site', announced: true, pass_id: made.body.id, unit_id: unit14, entered: true, asked: 0 });
    const alerts = await myAlerts(thabo);
    expect(alerts).toHaveLength(before + 1);
    expect(alerts[0]).toMatchObject({ kind: 'visitor_arrived', title: 'Your visitor arrived at Main gate', body: 'Nkosi, Sipho was let in, in GP100200 Red VW Polo.' });
    expect((await w.http().get(`/api/device/visitors/${r.body.id}`).set(g())).body).toMatchObject({ status: 'on_site', decided: 'Expected by unit 14', canDial: false });
    expect((await w.http().get(`/api/customer/visits/${r.body.id}`).set(auth(thabo.token))).body).toMatchObject({ outcome: 'Expected: let in without asking', canPass: false });
    expect((await w.http().get(`${site()}/visits`).set(auth(supervisor))).body[0]).toMatchObject({ answered: 'Expected: announced by the customer' });
    // One entry only: the next time, the same plate is an unannounced visitor again.
    expect((await check({ registration: 'GP 100 200' })).expected).toBeNull();
    expect((await w.http().get('/api/customer/passes').set(auth(thabo.token))).body.past[0]).toMatchObject({ stateLabel: 'Arrived' });
    const again = await arrive({ passId: made.body.id, vehicle: { registration: 'GP 100 200', make: 'VW', model: 'Polo', colour: 'Red', vin: '', discExpiry: null, method: 'scan' } });
    expect(again.status).toBe(409);
  });

  it('matches on an ID number, or on a cell number the guard types in', async () => {
    await pass(thabo, { visitorName: 'Lindiwe Zulu', idNumber: '850505 5009 083' });
    expect((await check({ idNumber: '8505055009083' })).expected).toMatchObject({ visitorName: 'Lindiwe Zulu', namedGate: null });
    await pass(thabo, { visitorName: 'Pieter Botha', cell: '+27 83 555 0177' });
    expect((await check({ idNumber: 'P33334444' })).expected).toBeNull();
    expect((await check({ idNumber: 'P33334444', cell: '083 555 0177' })).expected).toMatchObject({ visitorName: 'Pieter Botha' });
    const r = await arrive({ passId: (await check({ cell: '0835550177' })).expected.passId, cell: '083 555 0177', categoryId: null, unitId: null });
    expect(r.body.status).toBe('on_site');
  });

  it('lets the visitor in on a partial match and tells the customer what did not match', async () => {
    const made = await pass(thabo, { visitorName: 'Jan Smit', idNumber: 'P55556666', registration: 'CA 999 111' });
    const found = await check({ idNumber: 'P55556666', registration: 'CA 000 222' });
    expect(found.expected.mismatch).toEqual(['number plate']);
    const r = await arrive({ passId: made.body.id, person: { idNumber: 'P55556666', surname: 'Smit', names: 'Jan', document: 'passport', method: 'manual' }, vehicle: { registration: 'CA 000 222', make: 'Ford', model: 'Ranger', colour: 'White', vin: '', discExpiry: null, method: 'scan' } });
    expect(r.body.status).toBe('on_site');
    expect((await myAlerts(thabo))[0].body).toBe('Smit, Jan was let in, in CA000222 White Ford Ranger. The number plate did not match what you gave the gate.');
    const [v] = await ownerQuery('SELECT checks FROM visits WHERE id = $1', [r.body.id]);
    expect(v.checks.mismatch).toEqual(['number plate']);
  });

  it('treats a visitor outside the time given as unannounced', async () => {
    const made = await pass(thabo, { visitorName: 'Late Visitor', registration: 'FS 1' });
    await ownerQuery(`UPDATE visitor_passes SET time_from = ((now() AT TIME ZONE 'Africa/Johannesburg') + interval '3 hours')::time WHERE id = $1 AND extract(hour FROM now() AT TIME ZONE 'Africa/Johannesburg') < 20`, [made.body.id]);
    const [p] = await ownerQuery('SELECT time_from IS NOT NULL AS timed FROM visitor_passes WHERE id = $1', [made.body.id]);
    // (Skipped in the last hours of the day, when three hours later is tomorrow.)
    if (p.timed) expect((await check({ registration: 'FS 1' })).expected).toBeNull();
    await ownerQuery(`UPDATE visitor_passes SET time_from = ((now() AT TIME ZONE 'Africa/Johannesburg') + interval '20 minutes')::time WHERE id = $1 AND extract(hour FROM now() AT TIME ZONE 'Africa/Johannesburg') BETWEEN 1 AND 22`, [made.body.id]);
    expect((await check({ registration: 'FS 1' })).expected).toMatchObject({ visitorName: 'Late Visitor' });
    // Tomorrow's visitor is not expected today.
    await pass(thabo, { visitorName: 'Tomorrow', registration: 'FS 2', visitDate: day(1) });
    expect((await check({ registration: 'FS 2' })).expected).toBeNull();
  });

  it('lets a regular in again and again, on their days and hours only', async () => {
    const made = await pass(thabo, { kind: 'ongoing', visitorName: 'Grace the cleaner', categoryId: cats['Contractor'], idNumber: 'P77778888', visitDate: null, days: [1, 2, 3, 4, 5, 6, 7], hoursFrom: '00:00', hoursTo: '23:59' });
    expect(made.status).toBe(201);
    const person = { idNumber: 'P77778888', surname: 'Mokoena', names: 'Grace', document: 'passport', method: 'manual' };
    // Never scanned out after the first visit: the guard is warned, gives a reason, and she is let in again.
    for (let i = 0; i < 2; i++) expect((await arrive({ passId: made.body.id, person, type: 'pedestrian', vehicle: null, pax: null, onSite: i ? { reason: 'not_scanned_out' } : null }).attach('face', PNG, { filename: 'f.png', contentType: 'image/png' })).body.status).toBe('on_site');
    expect((await myAlerts(thabo))[0].body).toBe('Mokoena, Grace was let in, on foot.');
    expect((await w.http().get('/api/customer/passes').set(auth(thabo.token))).body.current.find((p: { visitorName: string }) => p.visitorName === 'Grace the cleaner')).toMatchObject({ stateLabel: 'Regular', idNumber: '•••••8888', when: 'Every day, 00:00 to 23:59' });
    // Not on a day that is not hers.
    await ownerQuery(`UPDATE visitor_passes SET days = ARRAY[(extract(isodow FROM now() AT TIME ZONE 'Africa/Johannesburg')::int % 7) + 1]::smallint[] WHERE id = $1`, [made.body.id]);
    expect((await check({ idNumber: 'P77778888' })).expected).toBeNull();
    // Not outside her hours.
    await ownerQuery(`UPDATE visitor_passes SET days = NULL, hours_from = '00:00', hours_to = '00:01' WHERE id = $1 AND extract(hour FROM now() AT TIME ZONE 'Africa/Johannesburg') >= 1`, [made.body.id]);
    const [p] = await ownerQuery(`SELECT hours_to = '00:01' AS narrowed FROM visitor_passes WHERE id = $1`, [made.body.id]);
    if (p.narrowed) expect((await check({ idNumber: 'P77778888' })).expected).toBeNull();
  });

  it('lets a contractor in between a first and a last day, and tells the customer three days before the end', async () => {
    const wrong = await pass(thabo, { kind: 'ongoing', visitorName: 'Build It', categoryId: cats['Contractor'], registration: 'NW 500', visitDate: null, startDate: day(10), endDate: today });
    expect(wrong.body.errors).toEqual({ endDate: 'The last day must be on or after the first day.' });
    const made = await pass(thabo, { kind: 'ongoing', visitorName: 'Build It', categoryId: cats['Contractor'], registration: 'NW 500', visitDate: null, startDate: today, endDate: day(10) });
    expect(made.status).toBe(201);
    expect((await check({ registration: 'NW500' })).expected).toMatchObject({ visitorName: 'Build It', regular: true, category: 'Contractor' });
    const passes = w.app.get(VisitPassService);
    expect(await passes.endingTick()).toBe(0);
    await ownerQuery(`UPDATE visitor_passes SET end_date = (now() AT TIME ZONE 'Africa/Johannesburg')::date + 2 WHERE id = $1`, [made.body.id]);
    expect(await passes.endingTick()).toBe(1);
    expect(await passes.endingTick()).toBe(0);
    expect((await myAlerts(thabo))[0]).toMatchObject({ kind: 'visitor_pass_ending', title: 'A contractor’s time is nearly up', url: '/c/visitors' });
    // After the last day the contractor is an unannounced visitor again.
    await ownerQuery(`UPDATE visitor_passes SET start_date = end_date - 30, end_date = (now() AT TIME ZONE 'Africa/Johannesburg')::date - 1 WHERE id = $1`, [made.body.id]);
    expect((await check({ registration: 'NW500' })).expected).toBeNull();
    expect((await w.http().get('/api/customer/passes').set(auth(thabo.token))).body.past.find((p: { visitorName: string }) => p.visitorName === 'Build It')).toMatchObject({ stateLabel: 'Ended' });
  });

  it('keeps each unit’s list to itself, and lets the customer take a visitor off it', async () => {
    const made = await pass(thabo, { visitorName: 'Private Guest', registration: 'EC 42' });
    expect(JSON.stringify((await w.http().get('/api/customer/passes').set(auth(nomsa.token))).body)).not.toContain('Private Guest');
    expect((await w.http().post(`/api/customer/passes/${made.body.id}/cancel`).set(auth(nomsa.token))).status).toBe(404);
    expect((await w.http().post(`/api/customer/passes/${made.body.id}/cancel`).set(auth(carol.token))).status).toBe(404);
    expect((await w.http().get('/api/customer/passes').set(auth(admin))).status).toBe(401);
    expect((await w.http().post(`/api/customer/passes/${made.body.id}/cancel`).set(auth(thabo.token))).status).toBe(200);
    expect((await w.http().post(`/api/customer/passes/${made.body.id}/cancel`).set(auth(thabo.token))).status).toBe(404);
    expect((await check({ registration: 'EC 42' })).expected).toBeNull();
    const [a] = await ownerQuery(`SELECT actor_type, actor_label FROM audit_log WHERE action = 'pass.cancel' AND entity_id = $1`, [made.body.id]);
    expect(a).toEqual({ actor_type: 'customer', actor_label: 'Thabo Tenant' });
    // The client's announcements are for the office.
    await pass(carol, { visitorName: 'Auditor', registration: 'GP 1' });
    expect((await check({ registration: 'GP 1' })).expected).toMatchObject({ visiting: 'The office', by: 'Carol Client' });
  });

  it('shows the gate who is expected today, without the numbers in full', async () => {
    const list = (await w.http().get('/api/device/visitors/expected').set(g())).body as { visitorName: string; visiting: string; when: string; knownBy: string; gateName: string | null }[];
    const names = list.map((x) => x.visitorName);
    expect(names).toEqual(expect.arrayContaining(['Lindiwe Zulu', 'Auditor']));
    expect(names).not.toContain('Tomorrow');
    expect(names).not.toContain('Private Guest');
    expect(list.find((x) => x.visitorName === 'Lindiwe Zulu')).toMatchObject({ visiting: 'Unit 14', when: 'Any time today', knownBy: 'ID number' });
    expect(JSON.stringify(list)).not.toContain('8505055009083');
  });

  it('never lets a barred visitor in on an announcement', async () => {
    await w.http().post(`${site()}/barred`).set(auth(admin)).send({ kind: 'registration', value: 'ZN 13', reason: 'Barred by the estate' });
    const made = await pass(thabo, { visitorName: 'Barred Friend', registration: 'ZN 13' });
    const found = await check({ registration: 'ZN 13' });
    expect(found.barred).toHaveLength(1);
    const r = await arrive({ passId: made.body.id, vehicle: { registration: 'ZN 13', make: '', model: '', colour: '', vin: '', discExpiry: null, method: 'scan' } });
    expect(r.body.status).toBe('denied');
    const [p] = await ownerQuery('SELECT status FROM visitor_passes WHERE id = $1', [made.body.id]);
    expect(p.status).toBe('active');
  });

  it('lets a customer put a visitor they approved on their list, without ever seeing the ID number', async () => {
    const r = await arrive({ unitId: unit14 });
    expect(r.body.status).toBe('awaiting_approval');
    const body = { kind: 'ongoing', visitorName: 'My brother', categoryId: cats['Visitor'], days: [6, 7] };
    expect((await w.http().post(`/api/customer/visits/${r.body.id}/pass`).set(auth(thabo.token)).send(body)).status).toBe(409);
    await w.http().post(`/api/customer/visits/${r.body.id}/decide`).set(auth(thabo.token)).send({ decision: 'accept' });
    expect((await w.http().get(`/api/customer/visits/${r.body.id}`).set(auth(thabo.token))).body.canPass).toBe(true);
    expect((await w.http().post(`/api/customer/visits/${r.body.id}/pass`).set(auth(nomsa.token)).send(body)).status).toBe(404);
    const made = await w.http().post(`/api/customer/visits/${r.body.id}/pass`).set(auth(thabo.token)).send(body);
    expect(made.status).toBe(201);
    const [p] = await ownerQuery('SELECT id_number, registration, from_visit_id FROM visitor_passes WHERE id = $1', [made.body.id]);
    expect(p).toEqual({ id_number: `P${String(seq).padStart(8, '0')}`, registration: `GP77${seq}`, from_visit_id: r.body.id });
    const mine = (await w.http().get('/api/customer/passes').set(auth(thabo.token))).body.current.find((x: { visitorName: string }) => x.visitorName === 'My brother');
    expect(mine).toMatchObject({ when: 'Sat, Sun, any time', registration: `GP77${seq}` });
    expect(mine.idNumber).toMatch(/^•+\d{4}$/);
  });

  it('with the one-entry limit off, an announced visitor may come and go on the day', async () => {
    await w.http().put(`${site()}/visitor-settings`).set(auth(admin)).send({ ...DEFAULT_VISITOR_SETTINGS, checks: { ...DEFAULT_VISITOR_SETTINGS.checks, entryLimit: false } });
    const made = await pass(thabo, { visitorName: 'In and out', registration: 'MP 8' });
    const car = { registration: 'MP 8', make: '', model: '', colour: '', vin: '', discExpiry: null, method: 'scan' };
    const first = await arrive({ passId: made.body.id, vehicle: car });
    expect(first.body.status).toBe('on_site');
    // Scanned out, then back in on the same announcement.
    const out = await w.http().post('/api/device/visitors/exit').set(g()).field('data', JSON.stringify({ eventId: randomUUID(), visitId: first.body.id, registration: 'MP 8', sameDriver: true, paxOut: 0, trustedAt: now(), deviceClock: now() }));
    expect(out.body.status).toBe('exited');
    expect((await arrive({ passId: made.body.id, vehicle: car })).body.status).toBe('on_site');
  });
});
