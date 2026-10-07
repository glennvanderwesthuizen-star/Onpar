import { DEFAULT_VISITOR_SETTINGS } from '@onpar/rules';
import { ownerQuery, setupWorld, World } from './helpers';

/** Visitor management, step 1 (plan approved 7 Oct 2026): gates, checks, time limits, categories and the barred list of a site. */
describe('visitor management: a site’s groundwork', () => {
  let w: World;
  let admin: string;
  let manager: string;
  let supervisor: string;
  let bAdmin: string;
  let main: string;
  let barredId: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const site = () => `/api/sites/${w.a.siteId}`;
  const setup = async (t = admin) => (await w.http().get(`${site()}/visitor-setup`).set(auth(t))).body;
  const audit = (action: string) => ownerQuery(`SELECT actor_label, before, after FROM audit_log WHERE action = $1 ORDER BY id DESC LIMIT 1`, [action]);

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    manager = await w.login('manager@a.test');
    supervisor = await w.login('supervisor@a.test');
    bAdmin = await w.login('admin@b.test');
  });
  afterAll(() => w.app.close());

  it('starts a site on the spec’s positions, with the two kinds of visitor and nothing else', async () => {
    const s = await setup();
    expect(s.gates).toEqual([]);
    expect(s.barred).toEqual([]);
    expect(s.settings).toEqual({ ...DEFAULT_VISITOR_SETTINGS, saved: false });
    expect(s.categories.map((c: { name: string; limitMinutes: number | null; limitUntil: string | null }) => [c.name, c.limitMinutes, c.limitUntil])).toEqual([
      ['Visitor', null, null],
      ['Contractor', null, '18:00'],
    ]);
    expect(s.checks).toHaveLength(12);
    // Looking twice does not make them twice.
    expect((await setup()).categories).toHaveLength(2);
  });

  it('adds gates to a site, each name once, and retires one without deleting it', async () => {
    const r = await w.http().post(`${site()}/gates`).set(auth(admin)).send({ name: 'Main gate' });
    expect(r.status).toBe(201);
    main = r.body.id;
    expect((await w.http().post(`${site()}/gates`).set(auth(admin)).send({ name: 'main GATE' })).status).toBe(409);
    const back = await w.http().post(`${site()}/gates`).set(auth(admin)).send({ name: 'Back gate' });
    expect((await w.http().put(`${site()}/gates/${back.body.id}`).set(auth(admin)).send({ name: 'Main gate', active: true })).status).toBe(409);
    expect((await w.http().put(`${site()}/gates/${back.body.id}`).set(auth(admin)).send({ name: 'Service gate', active: false })).status).toBe(200);
    expect((await setup()).gates.map((g: { name: string; active: boolean }) => [g.name, g.active])).toEqual([['Main gate', true], ['Service gate', false]]);
    const [a] = await audit('gate.update');
    expect(a).toEqual({ actor_label: 'Sam Admin', before: { name: 'Back gate', active: true }, after: { name: 'Service gate', active: false } });
  });

  it('lets only the administrator change anything; a company manager may look; nobody else sees it', async () => {
    expect((await w.http().get(`${site()}/visitor-setup`).set(auth(manager))).status).toBe(200);
    expect((await w.http().get(`${site()}/visitor-setup`).set(auth(supervisor))).status).toBe(403);
    const tries = [
      () => w.http().post(`${site()}/gates`).send({ name: 'X' }),
      () => w.http().put(`${site()}/gates/${main}`).send({ name: 'X', active: true }),
      () => w.http().put(`${site()}/visitor-settings`).send(DEFAULT_VISITOR_SETTINGS),
      () => w.http().post(`${site()}/visitor-categories`).send({ name: 'Delivery', kind: 'once_off' }),
      () => w.http().post(`${site()}/barred`).send({ kind: 'registration', value: 'CA 1', reason: 'Test' }),
    ];
    for (const t of tries) expect((await t().set(auth(manager))).status).toBe(403);
    expect((await w.http().post(`${site()}/gates`).send({ name: 'X' })).status).toBe(401);
  });

  it('keeps one company’s gates, settings and barred list away from another company', async () => {
    expect((await w.http().get(`${site()}/visitor-setup`).set(auth(bAdmin))).status).toBe(404);
    expect((await w.http().post(`${site()}/gates`).set(auth(bAdmin)).send({ name: 'Theirs' })).status).toBe(404);
    expect((await w.http().put(`/api/sites/${w.b.siteId}/gates/${main}`).set(auth(bAdmin)).send({ name: 'Mine now', active: true })).status).toBe(404);
    expect((await w.http().post(`${site()}/barred`).set(auth(bAdmin)).send({ kind: 'registration', value: 'CA 1', reason: 'Test' })).status).toBe(404);
    const other = await (await w.http().get(`/api/sites/${w.b.siteId}/visitor-setup`).set(auth(bAdmin))).body;
    expect(other.gates).toEqual([]);
    const tables = await ownerQuery(
      `SELECT c.relname FROM pg_class c WHERE c.relname = ANY($1) AND c.relrowsecurity AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant') ORDER BY 1`,
      [['site_gates', 'site_visitor_settings', 'visitor_categories', 'barred_entries']],
    );
    expect(tables.map((t: { relname: string }) => t.relname)).toEqual(['barred_entries', 'site_gates', 'site_visitor_settings', 'visitor_categories']);
  });

  it('saves a site’s checks and time limits, and records the change with before and after', async () => {
    const next = { ...DEFAULT_VISITOR_SETTINGS, checks: { ...DEFAULT_VISITOR_SETTINGS.checks, paxCount: false }, noResponseSeconds: 90, overstayEscalationMinutes: 45 };
    expect((await w.http().put(`${site()}/visitor-settings`).set(auth(admin)).send(next)).status).toBe(200);
    expect((await setup()).settings).toEqual({ ...next, saved: true });
    const [a] = await audit('visitor_settings.update');
    expect(a.actor_label).toBe('Sam Admin');
    expect(a.before).toMatchObject({ usingDefaults: true, noResponseSeconds: 120, checks: { paxCount: true } });
    expect(a.after).toMatchObject({ noResponseSeconds: 90, checks: { paxCount: false } });
    // Another site of the same company is untouched.
    const [{ n }] = await ownerQuery('SELECT count(*)::int AS n FROM site_visitor_settings');
    expect(n).toBe(1);
  });

  it('refuses a check that cannot work yet, a time out of range, and a body with pieces missing', async () => {
    const put = (body: unknown) => w.http().put(`${site()}/visitor-settings`).set(auth(admin)).send(body as object);
    const stolen = await put({ ...DEFAULT_VISITOR_SETTINGS, checks: { ...DEFAULT_VISITOR_SETTINGS.checks, stolenVehicle: true } });
    expect(stolen.status).toBe(400);
    expect(stolen.body.errors).toEqual({ 'checks.stolenVehicle': 'Stolen vehicle lookup cannot be switched on yet. No lookup provider has been contracted yet.' });
    expect((await put({ ...DEFAULT_VISITOR_SETTINGS, noResponseSeconds: 5 })).body.errors).toEqual({ noResponseSeconds: 'Enter a whole number from 30 to 600 seconds.' });
    expect((await put({ ...DEFAULT_VISITOR_SETTINGS, checks: { paxCount: true } })).status).toBe(400);
    expect((await put({ ...DEFAULT_VISITOR_SETTINGS, checks: { ...DEFAULT_VISITOR_SETTINGS.checks, madeUp: true } })).status).toBe(400);
    expect((await setup()).settings.noResponseSeconds).toBe(90);
  });

  it('adds and changes visitor categories, each with one kind of time limit', async () => {
    const post = (body: object) => w.http().post(`${site()}/visitor-categories`).set(auth(admin)).send(body);
    const made = await post({ name: 'Delivery', kind: 'once_off', limitMinutes: 30 });
    expect(made.status).toBe(201);
    expect((await post({ name: 'delivery', kind: 'once_off' })).status).toBe(409);
    expect((await post({ name: 'Both', kind: 'once_off', limitMinutes: 30, limitUntil: '17:00' })).body.errors).toEqual({ limitUntil: 'Choose time on site or a time of day, not both.' });
    const put = await w.http().put(`${site()}/visitor-categories/${made.body.id}`).set(auth(admin)).send({ name: 'Delivery', kind: 'once_off', contractor: false, limitMinutes: null, limitUntil: '18:30', active: false });
    expect(put.status).toBe(200);
    const cats = (await setup()).categories as { name: string; limitUntil: string | null; active: boolean }[];
    expect(cats).toHaveLength(3);
    expect(cats.at(-1)).toMatchObject({ name: 'Delivery', limitUntil: '18:30', active: false });
    const [a] = await audit('visitor_category.update');
    expect(a.before).toMatchObject({ limitMinutes: 30, limitUntil: null, active: true });
    expect(a.after).toMatchObject({ limitMinutes: null, limitUntil: '18:30', active: false });
  });

  it('bars a number plate, cell number or ID number however it is typed, from the site or from one unit', async () => {
    const post = (body: object) => w.http().post(`${site()}/barred`).set(auth(admin)).send(body);
    const plate = await post({ kind: 'registration', value: 'ca 123-456', reason: 'Theft from unit 9, case opened' });
    expect(plate.status).toBe(201);
    expect(plate.body.value).toBe('CA123456');
    barredId = plate.body.id;
    expect((await post({ kind: 'registration', value: 'CA123 456', reason: 'Again' })).status).toBe(409);
    expect((await post({ kind: 'registration', value: 'CA 999', reason: '' })).body.errors).toEqual({ reason: 'Say why this is barred.' });
    expect((await post({ kind: 'cell', value: '082', reason: 'Too short' })).body.errors).toEqual({ value: 'Enter the full cell number.' });
    const unit = await w.http().post(`${site()}/units`).set(auth(admin)).send({ name: '14' });
    // The same plate may also be barred by one unit: a different scope.
    expect((await post({ kind: 'registration', value: 'CA 123 456', unitId: unit.body.id, reason: 'Unit 14 does not want this visitor' })).status).toBe(201);
    const otherUnit = (await ownerQuery(`INSERT INTO site_units (company_id, site_id, name) SELECT company_id, id, 'B1' FROM sites WHERE id = $1 RETURNING id`, [w.b.siteId]))[0].id;
    expect((await post({ kind: 'cell', value: '+27 82 555 0140', unitId: otherUnit, reason: 'Wrong site' })).status).toBe(400);
    const barred = (await setup()).barred as Record<string, unknown>[];
    expect(barred.map((b) => [b.kindLabel, b.value, b.unitName, b.addedBy, b.reviewNow])).toEqual([
      ['Number plate', 'CA123456', '14', 'Sam Admin', false],
      ['Number plate', 'CA123456', null, 'Sam Admin', false],
    ]);
  });

  it('takes an entry off the barred list with a reason, and keeps the record', async () => {
    const off = (reason: string) => w.http().post(`${site()}/barred/${barredId}/remove`).set(auth(admin)).send({ reason });
    expect((await off('')).status).toBe(400);
    expect((await off('Case withdrawn')).status).toBe(200);
    expect((await off('Again')).status).toBe(404);
    expect((await setup()).barred).toHaveLength(1);
    const [row] = await ownerQuery('SELECT removal_reason, removed_at IS NOT NULL AS removed, removed_by IS NOT NULL AS by FROM barred_entries WHERE id = $1', [barredId]);
    expect(row).toEqual({ removal_reason: 'Case withdrawn', removed: true, by: true });
    // It can be barred again afterwards.
    expect((await w.http().post(`${site()}/barred`).set(auth(admin)).send({ kind: 'registration', value: 'CA123456', reason: 'Back again' })).status).toBe(201);
    const [a] = await audit('barred.remove');
    expect(a).toEqual({ actor_label: 'Sam Admin', before: { kind: 'registration', value: 'CA123456' }, after: { reason: 'Case withdrawn' } });
  });
});
