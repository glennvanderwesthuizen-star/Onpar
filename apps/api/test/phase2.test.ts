import { DbService } from '../src/db/db.service';
import { StorageService } from '../src/storage/storage.service';
import { PNG, setupWorld, World } from './helpers';

/** Phase 2 of the optimisation review (owner, 9 Oct 2026): speed and running cost. */
describe('phase 2: speed and running cost', () => {
  let w: World;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  beforeAll(async () => {
    w = await setupWorld();
  });
  afterAll(() => w.app.close());

  it('removes a photo again when the database step it belongs to fails', async () => {
    const storage = w.app.get(StorageService);
    let key = '';
    await expect(
      w.app.get(DbService).withTenant(w.a.companyId, async () => {
        key = await storage.put(w.a.companyId, 'reports', PNG, '.png');
        throw new Error('the report could not be saved');
      }),
    ).rejects.toThrow('the report could not be saved');
    await expect(storage.get(key)).rejects.toThrow(/no longer kept/);
    // A step that succeeds keeps its photo.
    const kept = await w.app.get(DbService).withTenant(w.a.companyId, () => storage.put(w.a.companyId, 'reports', PNG, '.png'));
    await expect(storage.get(kept)).resolves.toBeInstanceOf(Buffer);
  });

  it('gives every page its banners and the Alerts count in one call, only what the role may see', async () => {
    const manager = await w.login('manager@a.test');
    const r = await w.http().get('/api/banners').set(auth(manager));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ panics: [], bolos: [], unread: expect.any(Number) });
    const admin = await w.login('admin@a.test');
    const made = await w.http().post('/api/users').set(auth(admin)).send({ fullName: 'Carol Client', email: 'client2@a.test', role: 'client_manager', siteIds: [w.a.siteId] });
    const first = (await w.http().post('/api/auth/login').send({ email: 'client2@a.test', password: made.body.temporaryPassword })).body.token;
    const client = (await w.http().post('/api/auth/password').set(auth(first)).send({ currentPassword: made.body.temporaryPassword, newPassword: 'green gate at dawn' })).body.token;
    const c = (await w.http().get('/api/banners').set(auth(client))).body;
    expect(c.panics).toBeNull();
    expect((await w.http().get('/api/banners')).status).toBe(401);
  });
});
