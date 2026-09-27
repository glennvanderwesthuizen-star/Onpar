import { randomUUID } from 'node:crypto';
import { sastDate } from '@onpar/rules';
import { enrol, enrolmentData, ownerQuery, setupWorld, World } from './helpers';

/** Milestone 7: re-orders and issued kit (section 6.7, scenario 12). */
describe('re-orders and kit', () => {
  let w: World;
  let admin: string;
  let supervisor: string;
  let deviceToken: string;
  let guardToken: string;
  let employeeId: string;
  let driver: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const guard = () => ({ 'X-Device-Token': deviceToken, Authorization: `Bearer ${guardToken}` });
  const now = () => new Date().toISOString();
  const reorder = (body: Record<string, unknown>) =>
    w.http().post('/api/device/reorders').set(guard()).send({ eventId: randomUUID(), trustedAt: now(), deviceClock: now(), ...body });
  const act = (id: string, action: string, body: Record<string, unknown> = {}) => w.http().post(`/api/reorders/${id}/${action}`).set(auth(supervisor)).send(body);
  const received = (id: string) => w.http().post(`/api/device/reorders/${id}/received`).set(guard()).send({ eventId: randomUUID(), trustedAt: now(), deviceClock: now() });

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    supervisor = await w.login('supervisor@a.test');
    // Enrolment issues a size L shirt (from the test helper) dated 1 Sep 2026.
    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    employeeId = o.body.officer.id;
    deviceToken = (await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Device 001', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Gate 2' })).body.deviceToken;
    guardToken = (await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: '0001', pin: o.body.initialPin })).body.token;
    driver = (await w.http().post('/api/people').set(auth(supervisor)).send({ name: 'Sizwe Ndlovu', role: 'Stores driver', phone: '082 555 0123', kind: 'internal' })).body.id;
  });
  afterAll(() => w.app.close());

  it("shows the guard their own issued kit", async () => {
    const r = await w.http().get('/api/device/kit').set(guard());
    expect(r.body.map((k: { item: string }) => k.item)).toEqual(['Radio', 'Shirt']);
  });

  let shirtOrder: string;
  it('fills in the shirt size from the profile (scenario 12)', async () => {
    const shirt = (await w.http().get('/api/device/kit').set(guard())).body.find((k: { item: string }) => k.item === 'Shirt');
    expect((await reorder({ kind: 'personal', issuedItemId: shirt.id, comment: '' })).status).toBe(400);
    const r = await reorder({ kind: 'personal', issuedItemId: shirt.id, comment: 'Torn while chasing a suspect over the fence' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ number: 1, item: 'Shirt', size: 'L' });
    shirtOrder = r.body.id;
  });

  it("refuses another officer's issued item", async () => {
    const other = await enrol(w, admin, enrolmentData(w.a.siteId, { idNumber: '9202204720083', fullName: 'Mary Dube' }));
    const [theirs] = await ownerQuery(`SELECT id FROM issued_items WHERE employee_id = $1 AND item = 'Shirt'`, [other.body.officer.id]);
    const r = await reorder({ kind: 'personal', issuedItemId: theirs.id, comment: 'Not mine to order' });
    expect(r.status).toBe(400);
    expect(r.body.errors.issuedItemId).toBeDefined();
  });

  it('takes a free-text site re-order', async () => {
    const r = await reorder({ kind: 'site', item: 'Toilet paper', quantity: '2 packs' });
    expect(r.body).toMatchObject({ number: 2, item: 'Toilet paper' });
    const list = (await w.http().get('/api/reorders').set(auth(supervisor))).body;
    expect(list.counts).toMatchObject({ open: 2, waiting: 2 });
  });

  it('does not let the guard confirm receipt before it is ordered', async () => {
    expect((await received(shirtOrder)).status).toBe(409);
  });

  it('moves through Ordered, Assigned and Delivered, each with who, role, note and time', async () => {
    expect((await act(shirtOrder, 'delivered')).status).toBe(409);
    expect((await act(shirtOrder, 'ordered', { note: 'Ordered from Uniforms SA, order 5521' })).status).toBe(201);
    expect((await act(shirtOrder, 'assigned', {})).status).toBe(400);
    expect((await act(shirtOrder, 'assigned', { assigneePersonId: driver, note: 'Thursday stores run' })).status).toBe(201);
    expect((await act(shirtOrder, 'delivered', { note: 'Left with the guard at Gate 2' })).status).toBe(201);
  });

  it('is received on the device, and the shirt’s issue date updates (scenario 12)', async () => {
    expect((await received(shirtOrder)).status).toBe(200);
    const [shirt] = await ownerQuery(`SELECT issue_date FROM issued_items WHERE employee_id = $1 AND item = 'Shirt'`, [employeeId]);
    expect(shirt.issue_date).toBe(sastDate(new Date()));
    const d = (await w.http().get(`/api/reorders/${shirtOrder}`).set(auth(supervisor))).body;
    expect(d.stage).toBe('received');
    expect(d.history.map((h: { stage: string }) => h.stage)).toEqual(['requested', 'ordered', 'assigned', 'delivered', 'received']);
    expect(d.history[2]).toMatchObject({ actorLabel: 'Peter Supervisor', actorRole: 'Site supervisor', assigneeName: 'Sizwe Ndlovu', note: 'Thursday stores run' });
    expect(d.history[4]).toMatchObject({ actorLabel: 'John Smith', actorRole: 'Security officer' });
    expect((await received(shirtOrder)).status).toBe(409);
    await expect(ownerQuery(`UPDATE reorder_history SET note = 'x'`)).rejects.toThrow(/immutable/);
  });

  it('lets the company change its kit list, and a supervisor issue kit', async () => {
    expect((await w.http().put('/api/kit/catalogue').set(auth(supervisor)).send({ items: [{ name: 'Shirt', tracking: 'size' }] })).status).toBe(403);
    const r = await w.http().put('/api/kit/catalogue').set(auth(admin)).send({ items: [{ name: 'Shirt', tracking: 'size' }, { name: 'Body camera', tracking: 'asset' }] });
    expect(r.body.map((k: { name: string }) => k.name)).toEqual(['Shirt', 'Body camera']);
    const issue = await w.http().post(`/api/officers/${employeeId}/issued-items`).set(auth(supervisor)).send({ item: 'Body camera', assetNumber: 'CAM-007', issueDate: '2026-09-20' });
    expect(issue.status).toBe(201);
    const kit = (await w.http().get('/api/device/kit').set(guard())).body.map((k: { item: string }) => k.item);
    expect(kit).toContain('Body camera');
  });

  it("keeps re-orders inside the company (scenario 14)", async () => {
    const b = await w.login('manager@b.test');
    expect((await w.http().get('/api/reorders').set(auth(b))).body.rows).toEqual([]);
    expect((await w.http().get(`/api/reorders/${shirtOrder}`).set(auth(b))).status).toBe(404);
  });
});
