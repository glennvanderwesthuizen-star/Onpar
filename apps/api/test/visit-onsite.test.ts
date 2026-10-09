import { randomUUID } from 'node:crypto';
import { DEFAULT_VISITOR_SETTINGS } from '@onpar/rules';
import { NotificationsService, PushResult, PushSender } from '../src/notifications/notifications.service';
import { VisitOnSiteService } from '../src/visitors/visit-onsite.service';
import { enrol, enrolmentData, ownerQuery, PNG, setupWorld, World } from './helpers';

class QuietSender implements PushSender {
  async send(): Promise<PushResult> {
    return { ok: true };
  }
}

/** Visitor management, step 6 (plan approved 7 Oct 2026): who is on site, overstays and the shift handover. */
describe('visitor management: on-site list, overstays and handover', () => {
  let w: World;
  let admin: string;
  let supervisor: string;
  let bAdmin: string;
  let deviceToken: string;
  let john: { token: string; pin: string };
  let peter: { token: string; pin: string };
  let onceOff: string;
  let regular: string;
  let contractor: string;
  let unit14: string;
  let unit20: string;
  let thabo: { id: string; token: string };
  let nomsa: { id: string; token: string };
  let seq = 0;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const g = (who = john) => ({ 'X-Device-Token': deviceToken, Authorization: `Bearer ${who.token}` });
  const site = () => `/api/sites/${w.a.siteId}`;
  const now = () => new Date().toISOString();
  /** A visitor let in. `hoursAgo` moves the entry back in time. */
  const letIn = async (data: Record<string, unknown> = {}, hoursAgo = 0) => {
    seq += 1;
    const person = { idNumber: `P${String(seq).padStart(8, '0')}`, surname: `Visitor${seq}`, names: 'T', document: 'id_card', method: 'scan' };
    const vehicle = { registration: `CA88${seq}`, make: 'Toyota', model: 'Corolla', colour: 'White', vin: '', discExpiry: null, method: 'scan' };
    const res = await w.http().post('/api/device/visitors').set(g()).field('data', JSON.stringify({ eventId: randomUUID(), type: 'vehicle', person, vehicle, pax: 1, categoryId: onceOff, unitId: unit14, trustedAt: now(), deviceClock: now(), ...data }));
    if (res.status !== 200) throw new Error(`arrive failed: ${res.status} ${JSON.stringify(res.body)}`);
    const id = res.body.id as string;
    const who = (data.unitId ?? unit14) === unit14 ? thabo : nomsa;
    await w.http().post(`/api/customer/visits/${id}/decide`).set(auth(who.token)).send({ decision: 'accept' });
    if (hoursAgo) await ownerQuery(`UPDATE visits SET entry_at = now() - make_interval(hours => $2) WHERE id = $1`, [id, hoursAgo]);
    return { id, name: `Visitor${seq}, T`, registration: vehicle.registration };
  };
  const onSite = async (who = john) => (await w.http().get('/api/device/visitors/on-site').set(g(who))).body;
  const act = (id: string, action: string, note = '', extra: Record<string, unknown> = {}, who = john) =>
    w.http().post(`/api/device/visitors/${id}/overstay`).set(g(who)).send({ eventId: randomUUID(), action, note, ...extra });
  const duty = (who: { token: string; pin: string }, kind: string) => w.http().post('/api/device/duty').set(g(who)).send({ eventId: randomUUID(), kind, pin: who.pin, trustedAt: now(), deviceClock: now() });
  const setupOf = async (who = john) => (await w.http().get('/api/device/visitors/setup').set(g(who))).body;
  const staffAlerts = async () => {
    await w.app.get(NotificationsService).settled();
    return (await w.http().get('/api/notifications').set(auth(supervisor))).body.alerts as { kind: string; title: string; body: string }[];
  };
  const customer = async (body: Record<string, unknown>) => {
    const r = await w.http().post(`${site()}/customers`).set(auth(admin)).send(body);
    await ownerQuery('UPDATE customers SET must_change_password = false WHERE id = $1', [r.body.id]);
    return { id: r.body.id as string, token: await w.login(body.email as string, r.body.temporaryPassword) };
  };
  const guardOn = async (fullName: string, idNumber: string) => {
    const o = await enrol(w, admin, enrolmentData(w.a.siteId, { fullName, idNumber }));
    return { pin: o.body.initialPin as string, token: (await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: o.body.officer.employeeNumber, pin: o.body.initialPin })).body.token as string };
  };

  beforeAll(async () => {
    w = await setupWorld();
    w.app.get(NotificationsService).sender = new QuietSender();
    admin = await w.login('admin@a.test');
    supervisor = await w.login('supervisor@a.test');
    bAdmin = await w.login('admin@b.test');
    const d = await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Gate phone', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Main gate' });
    deviceToken = d.body.deviceToken;
    john = await guardOn('John Smith', '8001015009087');
    peter = await guardOn('Peter Peters', '9202204720083');
    const gateId = (await w.http().post(`${site()}/gates`).set(auth(admin)).send({ name: 'Main gate' })).body.id;
    await w.http().put(`${site()}/gate-phones/${d.body.device.id}`).set(auth(admin)).send({ gateId });
    unit14 = (await w.http().post(`${site()}/units`).set(auth(admin)).send({ name: '14' })).body.id;
    unit20 = (await w.http().post(`${site()}/units`).set(auth(admin)).send({ name: '20' })).body.id;
    const cats = (await w.http().get(`${site()}/visitor-setup`).set(auth(admin))).body.categories as { id: string; name: string }[];
    regular = cats.find((c) => c.name === 'Visitor')!.id; // no time limit
    contractor = cats.find((c) => c.name === 'Contractor')!.id; // gone by 18:00
    // A site may still give a kind of visitor a limit in hours: this one has four.
    onceOff = (await w.http().post(`${site()}/visitor-categories`).set(auth(admin)).send({ name: 'Short visit', limitMinutes: 240 })).body.id;
    thabo = await customer({ kind: 'tenant', fullName: 'Thabo Tenant', email: 'thabo@home.test', unitId: unit14, phone: '082 555 0140' });
    nomsa = await customer({ kind: 'tenant', fullName: 'Nomsa Other', email: 'nomsa@home.test', unitId: unit20 });
  });
  afterAll(() => w.app.close());

  let fresh: { id: string; name: string };
  let late: { id: string; name: string };
  let noLimit: { id: string; name: string };

  it('lists everyone on site with time on site, overstays first and marked', async () => {
    fresh = await letIn();
    late = await letIn({}, 5); // short visit: 4 hours
    noLimit = await letIn({ categoryId: regular, unitId: unit20 }, 30);
    const list = await onSite();
    expect(list).toMatchObject({ onSite: 3, overstays: 1 });
    expect(list.visitors.map((v: { id: string }) => v.id)).toEqual([late.id, noLimit.id, fresh.id]);
    expect(list.visitors[0]).toMatchObject({ visitor: late.name, vehicle: expect.stringContaining('White Toyota Corolla'), pax: 1, visiting: 'Unit 14', category: 'Short visit', overdue: true, needsAction: true, action: null });
    expect(list.visitors[0].stay).toMatch(/^5 h 0\d min$/);
    expect(list.visitors[0].overBy).toMatch(/^1 h 0\d min$/);
    expect(list.visitors[1]).toMatchObject({ dueAt: null, overdue: false, stay: '1 day 6 h' });
    expect(JSON.stringify(list)).not.toMatch(/P0000/);
    expect((await setupOf()).counts).toEqual({ onSite: 3, overstays: 1, needAction: 1 });
  });

  it('shows the supervisor the same list, and a customer only their own visitors', async () => {
    const staff = await w.http().get(`${site()}/visitors-on-site`).set(auth(supervisor));
    expect(staff.body).toMatchObject({ onSite: 3, overstays: 1 });
    expect(staff.body.visitors[0]).toMatchObject({ visitor: late.name, overdue: true });
    expect((await w.http().get(`${site()}/visitors-on-site`).set(auth(bAdmin))).status).toBe(404);
    const mine = (await w.http().get('/api/customer/visits').set(auth(thabo.token))).body.onSite;
    expect(mine.map((v: { id: string }) => v.id)).toEqual([late.id, fresh.id]);
    expect(mine[0]).toMatchObject({ visitor: late.name, overdue: true });
    expect((await w.http().get('/api/customer/visits').set(auth(nomsa.token))).body.onSite.map((v: { id: string }) => v.id)).toEqual([noLimit.id]);
  });

  it('tells the supervisor only when the guard has not dealt with an overstay in the site’s time', async () => {
    const svc = w.app.get(VisitOnSiteService);
    const t0 = new Date();
    expect(await svc.tick(t0)).toBe(0); // first noticed: the gate shows it; nobody else is told
    expect(await svc.tick(new Date(t0.getTime() + 29 * 60_000))).toBe(0);
    expect(await svc.tick(new Date(t0.getTime() + 31 * 60_000))).toBe(1);
    expect(await svc.tick(new Date(t0.getTime() + 60 * 60_000))).toBe(0); // told once
    const [a] = await staffAlerts();
    expect(a).toMatchObject({ kind: 'visitor_overstay', title: 'Visitor overstay at Estate ABC' });
    expect(a.body).toMatch(new RegExp(`^${late.name}, visiting unit 14, is 1 h \\d\\d min past their time and the gate has not dealt with it\\.$`));
    // One the guard confirms in time is never sent on.
    const second = await letIn({ categoryId: contractor }, 30); // contractors: gone by 18:00
    const t1 = new Date();
    await svc.tick(t1);
    expect((await act(second.id, 'confirmed', '')).status).toBe(400);
    expect((await act(second.id, 'confirmed', 'Tenant says he is still fitting the geyser.')).status).toBe(200);
    expect(await svc.tick(new Date(t1.getTime() + 45 * 60_000))).toBe(0);
    const row = (await onSite()).visitors.find((v: { id: string }) => v.id === second.id);
    expect(row).toMatchObject({ overdue: true, needsAction: false, action: { action: 'confirmed', label: 'Confirmed still on site', note: 'Tenant says he is still fitting the geyser.', by: expect.stringContaining('Smith') } });
    expect((await setupOf()).counts).toEqual({ onSite: 4, overstays: 2, needAction: 1 });
  });

  it('lets the guard phone the customer about an overstay without seeing the number, and only about an overstay', async () => {
    const r = await act(late.id, 'dialled');
    expect(r.body).toEqual({ ok: true, number: '082 555 0140', label: 'Unit 14' });
    expect((await act(fresh.id, 'dialled')).status).toBe(409);
    expect((await act(fresh.id, 'confirmed', 'Still here.')).status).toBe(409);
    // A phone call alone does not deal with it.
    expect((await onSite()).visitors.find((v: { id: string }) => v.id === late.id)).toMatchObject({ needsAction: true, action: { action: 'dialled' } });
    const [audit] = await ownerQuery(`SELECT after FROM audit_log WHERE action = 'visit.overstay_dialled' AND entity_id = $1`, [late.id]);
    // Random IDs can contain these digits by chance, so they are taken out before looking for the number.
    expect(JSON.stringify(audit.after).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '')).not.toMatch(/082|0140/);
  });

  it('marks a visitor as left without scan-out, as an exception for the supervisor', async () => {
    const gone = await letIn();
    const eventId = randomUUID();
    expect((await act(gone.id, 'left', '')).status).toBe(400);
    const send = () => w.http().post(`/api/device/visitors/${gone.id}/overstay`).set(g()).send({ eventId, action: 'left', note: 'Tenant says she left at lunch.' });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200); // sent twice, saved once
    expect(await ownerQuery('SELECT status FROM visits WHERE id = $1', [gone.id])).toEqual([{ status: 'left_no_scan_out' }]);
    expect(await ownerQuery('SELECT type, reason, note FROM visit_exceptions WHERE visit_id = $1', [gone.id])).toEqual([{ type: 'no_scan_out', reason: 'not_scanned_out', note: 'Tenant says she left at lunch.' }]);
    expect((await onSite()).visitors.map((v: { id: string }) => v.id)).not.toContain(gone.id);
    expect((await staffAlerts())[0].body).toBe(`${gone.name}, visiting unit 14, was marked at Main gate as having left without being scanned out.`);
    expect((await act(gone.id, 'left', 'Again, later.')).status).toBe(409);
  });

  describe('the shift handover', () => {
    let handoverId: string;

    it('keeps a gate guard on duty until he has handed the visitors over', async () => {
      expect((await duty(john, 'duty_on')).status).toBe(200);
      // No relief is rostered in this test, so the wait for a relief is taken out of the way.
      await ownerQuery('UPDATE attendance SET scheduled_end = NULL WHERE duty_from_at IS NULL');
      const me = (await w.http().get('/api/device/me').set(g())).body;
      expect(me.attendance.visitorHandoverOwed).toBe(true);
      const refused = await duty(john, 'duty_from');
      expect(refused.status).toBe(409);
      expect(refused.body.message).toBe('Hand over the visitors first: tap Visitors, then Hand over shift. Then log Duty From.');
    });

    it('shows the list with overstays at the top, and will not sign off until each has an action', async () => {
      const h = (await w.http().post('/api/device/visitors/handover/start').set(g())).body;
      handoverId = h.id;
      // An earlier confirmation does not count: each overstay needs an action in this handover.
      expect(h).toMatchObject({ onSite: 4, overstays: 2, todo: 2, canSignOff: false });
      expect(h.visitors.slice(0, 2).every((v: { overdue: boolean; todo: boolean }) => v.overdue && v.todo)).toBe(true);
      expect((await w.http().post('/api/device/visitors/handover/start').set(g())).body.id).toBe(handoverId); // the same one again
      const early = await w.http().post(`/api/device/visitors/handover/${handoverId}/sign-off`).set(g());
      expect(early.status).toBe(409);
      expect(early.body.message).toBe('2 visitors are past their time. Deal with each one before you sign off.');
      // Somebody else cannot act in, or sign off, John's handover.
      expect((await act(late.id, 'dialled', '', { handoverId }, peter)).status).toBe(404);
      expect((await w.http().post(`/api/device/visitors/handover/${handoverId}/sign-off`).set(g(peter))).status).toBe(404);
    });

    it('saves the handover with the count and every note, and tells the supervisor of an unresolved overstay', async () => {
      const contractorVisit = (await onSite()).visitors.find((v: { category: string }) => v.category === 'Contractor');
      expect((await act(late.id, 'dialled', '', { handoverId })).status).toBe(200);
      expect((await act(contractorVisit.id, 'confirmed', 'Still busy in unit 14, tenant confirmed by phone.', { handoverId })).status).toBe(200);
      const view = (await w.http().post('/api/device/visitors/handover/start').set(g())).body;
      expect(view).toMatchObject({ todo: 0, canSignOff: true });
      const done = await w.http().post(`/api/device/visitors/handover/${handoverId}/sign-off`).set(g());
      expect(done.body).toEqual({ ok: true, id: handoverId });
      expect((await w.http().post(`/api/device/visitors/handover/${handoverId}/sign-off`).set(g())).status).toBe(200);
      const [row] = await ownerQuery('SELECT on_site_count, overstay_count, unresolved_count, jsonb_array_length(snapshot) AS n FROM visit_handovers WHERE id = $1', [handoverId]);
      expect(row).toEqual({ on_site_count: 4, overstay_count: 2, unresolved_count: 1, n: 4 });
      const [a] = await staffAlerts();
      expect(a.kind).toBe('visitor_handover');
      expect(a.body).toMatch(/Smith handed over at Main gate with 1 overstay unresolved: the customer was phoned, with no result\.$/);
      // Signed off: nothing more can be added to it.
      expect((await act(late.id, 'confirmed', 'Too late.', { handoverId })).status).toBe(409);
    });

    it('then lets him log Duty From', async () => {
      expect((await w.http().get('/api/device/me').set(g())).body.attendance.visitorHandoverOwed).toBe(false);
      expect((await duty(john, 'duty_from')).status).toBe(200);
    });

    it('gives the incoming guard the handover to read and acknowledge, once', async () => {
      expect((await setupOf(john)).handover).toBeNull(); // not to the guard who handed over
      const h = (await setupOf(peter)).handover;
      expect(h).toMatchObject({ id: handoverId, onSite: 4, overstays: 2, unresolved: 1, from: expect.stringContaining('Smith') });
      expect(h.notes).toEqual([
        { visitor: expect.any(String), vehicle: expect.any(String), visiting: 'Unit 14', overBy: expect.any(String), action: 'Confirmed still on site', note: 'Still busy in unit 14, tenant confirmed by phone.' },
        { visitor: late.name, vehicle: expect.any(String), visiting: 'Unit 14', overBy: expect.any(String), action: 'Dialled the customer', note: '' },
      ]);
      const ack = (who: { token: string; pin: string }) => w.http().post(`/api/device/visitors/handover/${handoverId}/acknowledge`).set(g(who));
      expect((await ack(john)).status).toBe(409);
      expect((await ack(peter)).status).toBe(200);
      expect((await ack(peter)).status).toBe(200);
      expect((await setupOf(peter)).handover).toBeNull();
      const [row] = await ownerQuery('SELECT incoming_guard IS NOT NULL AS acked FROM visit_handovers WHERE id = $1', [handoverId]);
      expect(row.acked).toBe(true);
    });

    it('carries a confirmation made in the handover into the next shift, but not one from before it', async () => {
      const list = (await onSite(peter)).visitors;
      expect(list.find((v: { category: string }) => v.category === 'Contractor')).toMatchObject({ overdue: true, needsAction: false });
      expect(list.find((v: { id: string }) => v.id === late.id)).toMatchObject({ overdue: true, needsAction: true });
    });

    it('shows the supervisor the handovers, with both guards and the notes', async () => {
      const list = (await w.http().get(`${site()}/visit-handovers`).set(auth(supervisor))).body;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: handoverId, gateName: 'Main gate', onSite: 4, overstays: 2, unresolved: 1, outgoing: expect.stringContaining('Smith'), incoming: expect.stringContaining('Peters') });
      expect(list[0].notes).toHaveLength(2);
      expect((await w.http().get(`${site()}/visit-handovers`).set(auth(bAdmin))).status).toBe(404);
      const audits = await ownerQuery(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id`, [handoverId]);
      expect(audits.map((a) => a.action)).toEqual(['visit_handover.start', 'visit_handover.sign_off', 'visit_handover.acknowledge']);
    });

    it('does not ask a guard on an ordinary post phone for a visitor handover', async () => {
      const d = await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Post phone', serialOrImei: '356938035643817', siteId: w.a.siteId, postName: 'Patrol' });
      const login = await w.http().post('/api/device/login').set('X-Device-Token', d.body.deviceToken).send({ employeeNumber: (await ownerQuery(`SELECT employee_number FROM employees WHERE full_name LIKE '%Peters%'`))[0].employee_number, pin: peter.pin });
      const p = { 'X-Device-Token': d.body.deviceToken, Authorization: `Bearer ${login.body.token}` };
      const at = now();
      expect((await w.http().post('/api/device/duty').set(p).send({ eventId: randomUUID(), kind: 'duty_on', pin: peter.pin, trustedAt: at, deviceClock: at })).status).toBe(200);
      await ownerQuery('UPDATE attendance SET scheduled_end = NULL WHERE duty_from_at IS NULL');
      expect((await w.http().get('/api/device/me').set(p)).body.attendance.visitorHandoverOwed).toBe(false);
      const off = await w.http().post('/api/device/duty').set(p).send({ eventId: randomUUID(), kind: 'duty_from', pin: peter.pin, trustedAt: now(), deviceClock: now() });
      expect([off.status, off.body.message]).toEqual([200, undefined]);
    });
  });

  it('marks nobody as an overstay when the site has switched the check off', async () => {
    await w.http().put(`${site()}/visitor-settings`).set(auth(admin)).send({ ...DEFAULT_VISITOR_SETTINGS, checks: { ...DEFAULT_VISITOR_SETTINGS.checks, overstayAlert: false } });
    expect(await onSite()).toMatchObject({ onSite: 4, overstays: 0 });
    expect(await w.app.get(VisitOnSiteService).tick(new Date(Date.now() + 86_400_000))).toBe(0);
    await w.http().put(`${site()}/visitor-settings`).set(auth(admin)).send(DEFAULT_VISITOR_SETTINGS);
  });

  it('gives a customer the history of their own visitors, with anything that did not match', async () => {
    const h = (await w.http().get('/api/customer/visits/history').set(auth(thabo.token))).body as { visitor: string; statusLabel: string; exceptions: string[]; exitAt: string | null }[];
    expect(h.length).toBeGreaterThanOrEqual(4);
    expect(h.find((v) => v.statusLabel === 'Left without scan-out')).toMatchObject({ exceptions: ['Left without scan-out'], outcome: 'Left without being scanned out' });
    expect(h.every((v) => v.visitor.startsWith('Visitor'))).toBe(true);
    expect(JSON.stringify(h)).not.toMatch(/P0000/);
    expect((await w.http().get('/api/customer/visits/history').set(auth(nomsa.token))).body).toHaveLength(1);
  });

  describe('contractors (owner, 7 Oct 2026): registered by the customer, counted in, and asked about automatically', () => {
    const svc = () => w.app.get(VisitOnSiteService);
    const register = (body: Record<string, unknown>) =>
      w.http().post('/api/customer/passes').set(auth(thabo.token)).send({ kind: 'ongoing', visitorName: 'Fix It Plumbing', contractor: true, visitDate: null, ...body });
    const myAlerts = async () => {
      await w.app.get(NotificationsService).settled();
      return (await w.http().get('/api/notifications').set(auth(thabo.token))).body.alerts as { kind: string; title: string; body: string; url: string }[];
    };
    const arrive = (data: Record<string, unknown>) => {
      seq += 1;
      const person = { idNumber: `P${String(seq).padStart(8, '0')}`, surname: `Plumber${seq}`, names: 'T', document: 'id_card', method: 'scan' };
      return w.http().post('/api/device/visitors').set(g()).field('data', JSON.stringify({ eventId: randomUUID(), type: 'vehicle', person, pax: 1, trustedAt: now(), deviceClock: now(), ...data }));
    };
    const van = (registration: string) => ({ registration, make: 'Isuzu', model: 'KB', colour: 'White', vin: '', discExpiry: null, method: 'scan' });
    let visitId: string;

    it('treats anyone who arrives unannounced as a visitor, without the guard choosing a kind', async () => {
      const r = await arrive({ vehicle: van('ZN 1'), unitId: unit14 });
      expect(r.body.status).toBe('awaiting_approval');
      const [v] = await ownerQuery('SELECT c.name FROM visits v JOIN visitor_categories c ON c.id = v.category_id WHERE v.id = $1', [r.body.id]);
      expect(v.name).toBe('Visitor');
      await w.http().post(`/api/customer/visits/${r.body.id}/decide`).set(auth(thabo.token)).send({ decision: 'refuse' });
    });

    it('needs the contractor’s cell number and the number of workers the customer approves', async () => {
      expect((await register({ registration: 'ND 700' })).body.errors).toEqual({ cell: 'Enter the contractor’s cell number.', maxWorkers: 'Enter how many workers may come with them (0 if none).' });
      const made = await register({ registration: 'ND 700', cell: '083 555 0700', maxWorkers: 2 });
      expect(made.status).toBe(201);
      const mine = (await w.http().get('/api/customer/passes').set(auth(thabo.token))).body.current.find((p: { id: string }) => p.id === made.body.id);
      // No time given: the site's time for contractors.
      expect(mine).toMatchObject({ visitorName: 'Fix It Plumbing', category: 'Contractor', contractor: true, maxWorkers: 2, leaveBy: '18:00' });
      const found = (await w.http().post('/api/device/visitors/check').set(g()).send({ registration: 'ND700' })).body.expected;
      expect(found).toMatchObject({ visitorName: 'Fix It Plumbing', category: 'Contractor', contractor: true, maxWorkers: 2, leaveBy: '18:00', regular: true });
    });

    it('lets the contractor in with the workers approved, and asks the customer when there are more', async () => {
      const passId = (await w.http().post('/api/device/visitors/check').set(g()).send({ registration: 'ND700' })).body.expected.passId;
      const many = await arrive({ vehicle: van('ND 700'), passId, pax: 3 });
      expect(many.body.status).toBe('awaiting_approval');
      expect((await myAlerts())[0]).toMatchObject({ kind: 'visitor_request', body: expect.stringContaining('Your contractor has 3 workers with them; you approved 2. Open to accept or refuse.') });
      const [row] = await ownerQuery('SELECT checks, announced, pass_id FROM visits WHERE id = $1', [many.body.id]);
      expect(row).toMatchObject({ announced: false, pass_id: passId, checks: { extraWorkers: { approved: 2, arrived: 3 } } });
      await w.http().post(`/api/customer/visits/${many.body.id}/decide`).set(auth(thabo.token)).send({ decision: 'refuse' });
      const ok = await arrive({ vehicle: van('ND 700'), passId, pax: 2 });
      expect(ok.body.status).toBe('on_site');
      visitId = ok.body.id;
      expect((await onSite(peter)).visitors.find((v: { id: string }) => v.id === visitId)).toMatchObject({ category: 'Contractor', contractor: true, pax: 2, overdue: false, customerSays: null });
    });

    it('asks the customer, automatically and once, when the contractor is still on site at the time to be gone by', async () => {
      await ownerQuery(`UPDATE visits SET entry_at = now() - interval '30 hours' WHERE id = $1`, [visitId]);
      const before = (await myAlerts()).filter((a) => a.kind === 'visitor_still_on_site').length;
      await svc().tick(new Date());
      await svc().tick(new Date());
      const asked = (await myAlerts()).filter((a) => a.kind === 'visitor_still_on_site');
      // The other overstay in this unit is asked about too, once each.
      expect(asked.length - before).toBeGreaterThanOrEqual(1);
      const mine = asked.find((a) => a.url === `/c/visits/${visitId}`)!;
      expect(mine).toMatchObject({ title: 'Your contractor is still on site' });
      expect(mine.body).toMatch(/^Plumber\d+, T was due to leave by 18:00 and has not been scanned out\. Open to tell the gate: still busy, or should have left\.$/);
      expect(asked.filter((a) => a.url === `/c/visits/${visitId}`)).toHaveLength(1);
      const seen = (await w.http().get(`/api/customer/visits/${visitId}`).set(auth(thabo.token))).body;
      expect(seen.stay).toMatchObject({ overdue: true, says: null, contractor: true });
    });

    it('moves the time when the customer says "still busy until", and asks again when that passes', async () => {
      const stay = (who: { token: string }, body: Record<string, unknown>) => w.http().post(`/api/customer/visits/${visitId}/stay`).set(auth(who.token)).send(body);
      expect((await stay(nomsa, { answer: 'extended', until: '21:00' })).status).toBe(404);
      expect((await stay(thabo, { answer: 'extended' })).status).toBe(400);
      const until = new Date(Date.now() + 2 * 3600_000 + 2 * 3600_000).toISOString().slice(11, 16); // two hours from now, South African time
      const r = await stay(thabo, { answer: 'extended', until });
      expect(r.status).toBe(200);
      expect(r.body.stay).toMatchObject({ overdue: false, says: `Still busy until ${until}` });
      expect((await onSite(peter)).visitors.find((v: { id: string }) => v.id === visitId)).toMatchObject({ overdue: false, needsAction: false, customerSays: `Still busy until ${until}` });
      // Not past their time now, so "should have left" is not an answer yet.
      expect((await stay(thabo, { answer: 'should_have_left' })).status).toBe(409);
      await svc().tick(new Date(Date.now() + 3 * 3600_000));
      expect((await myAlerts()).filter((a) => a.url === `/c/visits/${visitId}` && a.kind === 'visitor_still_on_site')).toHaveLength(2);
    });

    it('shows the gate in red, and tells the supervisor at once, when the customer says he should have left', async () => {
      await ownerQuery(`UPDATE visits SET leave_by = now() - interval '10 minutes' WHERE id = $1`, [visitId]);
      const r = await w.http().post(`/api/customer/visits/${visitId}/stay`).set(auth(thabo.token)).send({ answer: 'should_have_left' });
      expect(r.status).toBe(200);
      expect(r.body.stay).toMatchObject({ overdue: true, says: 'Should have left' });
      expect((await onSite(peter)).visitors.find((v: { id: string }) => v.id === visitId)).toMatchObject({ overdue: true, needsAction: true, customerSays: 'Should have left' });
      const [a] = await staffAlerts();
      expect(a.kind).toBe('visitor_overstay');
      expect(a.body).toMatch(/^Plumber\d+, T, visiting unit 14, is \d+ min past their time\. Thabo Tenant says they should have left\.$/);
      expect(await ownerQuery(`SELECT answer FROM visit_stay_answers WHERE visit_id = $1 ORDER BY at`, [visitId])).toEqual([{ answer: 'extended' }, { answer: 'should_have_left' }]);
    });
  });
});

