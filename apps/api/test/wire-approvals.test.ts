import { randomUUID } from 'node:crypto';
import { enrol, enrolmentData, ownerQuery, PNG, setupWorld, World } from './helpers';

/** The Wire, step 2 (owner, 8 Oct 2026): Thuthuka notes and awards approved by a person. */
describe('The Wire: Thuthuka notes and approvals', () => {
  let w: World;
  let admin: string;
  let manager: string;
  let supervisor: string;
  let device: string;
  let guardToken: string;
  let guardId: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const phone = () => ({ 'X-Device-Token': device, Authorization: `Bearer ${guardToken}` });
  const note = (extra: Record<string, unknown> = {}) =>
    w.http().post('/api/device/wire/notes').set(phone()).send({ eventId: randomUUID(), noticed: 'The light at gate 3 is off at night', suggestion: 'Put it on a timer switch', improves: 'Safety at the gate', ...extra });
  const barbs = async (rule: string) => (await ownerQuery(`SELECT coalesce(sum(barbs), 0)::int AS n FROM wire_entries WHERE employee_id = $1 AND rule = $2`, [guardId, rule]))[0].n as number;

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    manager = await w.login('manager@a.test');
    supervisor = await w.login('supervisor@a.test');
    const o = await enrol(w, admin, enrolmentData(w.a.siteId, { fullName: 'Sipho Ready' }));
    guardId = o.body.officer.id;
    device = (await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Gate', serialOrImei: '356938035643222', siteId: w.a.siteId, postName: 'Main gate' })).body.deviceToken;
    guardToken = (await w.http().post('/api/device/login').set('X-Device-Token', device).send({ login: o.body.officer.employeeNumber, pin: o.body.initialPin })).body.token;
  });
  afterAll(() => w.app.close());

  it('a guard sends a Thuthuka note and earns 2 barbs, for the first two notes of the month only', async () => {
    expect((await note({ noticed: '' })).status).toBe(400);
    const first = await note();
    expect(first.status).toBe(200);
    expect(first.body.barbs).toBe(2);
    expect((await note()).body.barbs).toBe(2);
    expect((await note()).body.barbs).toBe(0);
    expect(await barbs('thuthuka_sent')).toBe(4);
    // A retry of the same note is one note.
    const id = randomUUID();
    await note({ eventId: id });
    await note({ eventId: id });
    expect((await w.http().get('/api/device/wire/notes').set(phone())).body).toHaveLength(4);
  });

  it('a note can carry a photo, which managers can open', async () => {
    const id = randomUUID();
    const r = await w.http().post('/api/device/wire/notes').set(phone())
      .field('data', JSON.stringify({ eventId: id, noticed: 'Broken fence panel behind unit 9', suggestion: 'Add it to the patrol route', improves: 'Perimeter' }))
      .attach('photo', PNG, { filename: 'fence.png', contentType: 'image/png' });
    expect(r.status).toBe(200);
    const photo = await w.http().get(`/api/wire/notes/${id}/photo`).set(auth(manager));
    expect(photo.status).toBe(200);
    expect(photo.headers['content-type']).toContain('image/png');
  });

  it('a supervisor marks a note as being looked at; only the owner adopts, with a reason the guard reads, and 25 barbs', async () => {
    const list = (await w.http().get('/api/wire/approvals').set(auth(supervisor))).body;
    expect(list.canDecide).toBe(false);
    const id = list.notes[0].id;
    expect((await w.http().post(`/api/wire/notes/${id}/decide`).set(auth(supervisor)).send({ status: 'under_review' })).status).toBe(200);
    expect((await w.http().post(`/api/wire/notes/${id}/decide`).set(auth(supervisor)).send({ status: 'adopted', reason: 'Good idea' })).status).toBe(403);
    expect((await w.http().post(`/api/wire/notes/${id}/decide`).set(auth(admin)).send({ status: 'adopted' })).status).toBe(400);
    expect((await w.http().post(`/api/wire/notes/${id}/decide`).set(auth(admin)).send({ status: 'adopted', reason: 'Timer fitted on all gate lights' })).status).toBe(200);
    expect((await w.http().post(`/api/wire/notes/${id}/decide`).set(auth(admin)).send({ status: 'declined', reason: 'Changed my mind' })).status).toBe(409);
    expect(await barbs('thuthuka_adopted')).toBe(25);
    const mine = (await w.http().get('/api/device/wire/notes').set(phone())).body.find((n: { id: string }) => n.id === id);
    expect(mine).toMatchObject({ status: 'adopted', statusLabel: 'Adopted', reason: 'Timer fitted on all gate lights' });
    // The reason is on his Wire too.
    const wire = (await w.http().get('/api/device/wire').set(phone())).body;
    expect(wire.recent.find((r: { label: string }) => r.label === 'Thuthuka note adopted')).toMatchObject({ barbs: 25, note: 'Timer fitted on all gate lights' });
    // Declining writes no barbs and still tells him why.
    const other = list.notes[1].id;
    expect((await w.http().post(`/api/wire/notes/${other}/decide`).set(auth(admin)).send({ status: 'declined', reason: 'The client is replacing the lights this month' })).status).toBe(200);
    expect(await barbs('thuthuka_adopted')).toBe(25);
  });

  it('customer praise waits for the owner, pays 25 once a month, and is never paid on proposal', async () => {
    const p = await w.http().post('/api/wire/awards').set(auth(manager)).send({ employeeId: guardId, kind: 'customer_praise', why: 'Tenant of unit 4 thanked him for helping with her groceries' });
    expect(p.status).toBe(201);
    expect(await barbs('customer_praise')).toBe(0);
    expect((await w.http().post(`/api/wire/awards/${p.body.id}/decide`).set(auth(manager)).send({ approve: true })).status).toBe(403);
    expect((await w.http().post(`/api/wire/awards/${p.body.id}/decide`).set(auth(admin)).send({ approve: true, reason: 'Confirmed with the tenant by phone' })).status).toBe(200);
    expect(await barbs('customer_praise')).toBe(25);
    const again = await w.http().post('/api/wire/awards').set(auth(manager)).send({ employeeId: guardId, kind: 'customer_praise', why: 'Another tenant praised him' });
    expect((await w.http().post(`/api/wire/awards/${again.body.id}/decide`).set(auth(admin)).send({ approve: true })).status).toBe(409);
    expect((await w.http().post(`/api/wire/awards/${again.body.id}/decide`).set(auth(admin)).send({ approve: false })).status).toBe(400);
    expect((await w.http().post(`/api/wire/awards/${again.body.id}/decide`).set(auth(admin)).send({ approve: false, reason: 'One a month; put it forward next month' })).status).toBe(200);
  });

  it('recognition awards stay in the range and inside the site’s monthly budget', async () => {
    expect((await w.http().post('/api/wire/awards').set(auth(supervisor)).send({ employeeId: guardId, kind: 'discretionary', barbs: 20, why: 'Stayed late in the storm' })).status).toBe(400);
    await w.http().put('/api/wire/settings').set(auth(admin)).send({ discretionaryBudgetPerSite: 15 });
    const a = await w.http().post('/api/wire/awards').set(auth(supervisor)).send({ employeeId: guardId, kind: 'discretionary', barbs: 10, why: 'Stayed late in the storm' });
    const b = await w.http().post('/api/wire/awards').set(auth(supervisor)).send({ employeeId: guardId, kind: 'discretionary', barbs: 10, why: 'Found the lost child' });
    expect((await w.http().post(`/api/wire/awards/${a.body.id}/decide`).set(auth(admin)).send({ approve: true })).status).toBe(200);
    const over = await w.http().post(`/api/wire/awards/${b.body.id}/decide`).set(auth(admin)).send({ approve: true });
    expect(over.status).toBe(409);
    expect(over.body.message).toMatch(/5 recognition barbs left/);
    const approvals = (await w.http().get('/api/wire/approvals').set(auth(admin))).body;
    expect(approvals.budget.find((x: { siteId: string }) => x.siteId === w.a.siteId)).toMatchObject({ used: 10, budget: 15 });
    expect((await ownerQuery(`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'wire.award_%'`))[0].n).toBeGreaterThanOrEqual(5);
  });

  it('another company sees none of it', async () => {
    const bAdmin = await w.login('admin@b.test');
    const r = (await w.http().get('/api/wire/approvals').set(auth(bAdmin))).body;
    expect(r.notes).toHaveLength(0);
    expect(r.awards).toHaveLength(0);
    expect((await w.http().post('/api/wire/awards').set(auth(bAdmin)).send({ employeeId: guardId, kind: 'customer_praise', why: 'Not my guard at all' })).status).toBe(404);
  });
});
