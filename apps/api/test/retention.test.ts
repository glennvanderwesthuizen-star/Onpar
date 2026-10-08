import { randomUUID } from 'node:crypto';
import { enrol, enrolmentData, ownerQuery, PNG, setupWorld, World } from './helpers';
import { RetentionService } from '../src/privacy/retention.service';
import { StorageService } from '../src/storage/storage.service';

/** Milestone 10: POPIA retention of selfies and patrol photos (brief section 9). */
describe('retention', () => {
  let w: World;
  let manager: string;
  let supervisor: string;
  let attendanceId: string;
  let selfieKey: string;
  let patrolKey: string;
  let retention: RetentionService;
  let storage: StorageService;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const THIRTEEN_MONTHS = 13 * 31 * 24 * 3600 * 1000;
  const later = () => new Date(Date.now() + THIRTEEN_MONTHS);
  const settings = async () => (await w.http().get('/api/privacy/retention').set(auth(manager))).body;

  beforeAll(async () => {
    w = await setupWorld();
    retention = w.app.get(RetentionService);
    storage = w.app.get(StorageService);
    const admin = await w.login('admin@a.test');
    manager = await w.login('manager@a.test');
    supervisor = await w.login('supervisor@a.test');
    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    const deviceToken = (await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Device 001', serialOrImei: '356938035643809', siteId: w.a.siteId })).body.deviceToken;
    const token = (await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: '0001', pin: o.body.initialPin })).body.token;
    const g = { 'X-Device-Token': deviceToken, Authorization: `Bearer ${token}` };
    const now = () => new Date().toISOString();
    const on = await w.http().post('/api/device/duty').set(g).send({ eventId: randomUUID(), kind: 'duty_on', pin: o.body.initialPin, trustedAt: now(), deviceClock: now() });
    [{ id: attendanceId }] = await ownerQuery('SELECT id FROM attendance');
    await w
      .http()
      .post('/api/device/declarations')
      .set(g)
      .field('data', JSON.stringify({ eventId: randomUUID(), dutyEventId: on.body.dutyEventId, accepted: [true, true, true], comment: '', trustedAt: now(), deviceClock: now() }))
      .attach('selfie', PNG, { filename: 's.png', contentType: 'image/png' });
    [{ selfie_key: selfieKey }] = await ownerQuery('SELECT selfie_key FROM declarations');
    // A patrol photo, written straight in.
    const c = w.a.companyId;
    const [type] = await ownerQuery(`INSERT INTO patrol_types (company_id, site_id, code, name) VALUES ($1, $2, 'A', 'Internal') RETURNING id`, [c, w.a.siteId]);
    const [point] = await ownerQuery(
      `INSERT INTO patrol_points (company_id, site_id, patrol_type_id, name, qr_code, lat, lng) VALUES ($1, $2, $3, 'Gate', 'QR-R', -26.1, 28.05) RETURNING id`,
      [c, w.a.siteId, type.id],
    );
    const patrolId = randomUUID();
    await ownerQuery(
      `INSERT INTO patrol_instances (id, company_id, site_id, patrol_type_id, attendance_id, employee_id, window_index, window_start, window_end, state, max_duration_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, 0, now(), now() + interval '1 hour', 'completed', 30)`,
      [patrolId, c, w.a.siteId, type.id, attendanceId, o.body.officer.id],
    );
    patrolKey = await storage.put(c, 'patrols', PNG, '.png');
    await ownerQuery(
      `INSERT INTO patrol_visits (company_id, patrol_id, point_id, scanned_at, done_at, photo_key, photo_content_type) VALUES ($1, $2, $3, now(), now(), $4, 'image/png')`,
      [c, patrolId, point.id, patrolKey],
    );
  });
  afterAll(() => w.app.close());

  it('is off until the company switches it on, so nothing is removed', async () => {
    expect(await settings()).toEqual({
      settings: { enabled: false, selfieMonths: 12, patrolPhotoMonths: 12, boloMediaDays: 90, visitorMonths: 12 },
      wouldRemoveNow: { selfies: 0, patrolPhotos: 0, visitorPhotos: 0, visitorRecords: 0 },
      removed: { selfies: 0, patrolPhotos: 0, visitorPhotos: 0, visitorRecords: 0, last: null },
    });
    expect(await retention.run(w.a.companyId, later())).toBe(0);
    expect((await storage.get(selfieKey)).equals(PNG)).toBe(true);
  });

  it('can be switched on only by a manager or administrator, with a reason, audited', async () => {
    const body = { enabled: true, selfieMonths: 12, patrolPhotoMonths: 12, reason: 'Periods confirmed by our POPIA adviser' };
    expect((await w.http().put('/api/privacy/retention').set(auth(supervisor)).send(body)).status).toBe(403);
    expect((await w.http().put('/api/privacy/retention').set(auth(manager)).send({ ...body, reason: '' })).status).toBe(400);
    expect((await w.http().put('/api/privacy/retention').set(auth(manager)).send(body)).status).toBe(200);
    const [a] = await ownerQuery(`SELECT reason, before->>'enabled' AS was FROM audit_log WHERE action = 'privacy.retention_update'`);
    expect(a).toEqual({ reason: 'Periods confirmed by our POPIA adviser', was: 'false' });
    // Nothing is old enough yet.
    expect((await settings()).wouldRemoveNow).toEqual({ selfies: 0, patrolPhotos: 0, visitorPhotos: 0, visitorRecords: 0 });
  });

  it('removes photos past their period, keeps the records, and logs each removal', async () => {
    expect(await retention.run(w.a.companyId, later())).toBe(2);
    await expect(storage.get(selfieKey)).rejects.toThrow(/ENOENT/);
    await expect(storage.get(patrolKey)).rejects.toThrow(/ENOENT/);
    const selfie = await w.http().get(`/api/attendance/${attendanceId}/selfie/duty_on`).set(auth(supervisor));
    expect(selfie.status).toBe(410);
    expect(selfie.body.message).toMatch(/removed under the retention policy/);
    // The declaration itself is kept.
    const shift = await w.http().get(`/api/attendance/${attendanceId}`).set(auth(supervisor));
    expect(shift.body.declarations).toHaveLength(1);
    expect((await settings()).removed).toMatchObject({ selfies: 1, patrolPhotos: 1 });
    // A second run finds nothing more.
    expect(await retention.run(w.a.companyId, later())).toBe(0);
  });

  it('keeps the removal log append-only', async () => {
    await expect(ownerQuery('DELETE FROM retention_log')).rejects.toThrow(/immutable/);
  });

  it("does not touch a company that has not switched it on (scenario 14)", async () => {
    expect(await retention.run(w.b.companyId, later())).toBe(0);
    const b = await w.login('manager@b.test');
    expect((await w.http().get('/api/privacy/retention').set(auth(b))).body.settings.enabled).toBe(false);
  });
});
