import { NotificationsService, PushResult, PushSender, PushTarget } from '../src/notifications/notifications.service';
import { enrol, enrolmentData, ownerQuery, PNG, setupWorld, World } from './helpers';

class QuietSender implements PushSender {
  async send(_t: PushTarget, _p: string): Promise<PushResult> {
    return { ok: true };
  }
}

/**
 * Repeated warnings and the disciplinary inquiry (owner, 9 Oct 2026; D-53): at the third warning
 * management is alerted with all three and chooses; nothing is done by itself.
 */
describe('repeated warnings and the disciplinary inquiry', () => {
  let w: World;
  let admin: string;
  let employeeId: string;
  let deviceToken: string;
  let guardToken: string;
  let caseId: string;
  let today: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const warn = (charge: string, type = 'written_warning') =>
    w
      .http()
      .post('/api/hr/notices')
      .set(auth(admin))
      .send({ employeeId, type, subject: `Warning: ${charge}`, body: `You were warned about: ${charge}. Valid for six months.`, details: { charge } });

  beforeAll(async () => {
    w = await setupWorld();
    w.app.get(NotificationsService).sender = new QuietSender();
    admin = await w.login('admin@a.test');
    const d = await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Post phone', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Gate' });
    deviceToken = d.body.deviceToken;
    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    employeeId = o.body.officer.id;
    guardToken = (await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: o.body.officer.employeeNumber, pin: o.body.initialPin })).body.token;
    today = (await ownerQuery(`SELECT to_char(now() AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') AS d`))[0].d;
  });
  afterAll(() => w.app.close());

  it('alerts management at the third warning, with all three, and lists the employee as needing action', async () => {
    expect((await warn('Late for duty')).body.actionNeeded).toBe(false);
    expect((await warn('Sleeping on duty')).body.actionNeeded).toBe(false);
    expect((await w.http().get('/api/hr/attention').set(auth(admin))).body).toEqual([]);
    const third = await warn('Absent without leave', 'final_written_warning');
    expect(third.body.actionNeeded).toBe(true);
    const [a] = await ownerQuery(`SELECT title, body, lock_screen FROM notifications WHERE kind = 'warning_threshold' AND entity_id = $1 LIMIT 1`, [third.body.id]);
    expect(a.title).toBe('John Smith: third warning');
    expect(a.body).toContain('1. Written warning');
    expect(a.body).toContain('Late for duty');
    expect(a.body).toContain('3. Final written warning');
    expect(a.body).toContain('end of line memorandum');
    expect(a.lock_screen).toBe('An HR matter needs your attention.');
    const att = (await w.http().get('/api/hr/attention').set(auth(admin))).body;
    expect(att).toHaveLength(1);
    expect(att[0].warnings.map((x: { charge: string }) => x.charge)).toEqual(['Late for duty', 'Sleeping on duty', 'Absent without leave']);
    // Nothing was sent by itself.
    expect((await ownerQuery(`SELECT count(*)::int AS n FROM notices WHERE employee_id = $1`, [employeeId]))[0].n).toBe(3);
  });

  it('proceeds to a disciplinary inquiry: at least three days ahead, with the three rights documents', async () => {
    const draft = (await w.http().get(`/api/hr/case-draft/${employeeId}`).set(auth(admin))).body;
    expect(draft).toMatchObject({ hearingMinDays: 3, employeeName: 'John Smith' });
    const body = (date: string) => ({
      employeeId,
      charge: 'Repeated misconduct after three warnings',
      warningIds: draft.warnings.map((x: { id: string }) => x.id),
      hearingDate: date,
      hearingTime: '10:00',
      venue: 'Head office boardroom',
      chairperson: 'Ann Chair',
      initiator: 'Peter Supervisor',
      witnesses: ['Peter Supervisor'],
      subject: 'Notice to appear for a disciplinary inquiry',
      body: 'You are required to attend a disciplinary inquiry at Head office. Your rights and the documents are attached.',
    });
    const tooSoon = await w.http().post('/api/hr/cases').set(auth(admin)).send(body(day(2)));
    expect(tooSoon.status).toBe(400);
    expect(tooSoon.body.message).toMatch(/at least 3 days/);
    // The plain notice form cannot send an inquiry notice: there is one way, with every check.
    const plain = (date: string) =>
      w.http().post('/api/hr/notices').set(auth(admin)).send({ employeeId, type: 'notice_to_appear', subject: 'Notice to appear', body: 'You are required to attend a disciplinary inquiry at Head office.', details: { charge: 'Misconduct', hearingDate: date, hearingTime: '10:00', venue: 'Head office' } });
    expect((await plain(day(5))).status).toBe(400);
    expect((await plain(day(5))).body.message).toMatch(/Start a disciplinary inquiry/);
    const r = await w.http().post('/api/hr/cases').set(auth(admin)).send(body(day(3)));
    expect(r.status).toBe(201);
    caseId = r.body.id;
    expect((await w.http().post('/api/hr/cases').set(auth(admin)).send(body(day(5)))).status).toBe(409);
    // The employee is no longer on the "needs action" list.
    expect((await w.http().get('/api/hr/attention').set(auth(admin))).body).toEqual([]);
    // He reads the notice and the documents on the post phone.
    const g = { 'X-Device-Token': deviceToken, Authorization: `Bearer ${guardToken}` };
    const n = (await w.http().get(`/api/device/notices/${r.body.noticeId}`).set(g)).body;
    expect(n.documents.map((x: { title: string }) => x.title)).toEqual(['Your rights as an employee facing a disciplinary inquiry', 'Your right to call witnesses', 'Your right to an interpreter']);
    expect(n.documents[2].body).toContain(`Inquiry: ${day(3)} at 10:00, Head office boardroom`);
    const c = (await w.http().get(`/api/hr/cases/${caseId}`).set(auth(admin))).body;
    expect(c).toMatchObject({ status: 'notice_sent', hearingDate: day(3), hearingTime: '10:00', notice: { status: 'opened' } });
    expect(c.warnings).toHaveLength(3);
  });

  it('keeps the inquiry form, the signed copy, and publishes the decision; then the case never changes', async () => {
    const save = (h: Record<string, unknown>) => w.http().put(`/api/hr/cases/${caseId}/hearing`).set(auth(admin)).send(h);
    expect((await save({ heldOn: day(3), chairperson: 'Ann Chair' })).body.missing).toMatchObject({ finding: expect.any(String) });
    const publish = (subject: string, body: string) => w.http().post(`/api/hr/cases/${caseId}/publish`).set(auth(admin)).send({ subject, body });
    expect((await publish('Outcome', 'The outcome of the inquiry is guilty. Dismissal.')).status).toBe(400);
    await save({ heldOn: day(3), chairperson: 'Ann Chair', employeePresent: true, plea: 'not_guilty', finding: 'guilty', reasons: 'He was absent without leave on three occasions after warnings.', sanction: 'final_written_warning' });
    const up = await w.http().post(`/api/hr/cases/${caseId}/files`).set(auth(admin)).field('title', 'Signed inquiry form').attach('file', PNG, { filename: 'form.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    expect((await w.http().get(`/api/hr/cases/${caseId}/files/${up.body.id}`).set(auth(admin))).status).toBe(200);
    expect((await publish('Outcome of the inquiry', 'Finding: guilty. Sanction: final written warning. Appeal within [appeal period].')).status).toBe(400);
    const ok = await publish('Outcome of the inquiry', 'Finding: guilty. Reasons: absent without leave. Sanction: final written warning. You may appeal within five working days.');
    expect(ok.status).toBe(200);
    const c = (await w.http().get(`/api/hr/cases/${caseId}`).set(auth(admin))).body;
    expect(c.status).toBe('published');
    expect(c.outcome).toMatchObject({ typeLabel: 'Hearing outcome' });
    expect(c.events.map((e: { kind: string }) => e.kind)).toEqual(['opened', 'notice_sent', 'form_saved', 'form_saved', 'file_added', 'published']);
    expect((await save({ heldOn: day(3), finding: 'not_guilty' })).status).toBe(409);
    expect((await w.http().post(`/api/hr/cases/${caseId}/withdraw`).set(auth(admin)).send({ reason: 'Changed our mind' })).status).toBe(409);
    await expect(ownerQuery(`UPDATE disciplinary_cases SET charge = 'x' WHERE id = $1`, [caseId])).rejects.toThrow();
    await expect(ownerQuery(`DELETE FROM disciplinary_events`)).rejects.toThrow();
  });

  it('is for HR and management only, and another company sees nothing', async () => {
    const sup = await w.login('supervisor@a.test');
    expect((await w.http().get('/api/hr/cases').set(auth(sup))).status).toBe(403);
    const b = await w.login('admin@b.test');
    expect((await w.http().get(`/api/hr/cases/${caseId}`).set(auth(b))).status).toBe(404);
    expect((await w.http().get('/api/hr/cases').set(auth(b))).body).toEqual([]);
  });

  it('asks "are you aware?" for fewer than three warnings or an outside representative, and keeps the reason when the manager goes ahead', async () => {
    const o = await enrol(w, admin, enrolmentData(w.a.siteId, { idNumber: '9202204720083', fullName: 'Second Guard' }));
    const other = o.body.officer.id;
    const one = await w.http().post('/api/hr/notices').set(auth(admin)).send({ employeeId: other, type: 'written_warning', subject: 'Warning: Assault', body: 'You were warned about assault. Valid for six months.', details: { charge: 'Assault' } });
    const base = {
      employeeId: other,
      charge: 'Assault on a visitor at the gate',
      warningIds: [one.body.id],
      hearingDate: day(4),
      hearingTime: '09:00',
      venue: 'Head office',
      subject: 'Notice to appear for a disciplinary inquiry',
      body: 'You are required to attend a disciplinary inquiry at Head office about the assault.',
    };
    const first = await w.http().post('/api/hr/cases').set(auth(admin)).send(base);
    expect(first.status).toBe(400);
    expect(first.body.needsOverride).toBe('warnings');
    const second = await w.http().post('/api/hr/cases').set(auth(admin)).send({ ...base, overrideWarnings: 'Serious misconduct: assault', representative: 'Outside Lawyer' });
    expect(second.status).toBe(400);
    expect(second.body.needsOverride).toBe('representative');
    // A fellow employee as representative needs no override.
    const fellow = await w.http().post('/api/hr/cases').set(auth(admin)).send({ ...base, overrideWarnings: 'Serious misconduct: assault', representative: 'john smith', hearingDate: day(4) });
    expect(fellow.status).toBe(201);
    await w.http().post(`/api/hr/cases/${fellow.body.id}/withdraw`).set(auth(admin)).send({ reason: 'Opened again with the outside representative' });
    const ok = await w.http().post('/api/hr/cases').set(auth(admin)).send({ ...base, overrideWarnings: 'Serious misconduct: assault', representative: 'Outside Lawyer', overrideRepresentative: 'The employee asked in writing and the company agreed' });
    expect(ok.status).toBe(201);
    const c = (await w.http().get(`/api/hr/cases/${ok.body.id}`).set(auth(admin))).body;
    expect(c.overrides).toEqual([
      { what: 'Fewer than 3 warnings (1)', reason: 'Serious misconduct: assault' },
      { what: 'Representative not an employee: Outside Lawyer', reason: 'The employee asked in writing and the company agreed' },
    ]);
    expect(c.events[0].note).toContain('Override: Representative not an employee');
  });
});
