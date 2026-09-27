import { createCompany } from '../src/db/company';
import { OWNER_URL, ownerQuery, setupWorld, World } from './helpers';

/** Milestone 10: new companies, and management users added from the website. */
describe('companies and management users', () => {
  let w: World;
  let admin: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const signIn = async (email: string, password: string) => (await w.http().post('/api/auth/login').send({ email, password })).body.token as string;

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
  });
  afterAll(() => w.app.close());

  describe('a new company', () => {
    let created: Awaited<ReturnType<typeof createCompany>>;
    it('is created with its first administrator on a temporary password, and audited', async () => {
      created = await createCompany(OWNER_URL, { name: 'Umbrella Guarding', adminName: 'Nomsa Admin', adminEmail: 'Nomsa@Umbrella.test' });
      expect(created.email).toBe('nomsa@umbrella.test');
      expect(created.password).toHaveLength(16);
      const [a] = await ownerQuery(`SELECT action, after->>'name' AS name FROM audit_log WHERE company_id = $1`, [created.companyId]);
      expect(a).toEqual({ action: 'company.create', name: 'Umbrella Guarding' });
      await expect(createCompany(OWNER_URL, { name: 'Other', adminName: 'Someone', adminEmail: 'nomsa@umbrella.test' })).rejects.toThrow(/already has an On Par account/);
    });

    it('makes the administrator choose their own password before anything else', async () => {
      const t = await signIn(created.email, created.password);
      expect((await w.http().get('/api/auth/me').set(auth(t))).body).toMatchObject({ mustChangePassword: true, company: { name: 'Umbrella Guarding' } });
      const blocked = await w.http().get('/api/sites').set(auth(t));
      expect(blocked.status).toBe(403);
      expect(blocked.body.message).toBe('Please choose your own password first.');
      const weak = await w.http().post('/api/auth/password').set(auth(t)).send({ currentPassword: created.password, newPassword: 'short' });
      expect(weak.status).toBe(400);
      const wrong = await w.http().post('/api/auth/password').set(auth(t)).send({ currentPassword: 'not-it', newPassword: 'green gate at dawn' });
      expect(wrong.body.errors).toEqual({ currentPassword: 'Not right.' });
      expect((await w.http().post('/api/auth/password').set(auth(t)).send({ currentPassword: created.password, newPassword: 'green gate at dawn' })).status).toBe(200);
      expect((await w.http().get('/api/sites').set(auth(t))).status).toBe(200);
      // The new company sees none of company A's data.
      expect((await w.http().get('/api/sites').set(auth(t))).body).toEqual([]);
    });
  });

  describe('users', () => {
    let supervisorId: string;
    let temp: string;
    it('lets the system administrator add a supervisor for a site, with a temporary password shown once', async () => {
      const r = await w.http().post('/api/users').set(auth(admin)).send({ fullName: 'Lindiwe Supervisor', email: 'Lindiwe@A.test', role: 'site_supervisor', siteIds: [w.a.siteId] });
      expect(r.status).toBe(201);
      supervisorId = r.body.id;
      temp = r.body.temporaryPassword;
      const list = (await w.http().get('/api/users').set(auth(admin))).body;
      expect(list.find((u: { id: string }) => u.id === supervisorId)).toMatchObject({
        email: 'lindiwe@a.test',
        roleLabel: 'Site supervisor',
        siteIds: [w.a.siteId],
        mustChangePassword: true,
        active: true,
      });
      const [a] = await ownerQuery(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.create'`);
      expect(a.n).toBe(1);
    });

    it('needs a site for site-based roles, and a unique email across all companies', async () => {
      const noSite = await w.http().post('/api/users').set(auth(admin)).send({ fullName: 'No Site', email: 'nosite@a.test', role: 'client_manager', siteIds: [] });
      expect(noSite.status).toBe(400);
      expect(noSite.body.errors).toEqual({ siteIds: 'Choose at least one site.' });
      const taken = await w.http().post('/api/users').set(auth(admin)).send({ fullName: 'Copy Cat', email: 'manager@b.test', role: 'company_manager' });
      expect(taken.status).toBe(409);
      const foreignSite = await w.http().post('/api/users').set(auth(admin)).send({ fullName: 'Wrong Site', email: 'wrong@a.test', role: 'site_manager', siteIds: [w.b.siteId] });
      expect(foreignSite.status).toBe(400);
    });

    it('lets only the system administrator manage users', async () => {
      const manager = await w.login('manager@a.test');
      expect((await w.http().get('/api/users').set(auth(manager))).status).toBe(403);
      expect((await w.http().post('/api/users').set(auth(manager)).send({ fullName: 'X Y', email: 'x@a.test', role: 'system_admin' })).status).toBe(403);
    });

    it('changes a role and sites, and deactivating signs the user out at once', async () => {
      const newPw = 'walking the east fence';
      let t = await signIn('lindiwe@a.test', temp);
      await w.http().post('/api/auth/password').set(auth(t)).send({ currentPassword: temp, newPassword: newPw });
      expect((await w.http().get('/api/sites').set(auth(t))).body.map((s: { id: string }) => s.id)).toEqual([w.a.siteId]);
      const up = await w.http().put(`/api/users/${supervisorId}`).set(auth(admin)).send({ fullName: 'Lindiwe Dlamini', role: 'company_manager', siteIds: [w.a.siteId], active: true });
      expect(up.body).toMatchObject({ fullName: 'Lindiwe Dlamini', role: 'company_manager', siteIds: [] });
      await w.http().put(`/api/users/${supervisorId}`).set(auth(admin)).send({ fullName: 'Lindiwe Dlamini', role: 'company_manager', active: false });
      expect((await w.http().get('/api/sites').set(auth(t))).status).toBe(401);
      expect((await w.http().post('/api/auth/login').send({ email: 'lindiwe@a.test', password: newPw })).status).toBe(401);
      await w.http().put(`/api/users/${supervisorId}`).set(auth(admin)).send({ fullName: 'Lindiwe Dlamini', role: 'company_manager', active: true });
      t = await signIn('lindiwe@a.test', newPw);
      expect(t).toBeTruthy();
    });

    it('resets a forgotten password to a new temporary one', async () => {
      const r = await w.http().post(`/api/users/${supervisorId}/reset-password`).set(auth(admin));
      expect(r.body.temporaryPassword).toHaveLength(16);
      expect((await w.http().post('/api/auth/login').send({ email: 'lindiwe@a.test', password: 'walking the east fence' })).status).toBe(401);
      const t = await signIn('lindiwe@a.test', r.body.temporaryPassword);
      expect((await w.http().get('/api/auth/me').set(auth(t))).body.mustChangePassword).toBe(true);
    });

    it('stops administrators locking themselves or the company out', async () => {
      const [me] = await ownerQuery(`SELECT id FROM users WHERE email = 'admin@a.test'`);
      const self = await w.http().put(`/api/users/${me.id}`).set(auth(admin)).send({ fullName: 'Sam Admin', role: 'company_manager', active: true });
      expect(self.status).toBe(400);
    });

    it("never touches another company's users (scenario 14)", async () => {
      const bAdmin = await w.login('admin@b.test');
      expect((await w.http().get('/api/users').set(auth(bAdmin))).body.map((u: { email: string }) => u.email)).not.toContain('lindiwe@a.test');
      expect((await w.http().put(`/api/users/${supervisorId}`).set(auth(bAdmin)).send({ fullName: 'Hijack', role: 'system_admin', active: true })).status).toBe(404);
      expect((await w.http().post(`/api/users/${supervisorId}/reset-password`).set(auth(bAdmin))).status).toBe(404);
    });
  });
});
