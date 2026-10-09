import { randomUUID } from 'node:crypto';
import { NotificationsService } from '../src/notifications/notifications.service';
import { RetentionService } from '../src/privacy/retention.service';
import { MAX_IMAGE_SIDE, shrinkImage, StorageService } from '../src/storage/storage.service';
import { ownerQuery, PNG, setupWorld, World } from './helpers';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp');

/** Phase 1 of the optimisation review (owner, 9 Oct 2026; D-54): storage and data. */
describe('phase 1: storage and data', () => {
  let w: World;
  let admin: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const DAY = 86_400_000;

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
  });
  afterAll(() => w.app.close());

  it('stores large website photos at most 1600 pixels, without where they were taken; HR and disciplinary files as they are', async () => {
    const camera = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 120, g: 140, b: 90 } } })
      .jpeg({ quality: 95 })
      .withExif({ IFD0: { Make: 'PhoneCo', Model: 'Camera 1' } })
      .toBuffer();
    const small = await shrinkImage(camera, '.jpg');
    const meta = await sharp(small).metadata();
    expect(Math.max(meta.width, meta.height)).toBe(MAX_IMAGE_SIDE);
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    // Small phone photos are stored exactly as sent.
    expect((await shrinkImage(PNG, '.png')).equals(PNG)).toBe(true);
    // A PDF is never touched; a broken image is kept rather than refused.
    const storage = w.app.get(StorageService);
    const kept = await storage.put(w.a.companyId, 'discipline', camera, '.jpg');
    expect((await storage.get(kept)).equals(camera)).toBe(true);
    const shrunk = await storage.put(w.a.companyId, `employees/${randomUUID()}`, camera, '.jpg');
    expect((await storage.get(shrunk)).length).toBeLessThan(camera.length);
  });

  it('removes photos of closed reports after 12 months, never of open ones; the report stays', async () => {
    const storage = w.app.get(StorageService);
    const retention = w.app.get(RetentionService);
    const put = () => storage.put(w.a.companyId, 'reports', PNG, '.png');
    const [closedKey, openKey] = [await put(), await put()];
    const report = (n: number, key: string, closed: boolean) =>
      ownerQuery(
        `INSERT INTO reports (company_id, number, site_id, category, priority, description, colour_slot, source, reported_at, photo_key, photo_content_type, closed_at, reported_by_user)
         VALUES ($1, $2, $3, 'observation', 'green', 'Broken light at gate 3', 1, 'user', now(), $4, 'image/png', CASE WHEN $5 THEN now() END,
                 (SELECT id FROM users WHERE email = 'admin@a.test')) RETURNING id`,
        [w.a.companyId, n, w.a.siteId, key, closed],
      );
    const [closed] = await report(9001, closedKey, true);
    await report(9002, openKey, false);
    await w.http().put('/api/privacy/retention').set(auth(admin)).send({ enabled: true, selfieMonths: 12, patrolPhotoMonths: 12, visitorMonths: 12, recordPhotoMonths: 12, staffSnapshotDays: 30, reason: 'Owner decided 9 Oct 2026' });
    expect((await w.http().get('/api/privacy/retention').set(auth(admin))).body.settings).toMatchObject({ recordPhotoMonths: 12, staffSnapshotDays: 30 });
    await retention.run(w.a.companyId, new Date(Date.now() + 11 * 31 * DAY));
    await expect(storage.get(closedKey)).resolves.toBeInstanceOf(Buffer);
    await retention.run(w.a.companyId, new Date(Date.now() + 13 * 31 * DAY));
    await expect(storage.get(closedKey)).rejects.toThrow(/no longer kept/);
    await expect(storage.get(openKey)).resolves.toBeInstanceOf(Buffer);
    expect(await ownerQuery('SELECT description FROM reports WHERE id = $1', [closed.id])).toEqual([{ description: 'Broken light at gate 3' }]);
    const status = (await w.http().get('/api/privacy/retention').set(auth(admin))).body;
    expect(status.removed.recordPhotos).toBe(1);
  });

  it('clears alerts older than a year, delivery records older than 30 days and old sign-in counters every night', async () => {
    const [u] = await ownerQuery(`SELECT id FROM users WHERE email = 'admin@a.test'`);
    const alert = async (age: string) =>
      (
        await ownerQuery(
          `INSERT INTO notifications (company_id, user_id, kind, title, lock_screen, created_at) VALUES ($1, $2, 'test', 'Test', 'Test', now() - $3::interval) RETURNING id`,
          [w.a.companyId, u.id, age],
        )
      )[0].id as string;
    const [old, recent] = [await alert('13 months'), await alert('2 months')];
    for (const [id, age] of [[recent, '40 days'], [recent, '1 day']]) {
      await ownerQuery(`INSERT INTO notification_deliveries (company_id, notification_id, channel, status, at) VALUES ($1, $2, 'push', 'sent', now() - $3::interval)`, [w.a.companyId, id, age]);
    }
    await ownerQuery(`INSERT INTO auth_throttle (key, failures, window_start) VALUES ('ip:old', 2, now() - interval '8 days'), ('ip:new', 2, now())`);
    await w.app.get(RetentionService).runAll(new Date());
    expect((await ownerQuery('SELECT id FROM notifications WHERE id = ANY($1)', [[old, recent]])).map((r: { id: string }) => r.id)).toEqual([recent]);
    expect((await ownerQuery('SELECT count(*)::int AS n FROM notification_deliveries WHERE notification_id = $1', [recent]))[0].n).toBe(1);
    expect((await ownerQuery(`SELECT key FROM auth_throttle WHERE key LIKE 'ip:%' ORDER BY key`)).map((r: { key: string }) => r.key)).toEqual(['ip:new']);
    await w.app.get(NotificationsService).settled();
  });

  it('no longer has a per-site visitor retention field that did nothing', async () => {
    const setup = (await w.http().get(`/api/sites/${w.a.siteId}/visitor-setup`).set(auth(admin))).body;
    expect(setup.settings.retentionMonths).toBeUndefined();
    expect(setup.limits.retentionMonths).toBeUndefined();
  });
});
