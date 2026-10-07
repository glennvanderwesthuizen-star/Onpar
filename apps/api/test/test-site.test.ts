import { ownerQuery, setupWorld, World } from './helpers';

/** The test-site maker (owner's request, 7 Oct 2026): a ready-made, made-up site for testing. */
describe('test-site maker', () => {
  let w: World;
  let admin: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
  });
  afterAll(() => w.app.close());

  it('only the administrator may make one', async () => {
    const manager = await w.login('manager@a.test');
    expect((await w.http().post('/api/test-sites').set(auth(manager))).status).toBe(403);
    expect((await w.http().post('/api/test-sites')).status).toBe(401);
  });

  it('makes a site with gates, units, tenants who can sign in, announced visitors and staff', async () => {
    const r = await w.http().post('/api/test-sites').set(auth(admin));
    expect(r.status).toBe(201);
    const t = r.body;
    expect(t.name).toBe('Test site 1');
    expect(t.gates).toEqual(['Main gate', 'Back gate']);
    expect(t.tenants).toHaveLength(12);
    expect(t.announced).toHaveLength(4);
    expect(t.staff.map((s: { code: string }) => s.code)).toEqual(['111111', '222222']);

    const setup = (await w.http().get(`/api/sites/${t.siteId}/visitor-setup`).set(auth(admin))).body;
    expect(setup.gates.map((g: { name: string }) => g.name).sort()).toEqual(['Back gate', 'Main gate']);
    const people = (await w.http().get(`/api/sites/${t.siteId}/customers`).set(auth(admin))).body;
    expect(people.units).toHaveLength(12);
    expect(people.customers).toHaveLength(12);

    // A tenant signs in with the one shared password, without having to change it first.
    const login = await w.http().post('/api/auth/login').send({ email: t.tenants[2].email, password: t.password });
    expect(login.status).toBeLessThan(300);
    const passes = (await w.http().get('/api/customer/passes').set(auth(login.body.token ?? login.body.accessToken))).body;
    expect(passes.current).toHaveLength(1);
    expect(passes.current[0].visitorName ?? passes.current[0].name).toContain('Priya');

    const rows = await ownerQuery(`SELECT contractor, max_workers, kind FROM visitor_passes WHERE site_id = $1 ORDER BY visitor_name`, [t.siteId]);
    expect(rows.filter((p: { contractor: boolean }) => p.contractor)).toEqual([{ contractor: true, max_workers: 3, kind: 'ongoing' }]);
    expect((await ownerQuery(`SELECT count(*)::int AS n FROM unit_staff WHERE site_id = $1`, [t.siteId]))[0].n).toBe(2);
    const audit = await ownerQuery(`SELECT after FROM audit_log WHERE action = 'site.create_test'`);
    expect(audit[0].after).toMatchObject({ name: 'Test site 1', tenants: 12 });
    // No password in the audit trail.
    expect(JSON.stringify(audit[0].after)).not.toContain(t.password);
  });

  it('a second one gets the next number and its own sign-ins, and another company sees neither', async () => {
    const r = await w.http().post('/api/test-sites').set(auth(admin));
    expect(r.body.name).toBe('Test site 2');
    expect(r.body.tenants[0].email).not.toBe('');
    const bAdmin = await w.login('admin@b.test');
    const sites = (await w.http().get('/api/sites').set(auth(bAdmin))).body;
    expect(sites.some((s: { name: string }) => s.name.startsWith('Test site'))).toBe(false);
  });
});
