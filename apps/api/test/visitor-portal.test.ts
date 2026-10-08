import { randomUUID } from 'node:crypto';
import { NotificationsService, PushResult, PushSender, PushTarget } from '../src/notifications/notifications.service';
import { RetentionService } from '../src/privacy/retention.service';
import { enrol, enrolmentData, ownerQuery, PNG, setupWorld, World } from './helpers';

class QuietSender implements PushSender {
  async send(_t: PushTarget, _p: string): Promise<PushResult> {
    return { ok: true };
  }
}

/** Visitor management, the portal (owner's step 5, 8 Oct 2026): dashboard, reports, emergency roll-call, photos and retention. */
describe('visitor management: the portal', () => {
  let w: World;
  let admin: string;
  let supervisor: string;
  let deviceToken: string;
  let guard: { token: string; employeeId: string };
  let unit14: string;
  let seq = 0;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const g = () => ({ 'X-Device-Token': deviceToken, Authorization: `Bearer ${guard.token}` });
  const site = () => `/api/sites/${w.a.siteId}`;
  const now = () => new Date().toISOString();
  /** A visitor let in by phone at the gate (the quickest way to have someone on site). */
  const letIn = async (data: Record<string, unknown> = {}) => {
    seq += 1;
    const r = await w
      .http()
      .post('/api/device/visitors')
      .set(g())
      .field(
        'data',
        JSON.stringify({
          eventId: randomUUID(),
          type: 'vehicle',
          person: { idNumber: `R${String(seq).padStart(8, '0')}`, surname: seq === 1 ? '=HYPERLINK("x")' : 'Mokoena', names: 'L', document: 'passport', method: 'manual' },
          vehicle: { registration: `CA 77 ${seq}`, make: 'Toyota', model: 'Hilux', colour: 'Red', vin: '', discExpiry: null, method: 'scan' },
          pax: 2,
          unitId: unit14,
          capturedOffline: true,
          offline: { decision: 'approved', contact: 'primary' },
          trustedAt: now(),
          deviceClock: now(),
          ...data,
        }),
      )
      .attach('identity', PNG, { filename: 'id.png', contentType: 'image/png' })
      .attach('face', PNG, { filename: 'face.png', contentType: 'image/png' });
    if (r.status !== 200) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id as string;
  };

  beforeAll(async () => {
    w = await setupWorld();
    w.app.get(NotificationsService).sender = new QuietSender();
    admin = await w.login('admin@a.test');
    supervisor = await w.login('supervisor@a.test');
    const d = await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Gate phone', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Main gate' });
    deviceToken = d.body.deviceToken;
    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    const login = await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: o.body.officer.employeeNumber, pin: o.body.initialPin });
    guard = { token: login.body.token, employeeId: o.body.officer.id };
    const gateId = (await w.http().post(`${site()}/gates`).set(auth(admin)).send({ name: 'Main gate' })).body.id;
    await w.http().put(`${site()}/gate-phones/${d.body.device.id}`).set(auth(admin)).send({ gateId });
    unit14 = (await w.http().post(`${site()}/units`).set(auth(admin)).send({ name: '14' })).body.id;
  });
  afterAll(() => w.app.close());

  it('shows every gate site at a glance: on site now, expected, exceptions and today', async () => {
    await letIn();
    await letIn();
    const turnedAway = await letIn({ offline: { decision: 'denied', contact: 'primary' } });
    expect(turnedAway).toBeTruthy();
    const r = await w.http().get('/api/visitors/dashboard').set(auth(supervisor));
    expect(r.status).toBe(200);
    expect(r.body.sites).toHaveLength(1);
    expect(r.body.sites[0]).toMatchObject({ siteId: w.a.siteId, onSite: 2, openExceptions: 0, today: { visits: 3, letIn: 2, turnedAway: 1, noSignal: 3 }, rollCall: null });
    expect(r.body.totals).toMatchObject({ onSite: 2, visits: 3 });
    // Another company sees none of it; a guard or a customer cannot open it.
    const bAdmin = await w.login('admin@b.test');
    const other = await w.http().get('/api/visitors/dashboard').set(auth(bAdmin));
    expect(other.body.sites).toEqual([]);
    expect((await w.http().get('/api/visitors/dashboard').set(g())).status).toBe(401);
  });

  it('counts visits by day, unit, guard or outcome, for a period', async () => {
    const byStatus = await w.http().get('/api/visitors/report?by=status').set(auth(supervisor));
    expect(byStatus.status).toBe(200);
    expect(byStatus.body.total).toMatchObject({ visits: 3, letIn: 2, turnedAway: 1, noSignal: 3, passengers: 6 });
    expect(byStatus.body.rows.map((x: { label: string; visits: number }) => [x.label, x.visits])).toEqual([
      ['Denied', 1],
      ['On site', 2],
    ]);
    const byUnit = await w.http().get(`/api/visitors/report?by=unit&siteId=${w.a.siteId}`).set(auth(supervisor));
    expect(byUnit.body.rows).toEqual([expect.objectContaining({ label: 'Unit 14', visits: 3 })]);
    expect((await w.http().get('/api/visitors/report?from=2026-01-01&to=2025-01-01').set(auth(supervisor))).status).toBe(400);
    expect((await w.http().get('/api/visitors/report?from=2024-01-01&to=2026-01-01').set(auth(supervisor))).status).toBe(400);
    const otherSite = await w.http().get(`/api/visitors/report?siteId=${w.b.siteId}`).set(auth(supervisor));
    // Another company's site: never its visits.
    expect(otherSite.status === 404 || otherSite.body.total.visits === 0).toBe(true);
  });

  it('downloads the visits as a spreadsheet, with ID numbers shortened and no formulas', async () => {
    const r = await w.http().get('/api/visitors/report.csv').set(auth(supervisor));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    const text = r.text;
    expect(text).toContain('Date,Time,Site,Gate,Visitor');
    expect(text).not.toContain('R00000001');
    expect(text).toContain('0001');
    expect(text).toContain(`"'=HYPERLINK(""x""), L"`);
    expect(text).toContain('By phone');
    const [a] = await ownerQuery(`SELECT after FROM audit_log WHERE action = 'visitors.report_download' ORDER BY at DESC LIMIT 1`);
    expect(a.after.rows).toBe(3);
  });

  it('runs an emergency roll-call: everyone on site with passengers and the guards on duty, ticked off', async () => {
    await ownerQuery(
      `INSERT INTO attendance (company_id, employee_id, site_id, shift_name, shift_date, duty_on_at, arrival_status) SELECT company_id, $1, $2, 'Day', current_date, now() - interval '1 hour', 'ON_TIME' FROM employees WHERE id = $1`,
      [guard.employeeId, w.a.siteId],
    );
    const start = await w.http().post(`${site()}/roll-calls`).set(auth(supervisor)).send({ reason: 'Fire alarm, block B' });
    expect(start.status).toBe(201);
    const call = start.body;
    const visitors = call.people.filter((p: { kind: string }) => p.kind === 'visitor');
    expect(visitors).toHaveLength(2);
    expect(visitors[0]).toMatchObject({ headcount: 3, status: null });
    expect(call.people.filter((p: { kind: string }) => p.kind === 'guard')).toHaveLength(1);
    expect(call.counts.people).toBe(7);
    expect(call.counts.waiting).toBe(7);
    expect((await w.http().post(`${site()}/roll-calls`).set(auth(supervisor)).send({})).status).toBe(409);
    const [n] = await ownerQuery(`SELECT title FROM notifications WHERE kind = 'roll_call' AND entity_id = $1 LIMIT 1`, [call.id]);
    expect(n.title).toBe('Emergency roll-call at ' + (await ownerQuery('SELECT name FROM sites WHERE id = $1', [w.a.siteId]))[0].name);

    const mark = (personKey: string, status: string) => w.http().post(`${site()}/roll-calls/${call.id}/mark`).set(auth(supervisor)).send({ personKey, status });
    let r = await mark(visitors[0].key, 'safe');
    expect(r.body.counts.safe).toBe(3);
    r = await mark(visitors[1].key, 'missing');
    expect(r.body.counts.missing).toBe(3);
    r = await mark(visitors[1].key, 'clear');
    expect(r.body.counts.missing).toBe(0);
    expect((await mark('visit:00000000-0000-4000-8000-000000000000', 'safe')).status).toBe(404);
    // A visitor who comes in during the roll-call joins the list.
    await letIn();
    const live = await w.http().get(`${site()}/roll-calls`).set(auth(supervisor));
    expect(live.body.current.people.filter((p: { kind: string }) => p.kind === 'visitor')).toHaveLength(3);
    // The marks are kept; nothing can change them.
    await expect(ownerQuery(`UPDATE roll_call_marks SET status = 'safe'`)).rejects.toThrow();

    const close = (note: string) => w.http().post(`${site()}/roll-calls/${call.id}/close`).set(auth(supervisor)).send({ note });
    expect((await close('')).status).toBe(400);
    const closed = await close('Two visitors went out the back gate; confirmed by phone.');
    expect(closed.status).toBe(200);
    expect(closed.body.closedAt).toBeTruthy();
    expect((await mark(visitors[0].key, 'safe')).status).toBe(409);
    const after = await w.http().get(`${site()}/roll-calls`).set(auth(supervisor));
    expect(after.body.current).toBeNull();
    expect(after.body.past[0]).toMatchObject({ reason: 'Fire alarm, block B', closeNote: 'Two visitors went out the back gate; confirmed by phone.' });
    // Another company cannot see or start one.
    const b = await w.login('admin@b.test');
    expect((await w.http().get(`${site()}/roll-calls`).set(auth(b))).status).toBe(404);
  });

  it('shows the supervisor the photo a guard took with an exception', async () => {
    const exit = await w
      .http()
      .post('/api/device/visitors/exit')
      .set(g())
      .field('data', JSON.stringify({ eventId: randomUUID(), visitId: null, idNumber: 'NEVERIN9', handling: { reason: 'not_scanned_in', note: 'Walked in with a delivery', allowed: true }, trustedAt: now(), deviceClock: now() }))
      .attach('photo', PNG, { filename: 'p.png', contentType: 'image/png' });
    expect(exit.status).toBe(200);
    const list = (await w.http().get(`${site()}/visit-exceptions`).set(auth(supervisor))).body;
    const x = list.open.find((e: { hasPhoto: boolean }) => e.hasPhoto);
    const photo = await w.http().get(`${site()}/visit-exceptions/${x.id}/photo`).set(auth(supervisor));
    expect(photo.status).toBe(200);
    expect(photo.headers['content-type']).toBe('image/png');
    const bAdmin = await w.login('admin@b.test');
    expect((await w.http().get(`/api/sites/${w.b.siteId}/visit-exceptions/${x.id}/photo`).set(auth(bAdmin))).status).toBe(404);
  });

  it('removes visitor photos and anonymises a visitor not seen for the retention period, once switched on', async () => {
    const id = await letIn({ type: 'pedestrian', vehicle: null, pax: null, person: { idNumber: 'OLD000001', surname: 'Oldvisit', names: 'A', document: 'passport', method: 'manual' } });
    await w.http().post(`/api/device/visitors/exit`).set(g()).field('data', JSON.stringify({ eventId: randomUUID(), visitId: id, idNumber: 'OLD000001', trustedAt: now(), deviceClock: now() }));
    await ownerQuery(`UPDATE visits SET captured_at = now() - interval '13 months' WHERE id = $1`, [id]);
    await ownerQuery(`UPDATE visitor_people SET last_seen = now() - interval '13 months' WHERE id_number = 'OLD000001'`);
    const retention = w.app.get(RetentionService);
    // Off until switched on.
    expect(await retention.run(w.a.companyId, new Date())).toBe(0);
    const owner = admin;
    const put = await w.http().put('/api/privacy/retention').set(auth(owner)).send({ enabled: true, selfieMonths: 12, patrolPhotoMonths: 12, boloMediaDays: 90, visitorMonths: 12, reason: 'Periods confirmed by our POPIA adviser' });
    expect(put.status).toBe(200);
    const status = await w.http().get('/api/privacy/retention').set(auth(owner));
    expect(status.body.wouldRemoveNow.visitorRecords).toBeGreaterThanOrEqual(1);
    expect(await retention.run(w.a.companyId, new Date())).toBeGreaterThanOrEqual(2);
    const [p] = await ownerQuery(`SELECT p.surname, p.id_number FROM visits v JOIN visitor_people p ON p.id = v.person_id WHERE v.id = $1`, [id]);
    expect(p.surname).toBe('Removed under retention');
    expect(p.id_number).toMatch(/^REMOVED-/);
    // The visit still counts.
    const [v] = await ownerQuery('SELECT status FROM visits WHERE id = $1', [id]);
    expect(v.status).toBe('exited');
  });
});
