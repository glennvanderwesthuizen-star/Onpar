import { randomUUID } from 'node:crypto';
import { NotificationsService, PushResult, PushSender, PushTarget } from '../src/notifications/notifications.service';
import { enrol, enrolmentData, ownerQuery, PNG, setupWorld, World } from './helpers';

class QuietSender implements PushSender {
  async send(_t: PushTarget, _p: string): Promise<PushResult> {
    return { ok: true };
  }
}

/** The Electronic Occurrence Book (brief section 27; scenario list item 17): one site, one day, assembled from what is already recorded. */
describe('the Electronic Occurrence Book', () => {
  let w: World;
  let admin: string;
  let supervisor: string;
  let deviceToken: string;
  let guard: { token: string; employeeId: string; name: string };
  let unit14: string;
  let today: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const g = () => ({ 'X-Device-Token': deviceToken, Authorization: `Bearer ${guard.token}` });
  const site = () => `/api/sites/${w.a.siteId}`;
  const now = () => new Date().toISOString();
  const book = async (who = supervisor, date = today) => (await w.http().get(`${site()}/occurrence-book?date=${date}`).set(auth(who))).body;

  beforeAll(async () => {
    w = await setupWorld();
    w.app.get(NotificationsService).sender = new QuietSender();
    admin = await w.login('admin@a.test');
    supervisor = await w.login('supervisor@a.test');
    const d = await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Gate phone', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Main gate' });
    deviceToken = d.body.deviceToken;
    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    const login = await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: o.body.officer.employeeNumber, pin: o.body.initialPin });
    guard = { token: login.body.token, employeeId: o.body.officer.id, name: o.body.officer.fullName ?? '' };
    const gateId = (await w.http().post(`${site()}/gates`).set(auth(admin)).send({ name: 'Main gate' })).body.id;
    await w.http().put(`${site()}/gate-phones/${d.body.device.id}`).set(auth(admin)).send({ gateId });
    unit14 = (await w.http().post(`${site()}/units`).set(auth(admin)).send({ name: '14' })).body.id;
    today = (await ownerQuery(`SELECT to_char(now() AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS d`))[0].d;

    // Duty On, as recorded by the phone: attendance, the duty event and the signed declaration.
    const [a] = await ownerQuery(
      `INSERT INTO attendance (company_id, employee_id, site_id, shift_name, shift_date, duty_on_at, arrival_status, late_minutes)
       SELECT company_id, $1, $2, 'Day', current_date, now() - interval '1 minute', 'LATE', 12 FROM employees WHERE id = $1 RETURNING id, company_id`,
      [guard.employeeId, w.a.siteId],
    );
    const [ev] = await ownerQuery(
      `INSERT INTO duty_events (id, company_id, attendance_id, employee_id, kind, official_at, trusted_at, device_clock, late_synced, drift_seconds, drift_flagged)
       VALUES (gen_random_uuid(), $1, $2, $3, 'duty_on', now() - interval '1 minute', now() - interval '1 minute', now() - interval '1 minute', false, 0, false) RETURNING id`,
      [a.company_id, a.id, guard.employeeId],
    );
    await ownerQuery(
      `INSERT INTO declarations (id, company_id, attendance_id, duty_event_id, employee_id, kind, wording_version, statements, official_at, device_clock, late_synced, drift_seconds, drift_flagged, comment)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'duty_on', 1, '[]', now() - interval '1 minute', now() - interval '1 minute', false, 0, false, 'Radio battery low')`,
      [a.company_id, a.id, ev.id, guard.employeeId],
    );
  });
  afterAll(() => w.app.close());

  it('shows the banner and puts the day together from duty, reports and visitors, in time order', async () => {
    const r = await w
      .http()
      .post('/api/device/reports')
      .set(g())
      .field('data', JSON.stringify({ eventId: randomUUID(), category: 'maintenance', priority: 'amber', description: 'Gate 2 motor is damaged', trustedAt: now(), deviceClock: now() }))
      .attach('photo', PNG, { filename: 'gate.png', contentType: 'image/png' });
    expect(r.status).toBeLessThan(300);
    const v = await w
      .http()
      .post('/api/device/visitors')
      .set(g())
      .field(
        'data',
        JSON.stringify({
          eventId: randomUUID(),
          type: 'pedestrian',
          person: { idNumber: 'EOB000001', surname: 'Visitor', names: 'Vera', document: 'passport', method: 'manual' },
          unitId: unit14,
          capturedOffline: true,
          offline: { decision: 'approved', contact: 'primary' },
          trustedAt: now(),
          deviceClock: now(),
        }),
      )
      .attach('identity', PNG, { filename: 'id.png', contentType: 'image/png' })
      .attach('face', PNG, { filename: 'face.png', contentType: 'image/png' });
    expect(v.status).toBe(200);

    const b = await book();
    expect(b.banner).toMatch(/not the official Occurrence Book/);
    expect(b.date).toBe(today);
    const kinds = b.entries.map((e: { category: string }) => e.category);
    expect(kinds).toEqual(expect.arrayContaining(['duty', 'report', 'visitor']));
    const duty = b.entries.find((e: { category: string }) => e.category === 'duty');
    expect(duty.text).toBe('Duty On, Day shift (12 minutes late). Declaration signed. Comment: Radio battery low');
    const report = b.entries.find((e: { category: string }) => e.category === 'report');
    expect(report).toMatchObject({ alert: 'amber', reportNumber: expect.any(Number), text: 'Maintenance report: Gate 2 motor is damaged' });
    expect(report.colour).toMatch(/^#/);
    expect(report.photo).toMatch(/^report\//);
    const visitor = b.entries.find((e: { category: string }) => e.category === 'visitor');
    expect(visitor.text).toContain('Visitor, Vera, on foot, to see unit 14. On site (no signal at the gate).');
    expect(visitor.photo).toMatch(/^visit_face\//);
    // In time order.
    const times = b.entries.map((e: { at: string }) => Date.parse(e.at));
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    // Yesterday is a different page.
    const y = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    expect((await book(supervisor, y)).entries).toEqual([]);
  });

  it('opens the photo taken with an entry, only for this site, and records each look', async () => {
    const report = (await book()).entries.find((e: { category: string }) => e.category === 'report');
    const r = await w.http().get(`${site()}/occurrence-book/photo/${report.photo}`).set(auth(supervisor));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    const [a] = await ownerQuery(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'eob.photo_view'`);
    expect(a.n).toBe(1);
    expect((await w.http().get(`${site()}/occurrence-book/photo/nonsense/${randomUUID()}`).set(auth(supervisor))).status).toBe(404);
    const bAdmin = await w.login('admin@b.test');
    expect((await w.http().get(`/api/sites/${w.b.siteId}/occurrence-book/photo/${report.photo}`).set(auth(bAdmin))).status).toBe(404);
  });

  it('takes a written entry, and a correction as a new entry; nothing can be changed', async () => {
    expect((await w.http().post(`${site()}/occurrence-book`).set(auth(supervisor)).send({ text: 'x' })).status).toBe(400);
    expect((await w.http().post(`${site()}/occurrence-book`).set(auth(supervisor)).send({ text: 'In the future', at: new Date(Date.now() + 3600_000).toISOString() })).status).toBe(400);
    const first = await w.http().post(`${site()}/occurrence-book`).set(auth(supervisor)).send({ text: 'Power failure in block C, Eskom notified.', at: new Date(Date.now() - 30 * 60_000).toISOString() });
    expect(first.status).toBe(201);
    const fix = await w.http().post(`${site()}/occurrence-book`).set(auth(supervisor)).send({ text: 'It was block D, not C.', corrects: first.body.id });
    expect(fix.status).toBe(201);
    const written = (await book()).entries.filter((e: { category: string }) => e.category === 'entry');
    expect(written.map((e: { text: string }) => e.text)).toEqual(['Power failure in block C, Eskom notified.', 'Correction: It was block D, not C.']);
    await expect(ownerQuery(`UPDATE ob_entries SET text = 'changed'`)).rejects.toThrow();
    await expect(ownerQuery(`DELETE FROM ob_entries`)).rejects.toThrow();
  });

  it('is only for those who may see the site', async () => {
    const bAdmin = await w.login('admin@b.test');
    expect((await w.http().get(`${site()}/occurrence-book`).set(auth(bAdmin))).status).toBe(404);
    expect((await w.http().post(`${site()}/occurrence-book`).set(auth(bAdmin)).send({ text: 'Not my site' })).status).toBe(404);
    expect((await w.http().get(`${site()}/occurrence-book`).set(g())).status).toBe(401);
  });
});
