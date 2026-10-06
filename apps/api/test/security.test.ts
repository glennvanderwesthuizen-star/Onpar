import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { ownerQuery, setupWorld, TEST_CONFIG, World } from './helpers';
import { S3Driver, StorageService } from '../src/storage/storage.service';

/** Milestone 10: hardening (brief section 9). */
describe('security hardening', () => {
  let w: World;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    w = await setupWorld();
  });
  afterAll(() => w.app.close());

  describe('database', () => {
    it('has row-level security and a policy on every table (scenario 14)', async () => {
      const tables = await ownerQuery(
        `SELECT c.relname AS name, c.relrowsecurity AS rls, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`,
      );
      // Not tenant data: the migration list, and sign-in throttling (hashed keys, reached only through functions).
      // Server-wide tables with no company: locked to the app role completely, reached only through functions.
      const exempt = ['schema_migrations', 'auth_throttle', 'push_keys'];
      const missing = tables.filter((t) => !exempt.includes(t.name) && (!t.rls || t.policies === 0)).map((t) => t.name);
      expect(missing).toEqual([]);
      expect(tables.find((t) => t.name === 'auth_throttle')).toMatchObject({ rls: true, policies: 0 });
      expect(tables.find((t) => t.name === 'push_keys')).toMatchObject({ rls: true, policies: 0 });
    });

    it('gives the app role no way around row-level security', async () => {
      const [r] = await ownerQuery(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'onpar_app'`);
      expect(r).toEqual({ rolsuper: false, rolbypassrls: false });
      const owned = await ownerQuery(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles o ON o.oid = c.relowner
          WHERE n.nspname = 'public' AND o.rolname = 'onpar_app'`,
      );
      expect(owned).toEqual([]);
    });
  });

  describe('sign-in', () => {
    const login = (email: string, password: string, web = false) => {
      const r = w.http().post('/api/auth/login').send({ email, password });
      return web ? r.set('X-Requested-With', 'OnPar') : r;
    };

    it('locks an email after five wrong passwords, even for the right password, and logs it', async () => {
      for (let i = 0; i < 4; i++) expect((await login('supervisor@a.test', 'wrong')).status).toBe(401);
      const fifth = await login('supervisor@a.test', 'wrong');
      expect(fifth.status).toBe(429);
      expect(fifth.body.message).toMatch(/^Too many sign-in attempts\. Try again in 15 minutes\.$/);
      expect((await login('supervisor@a.test', 'OnPar-demo-2026')).status).toBe(429);
      // Other accounts are unaffected.
      expect((await login('manager@a.test', 'OnPar-demo-2026')).status).toBe(200);
      const [a] = await ownerQuery(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.locked'`);
      expect(a.n).toBe(1);
      // Once the lock has passed, the right password works again.
      await ownerQuery(`UPDATE auth_throttle SET locked_until = now() - interval '1 second'`);
      expect((await login('supervisor@a.test', 'OnPar-demo-2026')).status).toBe(200);
    });

    it('stores no email address for throttling', async () => {
      await login('someone@a.test', 'wrong');
      const keys = (await ownerQuery('SELECT key FROM auth_throttle')).map((r) => r.key as string);
      expect(keys.some((k) => k.includes('@'))).toBe(false);
    });

    it('gives the website an httpOnly cookie and no token it could leak', async () => {
      const r = await login('manager@a.test', 'OnPar-demo-2026', true);
      // Which kind of account signed in is said (so the page knows where to go); no token is.
      expect(r.body).toEqual({ ok: true, account: 'staff' });
      const cookie = r.headers['set-cookie'][0] as string;
      expect(cookie).toMatch(/^onpar_session=/);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(cookie).toMatch(/Path=\/api/);
      const session = cookie.split(';')[0];
      expect((await w.http().get('/api/auth/me').set('Cookie', session)).body.name).toBe('Thandi Manager');
    });

    it('refuses a cookie-signed change without the website header (cross-site request)', async () => {
      const r = await login('admin@a.test', 'OnPar-demo-2026', true);
      const session = (r.headers['set-cookie'][0] as string).split(';')[0];
      const body = { label: 'Device 009', serialOrImei: '356938035643810', siteId: w.a.siteId };
      const forged = await w.http().post('/api/devices').set('Cookie', session).send(body);
      expect(forged.status).toBe(403);
      const real = await w.http().post('/api/devices').set('Cookie', session).set('X-Requested-With', 'OnPar').send(body);
      expect(real.status).toBe(201);
    });

    it('signs out by clearing the cookie', async () => {
      const r = await w.http().post('/api/auth/logout');
      expect(r.headers['set-cookie'][0]).toMatch(/onpar_session=;.*Expires=Thu, 01 Jan 1970/);
    });

    it('refuses an unsigned token', async () => {
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const [u] = await ownerQuery(`SELECT id FROM users WHERE email = 'admin@a.test'`);
      const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: u.id, cid: w.a.companyId, typ: 'user' })}.`;
      expect((await w.http().get('/api/auth/me').set(auth(forged))).status).toBe(401);
    });
  });

  it('sends security headers and hides the framework', async () => {
    const r = await w.http().get('/api/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(r.headers['strict-transport-security']).toBeDefined();
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  describe('files', () => {
    let manager: string;
    let employeeId: string;
    beforeAll(async () => {
      manager = await w.login('manager@a.test');
      const { enrol, enrolmentData } = await import('./helpers');
      employeeId = (await enrol(w, manager, enrolmentData(w.a.siteId))).body.officer.id;
    });

    const upload = (data: Buffer, type = 'application/pdf') =>
      w
        .http()
        .post(`/api/officers/${employeeId}/qualifications`)
        .set(auth(manager))
        .field('data', JSON.stringify({ type: 'first_aid', name: 'First aid level 2' }))
        .attach('certificate', data, { filename: 'cert.pdf', contentType: type });

    it('refuses a file that is not what it claims to be', async () => {
      const r = await upload(Buffer.from('MZ this is really a program'));
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/not the kind it claims to be/);
    });

    it('encrypts every stored file, and returns the original to someone allowed to see it', async () => {
      const pdf = Buffer.from('%PDF-1.4 secret certificate body');
      const r = await upload(pdf);
      expect(r.status).toBe(201);
      const files: string[] = [];
      const walk = (d: string) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(join(d, f))));
      walk(TEST_CONFIG.uploadDir);
      expect(files.length).toBeGreaterThan(4);
      for (const f of files) {
        const raw = readFileSync(f);
        expect(raw.subarray(0, 4).toString()).toBe('OPF1');
        expect(raw.includes(Buffer.from('%PDF'))).toBe(false);
        expect(raw.includes(Buffer.from('PNG'))).toBe(false);
      }
      const back = await w.http().get(`/api/qualifications/${r.body.id}/certificate`).set(auth(manager)).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(Buffer.compare(back.body, pdf)).toBe(0);
    });

    it('removes stored files again when the database work fails', async () => {
      const storage = new StorageService(TEST_CONFIG);
      let key = '';
      await expect(
        storage.together(async (put) => {
          key = await put(w.a.companyId, 'test', Buffer.from('%PDF-1.4 x'), '.pdf');
          throw new Error('database rolled back');
        }),
      ).rejects.toThrow('database rolled back');
      await expect(storage.get(key)).rejects.toThrow(/ENOENT/);
    });

    it('writes to S3 with server-side encryption on top, when configured', async () => {
      const sent: unknown[] = [];
      const client = { send: async (c: unknown) => void sent.push(c) } as never;
      const storage = new StorageService(TEST_CONFIG);
      storage.useDriver(new S3Driver(client, 'onpar-files', 'kms-key-1'));
      await storage.put(w.a.companyId, 'test', Buffer.from('%PDF-1.4 x'), '.pdf');
      const cmd = sent[0] as PutObjectCommand;
      expect(cmd).toBeInstanceOf(PutObjectCommand);
      expect(cmd.input).toMatchObject({ Bucket: 'onpar-files', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'kms-key-1' });
      expect((cmd.input.Body as Buffer).subarray(0, 4).toString()).toBe('OPF1');
    });
  });
});
