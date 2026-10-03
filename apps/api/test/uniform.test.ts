import { randomUUID } from 'node:crypto';
import { sastDate } from '@onpar/rules';
import { enrol, enrolmentData, ownerQuery, setupWorld, World } from './helpers';

/**
 * Uniform (owner's decision D-33): catalogue and site list, the guard's order from the post
 * phone, line-by-line approval with company and guard's account, stores, supervisor
 * collection, and the guard signing for it with his PIN.
 */
describe('uniform orders (D-33)', () => {
  let w: World;
  let admin: string;
  let manager: string;
  let supervisor: string;
  let stores: string;
  let managerB: string;
  let deviceToken: string;
  let guard: { id: string; pin: string; token: string };
  let shirt: string;
  let golf: string;
  let boots: string;
  let orderId: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const dev = () => ({ 'X-Device-Token': deviceToken, ...auth(guard.token) });
  const now = () => new Date().toISOString();
  const mine = async () => (await w.http().get('/api/device/uniform').set(dev())).body;
  const order = (lines: unknown[]) =>
    w.http().post('/api/device/uniform/orders').set(dev()).send({ eventId: randomUUID(), lines, trustedAt: now(), deviceClock: now() });

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    manager = await w.login('manager@a.test');
    supervisor = await w.login('supervisor@a.test');
    managerB = await w.login('manager@b.test');
    // A stores clerk (the new role).
    const s = await w.http().post('/api/users').set(auth(admin)).send({ email: 'stores@a.test', fullName: 'Nomsa Stores', role: 'stores_clerk' });
    expect(s.status).toBe(201);
    await ownerQuery("UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE email = 'manager@a.test'), must_change_password = false WHERE email = 'stores@a.test'");
    stores = await w.login('stores@a.test');
    deviceToken = (await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Gate phone', serialOrImei: '356938035643809', siteId: w.a.siteId })).body.deviceToken;
    const o = await enrol(w, admin, enrolmentData(w.a.siteId, { fullName: 'Michael Dube' }));
    const token = (await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: o.body.officer.employeeNumber, pin: o.body.initialPin })).body.token;
    guard = { id: o.body.officer.id, pin: o.body.initialPin, token };
  });
  afterAll(() => w.app.close());

  it('the company keeps a catalogue of items with types, sizes and prices', async () => {
    const r = await w.http().put('/api/uniform/items').set(auth(manager)).send({
      items: [
        { name: 'Shirt', variant: 'Short sleeve', sizes: ['S', 'M', 'L', 'XL'], priceCents: 25000 },
        { name: 'Shirt', variant: 'Golf', sizes: ['S', 'M', 'L', 'XL'], priceCents: 18000 },
        { name: 'Boots', sizes: ['6', '7', '8', '9', '10'], priceCents: 65000 },
      ],
    });
    expect(r.status).toBe(200);
    [shirt, golf, boots] = r.body.map((i: { id: string }) => i.id);
    // Only the catalogue roles may change it.
    expect((await w.http().put('/api/uniform/items').set(auth(supervisor)).send({ items: [] })).status).toBe(403);
  });

  it('each site has its own uniform list', async () => {
    const r = await w.http().put(`/api/uniform/sites/${w.a.siteId}/list`).set(auth(manager)).send({
      lines: [
        { itemId: shirt, quantity: 3 },
        { itemId: golf, quantity: 2 },
        { itemId: boots, quantity: 1 },
      ],
    });
    expect(r.status).toBe(200);
    expect((await w.http().get(`/api/uniform/sites/${w.a.siteId}/list`).set(auth(supervisor))).body).toHaveLength(3);
  });

  it('a starter issue starts the 12 months; the guard sees his kit table with what is due', async () => {
    const lastYear = sastDate(new Date(Date.now() - 400 * 86400_000));
    const recent = sastDate(new Date(Date.now() - 30 * 86400_000));
    expect((await w.http().post('/api/uniform/issues').set(auth(manager)).send({ employeeId: guard.id, itemId: shirt, size: 'L', quantity: 3, issuedOn: lastYear, note: 'Starter kit' })).status).toBe(201);
    expect((await w.http().post('/api/uniform/issues').set(auth(manager)).send({ employeeId: guard.id, itemId: boots, size: '9', quantity: 1, issuedOn: recent })).status).toBe(201);
    const { kit } = await mine();
    const byItem = Object.fromEntries(kit.map((k: { itemId: string }) => [k.itemId, k]));
    expect(byItem[shirt]).toMatchObject({ due: true, lastSize: 'L', entitled: 3 });
    expect(byItem[golf]).toMatchObject({ due: true, lastIssued: null });
    expect(byItem[boots]).toMatchObject({ due: false, lastSize: '9' });
  });

  it('the guard orders several items at once; one not yet due needs a reason', async () => {
    const noReason = await order([{ itemId: boots, size: '9', quantity: 1 }]);
    expect(noReason.status).toBe(400);
    expect(noReason.body.message).toMatch(/Not due until/);
    expect((await order([{ itemId: shirt, size: 'L', quantity: 4 }])).status).toBe(400); // more than his list allows
    const r = await order([
      { itemId: shirt, size: 'L', quantity: 3 },
      { itemId: golf, size: 'L', quantity: 2 },
      { itemId: boots, size: '9', quantity: 1, reason: 'Sole came off while on patrol' },
    ]);
    expect(r.status).toBe(200);
    orderId = r.body.id;
    // A second order while one waits for approval is refused.
    expect((await order([{ itemId: golf, size: 'L', quantity: 1 }])).status).toBe(409);
  });

  it('a manager decides each line: company account, guard account or not issued (with a reason)', async () => {
    const detail = (await w.http().get(`/api/uniform/orders/${orderId}`).set(auth(manager))).body;
    const line = (item: string) => detail.lines.find((l: { itemId: string }) => l.itemId === item).id;
    expect((await w.http().post(`/api/uniform/orders/${orderId}/decide`).set(auth(supervisor)).send({ lines: [] })).status).toBe(403);
    const missingReason = await w.http().post(`/api/uniform/orders/${orderId}/decide`).set(auth(manager)).send({
      lines: [
        { lineId: line(shirt), decision: 'company' },
        { lineId: line(golf), decision: 'declined' },
        { lineId: line(boots), decision: 'guard' },
      ],
    });
    expect(missingReason.status).toBe(400);
    const r = await w.http().post(`/api/uniform/orders/${orderId}/decide`).set(auth(manager)).send({
      lines: [
        { lineId: line(shirt), decision: 'company' },
        { lineId: line(golf), decision: 'declined', note: 'Golf shirts are for supervisors only' },
        { lineId: line(boots), decision: 'guard', note: 'Boots replaced early' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'approved', totals: { companyCents: 75000, guardCents: 65000 } });
  });

  it('stores marks it ready; the supervisor sees a task with when the guard is next on duty, and collects it', async () => {
    expect((await w.http().post(`/api/uniform/orders/${orderId}/collected`).set(auth(supervisor)).send({})).status).toBe(409);
    expect((await w.http().post(`/api/uniform/orders/${orderId}/ready`).set(auth(supervisor)).send({})).status).toBe(403);
    expect((await w.http().post(`/api/uniform/orders/${orderId}/ready`).set(auth(stores)).send({})).status).toBe(200);
    const tasks = (await w.http().get('/api/uniform/deliveries').set(auth(supervisor))).body;
    const t = tasks.find((x: { id: string }) => x.id === orderId);
    expect(t).toMatchObject({ status: 'ready', employeeName: 'Michael Dube' });
    expect(t.items).toContain('3 × Shirt (Short sleeve) L');
    expect(t.items).not.toContain('Golf');
    expect((await w.http().post(`/api/uniform/orders/${orderId}/collected`).set(auth(supervisor)).send({})).status).toBe(200);
    const h = await w.http().post(`/api/uniform/orders/${orderId}/handed-over`).set(auth(stores)).send({});
    expect(h.status).toBe(200);
    expect(h.body.handedOverBy).toBe('Nomsa Stores');
  });

  it('the guard signs for it with his PIN, agreeing to pay for the guard-account items; the 12 months restart', async () => {
    const { orders } = await mine();
    const o = orders.find((x: { id: string }) => x.id === orderId);
    expect(o).toMatchObject({ canReceive: true, guardCents: 65000 });
    expect(o.agreeStatement).toContain('R650.00');
    const sign = (body: Record<string, unknown>) =>
      w.http().post(`/api/device/uniform/orders/${orderId}/receive`).set(dev()).send({ trustedAt: now(), deviceClock: now(), ...body });
    expect((await sign({ pin: guard.pin })).status).toBe(400); // must agree to pay
    expect((await sign({ pin: guard.pin === '000000' ? '111111' : '000000', agreeToPay: true })).status).toBe(401);
    expect((await sign({ pin: guard.pin, agreeToPay: true })).status).toBe(200);
    const [row] = await ownerQuery('SELECT status, guard_agreed_cents, guard_agreed_statement FROM uniform_orders WHERE id = $1', [orderId]);
    expect(row).toMatchObject({ status: 'received', guard_agreed_cents: 65000 });
    const { kit } = await mine();
    const shirtRow = kit.find((k: { itemId: string }) => k.itemId === shirt);
    expect(shirtRow).toMatchObject({ due: false, lastIssued: sastDate(new Date()) });
    // Declined items are not issued.
    expect(kit.find((k: { itemId: string }) => k.itemId === golf).lastIssued).toBeNull();
  });

  it('keeps the history and the issue record unchangeable', async () => {
    const detail = (await w.http().get(`/api/uniform/orders/${orderId}`).set(auth(manager))).body;
    expect(detail.history.map((h: { statusAfter: string }) => h.statusAfter)).toEqual(['requested', 'approved', 'ready', 'with_supervisor', 'with_supervisor', 'received']);
    await expect(ownerQuery('DELETE FROM uniform_issues WHERE employee_id = $1', [guard.id])).rejects.toThrow();
    await expect(ownerQuery("UPDATE uniform_order_history SET note = 'x' WHERE order_id = $1", [orderId])).rejects.toThrow();
  });

  it('is never visible to another company', async () => {
    expect((await w.http().get(`/api/uniform/orders/${orderId}`).set(auth(managerB))).status).toBe(404);
    expect((await w.http().get('/api/uniform/orders').set(auth(managerB))).body).toEqual([]);
    expect((await w.http().get('/api/uniform/items').set(auth(managerB))).body).toEqual([]);
  });
});
