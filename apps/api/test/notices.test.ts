import { randomUUID } from 'node:crypto';
import { NotificationsService, PushResult, PushSender, PushTarget } from '../src/notifications/notifications.service';
import { NoticesService } from '../src/notices/notices.service';
import { enrol, enrolmentData, ownerQuery, PNG, setupWorld, World } from './helpers';

class QuietSender implements PushSender {
  async send(_t: PushTarget, _p: string): Promise<PushResult> {
    return { ok: true };
  }
}

/** HR notices with delivery tracking, and the employee portal (brief sections 6.14 and 6.16, milestone 13; scenarios in section 43). */
describe('HR notices and the employee portal', () => {
  let w: World;
  let admin: string;
  let supervisor: string;
  let deviceToken: string;
  let guard: { token: string; employeeId: string };
  let portal: string;
  let login: string;
  let noticeId: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const g = () => ({ 'X-Device-Token': deviceToken, Authorization: `Bearer ${guard.token}` });
  const warning = (extra: Record<string, unknown> = {}) => ({
    employeeId: guard.employeeId,
    type: 'written_warning',
    subject: 'Written warning: Late for duty',
    body: 'You were late for duty on 7 October 2026. This warning is valid for six months.',
    details: { charge: 'Late for duty', incidentDate: '2026-10-07' },
    ...extra,
  });

  beforeAll(async () => {
    w = await setupWorld();
    w.app.get(NotificationsService).sender = new QuietSender();
    admin = await w.login('admin@a.test');
    supervisor = await w.login('supervisor@a.test');
    const d = await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Post phone', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Gate' });
    deviceToken = d.body.deviceToken;
    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    const l = await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: o.body.officer.employeeNumber, pin: o.body.initialPin });
    guard = { token: l.body.token, employeeId: o.body.officer.id };
  });
  afterAll(() => w.app.close());

  it('is for HR and management only, never the site supervisor', async () => {
    expect((await w.http().get('/api/hr/notices').set(auth(supervisor))).status).toBe(403);
    expect((await w.http().post('/api/hr/notices').set(auth(supervisor)).send(warning())).status).toBe(403);
    expect((await w.http().get('/api/hr/notices').set(auth(admin))).body).toEqual([]);
  });

  it('fills the form from the employee record, and will not send a notice with parts still to fill in', async () => {
    const c = await w.http().get(`/api/hr/notice-context/${guard.employeeId}`).set(auth(admin));
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ prior: { written_warning: 0 }, portal: null, ackHours: 48 });
    const bad = await w.http().post('/api/hr/notices').set(auth(admin)).send(warning({ body: 'Late. Valid for [validity period].' }));
    expect(bad.status).toBe(400);
    const r = await w.http().post('/api/hr/notices').set(auth(admin)).send(warning());
    expect(r.status).toBe(201);
    noticeId = r.body.id;
    expect((await w.http().get(`/api/hr/notice-context/${guard.employeeId}`).set(auth(admin))).body.prior.written_warning).toBe(1);
    // A notice is never changed.
    await expect(ownerQuery(`UPDATE notices SET subject = 'changed'`)).rejects.toThrow();
    await expect(ownerQuery(`DELETE FROM notice_events`)).rejects.toThrow();
  });

  it('shows the post phone only a generic line, never the notice', async () => {
    const r = await w.http().get('/api/device/personal-message').set(g());
    expect(r.body).toEqual({ waiting: true, text: 'You have a personal message. Open it on your own phone or see your supervisor.' });
    expect(JSON.stringify(r.body)).not.toContain('Late');
  });

  it('opens the portal with a one-time code from HR, then a password of his own', async () => {
    const code = await w.http().post(`/api/hr/employees/${guard.employeeId}/portal-code`).set(auth(admin));
    expect(code.status).toBe(200);
    expect(code.body.code).toMatch(/^[A-Z2-9]{10}$/);
    login = code.body.login;
    expect((await w.http().post('/api/portal/activate').send({ code: 'WRONGCODE1', password: 'my-own-pass' })).status).toBe(400);
    expect((await w.http().post('/api/portal/activate').send({ code: code.body.code, password: 'short' })).status).toBe(400);
    const a = await w.http().post('/api/portal/activate').send({ code: code.body.code.toLowerCase().replace(/(.{5})/, '$1 '), password: 'my-own-pass' });
    expect(a.status).toBe(200);
    expect(a.body.login).toBe(login);
    // The code works once.
    expect((await w.http().post('/api/portal/activate').send({ code: code.body.code, password: 'another-pass' })).status).toBe(400);
    expect((await w.http().post('/api/portal/login').send({ login, password: 'wrong-pass' })).status).toBe(401);
    const s = await w.http().post('/api/portal/login').send({ login, password: 'my-own-pass' });
    expect(s.status).toBe(200);
    portal = s.body.token;
    // A portal sign-in is not a staff sign-in.
    expect((await w.http().get('/api/hr/notices').set(auth(portal))).status).toBe(401);
  });

  it('tracks the notice: sent, delivered, opened, acknowledged, each with a time', async () => {
    const list = await w.http().get('/api/portal/notices').set(auth(portal));
    expect(list.body.notices).toEqual([expect.objectContaining({ id: noticeId, typeLabel: 'Written warning', status: 'delivered' })]);
    expect(list.body.notices[0].body).toBeUndefined();
    const open = await w.http().get(`/api/portal/notices/${noticeId}`).set(auth(portal));
    expect(open.body).toMatchObject({ status: 'opened', body: expect.stringContaining('six months') });
    expect(open.body.ackText).toMatch(/does not mean I agree/);
    const ack = await w.http().post(`/api/portal/notices/${noticeId}/acknowledge`).set(auth(portal));
    expect(ack.body.status).toBe('acknowledged');
    const hr = await w.http().get(`/api/hr/notices/${noticeId}`).set(auth(admin));
    expect(hr.body.events.map((e: { kind: string }) => e.kind)).toEqual(['sent', 'delivered', 'opened', 'acknowledged']);
    expect(hr.body.times.acknowledged).toBeTruthy();
    expect((await w.http().get('/api/device/personal-message').set(g())).body.waiting).toBe(false);
    // Another company's HR cannot see it.
    const b = await w.login('admin@b.test');
    expect((await w.http().get(`/api/hr/notices/${noticeId}`).set(auth(b))).status).toBe(404);
  });

  it('asks HR to deliver by hand when a notice is not acknowledged in time, and records the signed copy', async () => {
    await w.http().put('/api/hr/settings').set(auth(admin)).send({ noticeAckHours: 1, reason: 'Testing the reminder' });
    const r = await w.http().post('/api/hr/notices').set(auth(admin)).send(warning({ type: 'general_message', subject: 'Uniform collection', body: 'Please collect your new uniform from the office on Friday.', details: {} }));
    const id = r.body.id;
    const svc = w.app.get(NoticesService);
    expect(await svc.sweepAll(new Date())).toBe(0);
    expect(await svc.sweepAll(new Date(Date.now() + 2 * 3600_000))).toBe(1);
    expect(await svc.sweepAll(new Date(Date.now() + 3 * 3600_000))).toBe(0);
    const [alert] = await ownerQuery(`SELECT title, lock_screen FROM notifications WHERE kind = 'notice_unacknowledged' AND entity_id = $1 LIMIT 1`, [id]);
    expect(alert).toEqual({ title: 'A notice needs hand delivery', lock_screen: 'An HR notice needs your attention.' });
    expect((await w.http().get(`/api/hr/notices/${id}`).set(auth(admin))).body.status).toBe('hand_delivery_requested');
    const hand = await w.http().post(`/api/hr/notices/${id}/hand-delivered`).set(auth(admin)).field('note', 'Handed to him at the gate by Peter; he signed the copy.').attach('photo', PNG, { filename: 'signed.png', contentType: 'image/png' });
    expect(hand.status).toBe(200);
    const after = (await w.http().get(`/api/hr/notices/${id}`).set(auth(admin))).body;
    expect(after.status).toBe('hand_delivered');
    const ev = after.events.find((e: { kind: string }) => e.kind === 'hand_delivered');
    expect(ev.hasPhoto).toBe(true);
    expect((await w.http().get(`/api/hr/notices/${id}/events/${ev.id}/photo`).set(auth(admin))).status).toBe(200);
  });

  it('suggests a pattern to HR, which only fills in the form', async () => {
    for (let i = 1; i <= 3; i++) {
      await ownerQuery(
        `INSERT INTO attendance (company_id, employee_id, site_id, shift_name, shift_date, duty_on_at, duty_from_at, arrival_status, late_minutes)
         SELECT company_id, $1, $2, 'Day', current_date - $3::int, now() - make_interval(days => $3::int), now() - make_interval(days => $3::int) + interval '8 hours', 'LATE', 10 FROM employees WHERE id = $1`,
        [guard.employeeId, w.a.siteId, i + 2],
      );
    }
    // A written warning is already on file from earlier in this test, so nothing is suggested.
    expect((await w.http().get('/api/hr/suggestions').set(auth(admin))).body).toEqual([]);
    const o = await enrol(w, admin, enrolmentData(w.a.siteId, { idNumber: '9202204720083', fullName: 'Sam Late' }));
    for (let i = 1; i <= 3; i++) {
      await ownerQuery(
        `INSERT INTO attendance (company_id, employee_id, site_id, shift_name, shift_date, duty_on_at, duty_from_at, arrival_status, late_minutes)
         SELECT company_id, $1, $2, 'Day', current_date - $3::int, now() - make_interval(days => $3::int), now() - make_interval(days => $3::int) + interval '8 hours', 'LATE', 10 FROM employees WHERE id = $1`,
        [o.body.officer.id, w.a.siteId, i + 2],
      );
    }
    const s = await w.http().get('/api/hr/suggestions').set(auth(admin));
    expect(s.body).toEqual([expect.objectContaining({ employeeId: o.body.officer.id, suggest: 'verbal_warning', pattern: '3 late arrivals in the last 30 days and no warning on file' })]);
    expect((await ownerQuery(`SELECT count(*)::int AS n FROM notices WHERE employee_id = $1`, [o.body.officer.id]))[0].n).toBe(0);
  });

  it('a new code from HR stops the old portal sign-in', async () => {
    await w.http().post(`/api/hr/employees/${guard.employeeId}/portal-code`).set(auth(admin));
    expect((await w.http().get('/api/portal/notices').set(auth(portal))).status).toBe(401);
    expect(randomUUID()).toBeTruthy();
  });
});
