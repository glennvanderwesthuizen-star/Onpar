import { randomUUID } from 'node:crypto';
import { enrol, enrolmentData, ownerQuery, setupWorld, World } from './helpers';

/** The Wire, step 3 (owner, 8 Oct 2026): the goals and store table, a guard's goal, and hand-ins. */
describe('The Wire: goals and the store', () => {
  let w: World;
  let admin: string;
  let manager: string;
  let guardId: string;
  let device: string;
  let token: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const phone = () => ({ 'X-Device-Token': device, Authorization: `Bearer ${token}` });
  const mine = async () => (await w.http().get('/api/device/wire/store').set(phone())).body;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const item = (body: { items: { name: string; id: string }[] }, name: string): any => body.items.find((i) => i.name === name)!;
  const give = (barbs: number) =>
    ownerQuery(`INSERT INTO wire_entries (company_id, employee_id, entry_date, rule, barbs, source_key) VALUES ($1, $2, current_date, 'standard', $3, $4)`, [w.a.companyId, guardId, barbs, randomUUID()]);

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    manager = await w.login('manager@a.test');
    const o = await enrol(w, admin, enrolmentData(w.a.siteId, { fullName: 'Thabo Climber' }));
    guardId = o.body.officer.id;
    device = (await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Gate', serialOrImei: '356938035643333', siteId: w.a.siteId, postName: 'Main gate' })).body.deviceToken;
    token = (await w.http().post('/api/device/login').set('X-Device-Token', device).send({ login: o.body.officer.employeeNumber, pin: o.body.initialPin })).body.token;
    // Joined eight months ago, Grade C.
    await w.http().put(`/api/wire/guards/${guardId}/profile`).set(auth(admin)).send({ joinedOn: new Date(Date.now() - 245 * 86400_000).toISOString().slice(0, 10) });
    await ownerQuery(`UPDATE employees SET psira_grade = 'C' WHERE id = $1`, [guardId]);
    await give(120);
  });
  afterAll(() => w.app.close());

  it('starts from the rule book’s table, and the store is closed', async () => {
    const o = (await w.http().get('/api/wire/store').set(auth(manager))).body;
    expect(o.storeOpen).toBe(false);
    expect(o.items.map((i: { name: string }) => i.name)).toContain('PSIRA Grade B course');
    expect(item(o, 'PSIRA Grade B course')).toMatchObject({ barbs: 200, needsGrade: 'C', monthsService: 6, costRand: 1380 });
  });

  it('the guard picks a goal and sees its steps; no rand amount reaches his phone', async () => {
    const before = await mine();
    expect(JSON.stringify(before)).not.toMatch(/costRand|cost_rand|R\d/);
    const gradeB = item(before, 'PSIRA Grade B course');
    const r = await w.http().post('/api/device/wire/goal').set(phone()).send({ itemId: gradeB.id });
    expect(r.status).toBe(200);
    expect(r.body.goal.name).toBe('PSIRA Grade B course');
    expect(r.body.goal.steps.map((s: { label: string; done: boolean }) => [s.label, s.done])).toEqual([
      ['Grade C', true],
      ['6 months of service', true],
      ['Your course for this year', true],
      ['200 barbs available', false],
    ]);
    expect(r.body.goal.ready).toBe(false);
    // His own words instead, then back.
    expect((await w.http().post('/api/device/wire/goal').set(phone()).send({ ownWords: 'Save for my daughter’s school shoes' })).body.goal).toMatchObject({ name: 'Save for my daughter’s school shoes', ownWords: true });
    await w.http().post('/api/device/wire/goal').set(phone()).send({ itemId: gradeB.id });
    expect((await ownerQuery('SELECT count(*)::int AS n FROM wire_goals WHERE employee_id = $1 AND ended_at IS NULL', [guardId]))[0].n).toBe(1);
  });

  it('the owner sees who is aiming at what and when they will be ready', async () => {
    const o = (await w.http().get('/api/wire/store').set(auth(manager))).body;
    expect(o.aiming).toEqual([expect.objectContaining({ name: 'Thabo Climber', goal: 'PSIRA Grade B course', ready: false })]);
    expect(o.plan).toEqual([expect.objectContaining({ name: 'PSIRA Grade B course', aiming: 1, readyNow: 0 })]);
  });

  it('nothing can be handed in while the store is closed', async () => {
    await give(200);
    const s = await mine();
    expect(item(s, 'PSIRA Grade B course')).toMatchObject({ ready: true, canHandIn: false });
    const r = await w.http().post('/api/device/wire/handin').set(phone()).send({ eventId: randomUUID(), itemId: item(s, 'PSIRA Grade B course').id });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/opens soon/);
  });

  it('once open, a hand-in lowers available barbs and never the Wire; one course a year; cancelling gives them back', async () => {
    expect((await w.http().put('/api/wire/settings').set(auth(admin)).send({ storeOpen: true })).status).toBe(200);
    const before = (await w.http().get(`/api/wire/guards/${guardId}`).set(auth(admin))).body;
    const id = randomUUID();
    const s = await mine();
    const r = await w.http().post('/api/device/wire/handin').set(phone()).send({ eventId: id, itemId: item(s, 'PSIRA Grade B course').id });
    expect(r.status).toBe(200);
    // A retry is one hand-in.
    await w.http().post('/api/device/wire/handin').set(phone()).send({ eventId: id, itemId: item(s, 'PSIRA Grade B course').id });
    const after = (await w.http().get(`/api/wire/guards/${guardId}`).set(auth(admin))).body;
    expect(after.wireTotal).toBe(before.wireTotal);
    expect(after.available).toBe(before.available - 200);
    expect(r.body.handins[0]).toMatchObject({ itemName: 'PSIRA Grade B course', barbs: 200, status: 'requested' });
    // A second course within twelve months waits.
    await give(300);
    const again = await mine();
    expect(item(again, 'First aid course').steps.find((x: { label: string }) => x.label === 'Your course for this year')).toMatchObject({ done: false });
    // Airtime is not a course: open to him.
    expect(item(again, 'Airtime, own number').canHandIn).toBe(true);
    // The owner sees it in the fulfilment queue and supplies it, or cancels.
    const q = (await w.http().get('/api/wire/store').set(auth(admin))).body.handins;
    expect(q[0]).toMatchObject({ itemName: 'PSIRA Grade B course', status: 'requested', costRand: 1380 });
    expect((await w.http().post(`/api/wire/handins/${id}/cancel`).set(auth(manager)).send({ reason: 'No course this month' })).status).toBe(403);
    expect((await w.http().post(`/api/wire/handins/${id}/cancel`).set(auth(admin)).send({ reason: 'The provider cancelled; hand in again next month' })).status).toBe(200);
    const back = (await w.http().get(`/api/wire/guards/${guardId}`).set(auth(admin))).body;
    expect(back.available).toBe(before.available + 300);
    expect(back.wireTotal).toBe(before.wireTotal + 300);
    expect((await w.http().post(`/api/wire/handins/${id}/supply`).set(auth(admin))).status).toBe(409);
  });

  it('the owner changes the table; prices already handed in stay as they were', async () => {
    const o = (await w.http().get('/api/wire/store').set(auth(admin))).body;
    const airtime = item(o, 'Airtime, own number') as unknown as Record<string, unknown>;
    expect((await w.http().put(`/api/wire/items/${airtime.id}`).set(auth(manager)).send({ ...airtime, barbs: 60 })).status).toBe(403);
    const { id: _id, ...rest } = airtime;
    expect((await w.http().put(`/api/wire/items/${airtime.id}`).set(auth(admin)).send({ ...rest, barbs: 60 })).status).toBe(200);
    expect((await w.http().post('/api/wire/items').set(auth(admin)).send({ name: 'Rain jacket', category: 'kit', barbs: 0 })).status).toBe(400);
    expect((await w.http().post('/api/wire/items').set(auth(admin)).send({ name: 'Rain jacket', category: 'kit', barbs: 180, costRand: 450 })).status).toBe(201);
    expect(item(await mine(), 'Airtime, own number').barbs).toBe(60);
    expect((await ownerQuery(`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'wire.item_%'`))[0].n).toBe(2);
  });

  it('a goal can need a kind of training, ticked off once it is recorded in Training', async () => {
    const r = await w.http().post('/api/wire/items').set(auth(admin)).send({ name: 'Armed response course', category: 'training', barbs: 250, needsGrade: 'B', needsTraining: 'pre_employment' });
    expect(r.status).toBe(201);
    expect((await w.http().post('/api/wire/items').set(auth(admin)).send({ name: 'Juggling', category: 'other', barbs: 10, needsTraining: 'juggling' })).status).toBe(400);
    const step = async () => item(await mine(), 'Armed response course').steps.find((x: { label: string }) => x.label === 'Pre-employment training');
    expect(await step()).toMatchObject({ done: false, toGo: 'Pre-employment training first' });
    await ownerQuery(`INSERT INTO qualifications (company_id, employee_id, type, name, completion_date) VALUES ($1, $2, 'pre_employment', 'TSF pre-employment training', current_date)`, [w.a.companyId, guardId]);
    expect(await step()).toMatchObject({ done: true });
  });

  it('another company sees none of it', async () => {
    const bAdmin = await w.login('admin@b.test');
    const b = (await w.http().get('/api/wire/store').set(auth(bAdmin))).body;
    expect(b.aiming).toHaveLength(0);
    expect(b.handins).toHaveLength(0);
    expect((await w.http().post(`/api/wire/handins/${randomUUID()}/supply`).set(auth(bAdmin))).status).toBe(409);
  });
});
