import { randomUUID } from 'node:crypto';
import { enrol, enrolmentData, ownerQuery, setupWorld, World } from './helpers';

/** Finishing The Wire (owner, 8 Oct 2026): fast response, mentoring, leavers, reminders, the hand-in file and the year's Bob Wire. */
describe('The Wire: finishing touches', () => {
  let w: World;
  let admin: string;
  let mentor: { id: string; number: string; pin: string };
  let mentee: { id: string; number: string; pin: string };
  let device: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const now = () => new Date().toISOString();
  const guard = async (fullName: string, idNumber: string) => {
    const o = await enrol(w, admin, enrolmentData(w.a.siteId, { fullName, idNumber }));
    return { id: o.body.officer.id as string, number: o.body.officer.employeeNumber as string, pin: o.body.initialPin as string };
  };
  const shifts = (employeeId: string, early: number) =>
    ownerQuery(
      `INSERT INTO attendance (company_id, employee_id, site_id, shift_name, shift_date, scheduled_start, scheduled_end, duty_on_at, duty_from_at, arrival_status)
       SELECT $1, $2, $3, 'Day', d::date, (d::date + time '06:00') AT TIME ZONE 'Africa/Johannesburg', (d::date + time '18:00') AT TIME ZONE 'Africa/Johannesburg',
              ((d::date + time '06:00') AT TIME ZONE 'Africa/Johannesburg') - make_interval(mins => $4), (d::date + time '18:00') AT TIME ZONE 'Africa/Johannesburg', 'ON_TIME'
         FROM generate_series('2026-09-01'::date, '2026-09-20'::date, interval '1 day') d`,
      [w.a.companyId, employeeId, w.a.siteId, early],
    );
  const entries = (id: string, rule: string) => ownerQuery(`SELECT barbs, kind FROM wire_entries WHERE employee_id = $1 AND rule = $2`, [id, rule]);

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    mentor = await guard('Thabo Mentor', '8001015009087');
    mentee = await guard('Sipho Learner', '9202204720083');
    device = (await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Gate', serialOrImei: '356938035643555', siteId: w.a.siteId, postName: 'Main gate' })).body.deviceToken;
    await w.http().put('/api/wire/settings').set(auth(admin)).send({ startedOn: '2026-09-01' });
    await shifts(mentor.id, 20);
    await shifts(mentee.id, 0);
    // Ten tasks for the mentor in September, all opened within five minutes of his Duty On and done.
    const task = (await ownerQuery(`INSERT INTO tasks (company_id, site_id, title, assignee_type, assignee_employee_id, recurrence, start_date) VALUES ($1, $2, 'Gate check', 'employee', $3, 'daily', '2026-09-01') RETURNING id`, [w.a.companyId, w.a.siteId, mentor.id]))[0].id;
    await ownerQuery(
      `INSERT INTO task_occurrences (company_id, task_id, site_id, occurrence_date, title, instructions, photo_required, assignee_type, assignee_employee_id, state, done_by, done_at, seen_at, created_at)
       SELECT $1, $2, $3, d::date, 'Gate check', '', false, 'employee', $4, 'completed', $4, (d::date + time '08:00') AT TIME ZONE 'Africa/Johannesburg',
              (d::date + time '05:45') AT TIME ZONE 'Africa/Johannesburg', (d::date + time '00:01') AT TIME ZONE 'Africa/Johannesburg'
         FROM generate_series('2026-09-01'::date, '2026-09-10'::date, interval '1 day') d`,
      [w.a.companyId, task, w.a.siteId, mentor.id],
    );
    // The mentee's August was weak, so a better September is an improvement. He is paired with the mentor.
    await ownerQuery(`INSERT INTO wire_months (employee_id, month, company_id, overall, streak, facts) VALUES ($1, '2026-08', $2, 50, 0, '{}')`, [mentee.id, w.a.companyId]);
  });
  afterAll(() => w.app.close());

  it('pairs a mentor with a guard, up to the limit, and not with himself', async () => {
    expect((await w.http().put(`/api/wire/guards/${mentee.id}/mentor`).set(auth(admin)).send({ mentorId: mentee.id })).status).toBe(400);
    const r = await w.http().put(`/api/wire/guards/${mentee.id}/mentor`).set(auth(admin)).send({ mentorId: mentor.id });
    expect(r.status).toBe(200);
    expect(r.body.mentor).toMatchObject({ name: 'Thabo Mentor' });
    await ownerQuery(`UPDATE wire_mentors SET start_date = '2026-09-01'`);
    expect((await w.http().get(`/api/wire/guards/${mentor.id}`).set(auth(admin))).body.mentees.map((m: { name: string }) => m.name)).toEqual(['Sipho Learner']);
  });

  it('at month end: fast response for tasks opened in time, and the mentor award when his mentee improves', async () => {
    await w.http().post('/api/wire/run').set(auth(admin));
    expect(await entries(mentor.id, 'fast_response')).toEqual([{ barbs: 5, kind: 'earned' }]);
    expect((await ownerQuery(`SELECT award FROM wire_months WHERE employee_id = $1 AND month = '2026-09'`, [mentee.id]))[0].award).toBe('improvement');
    expect(await entries(mentor.id, 'mentor')).toEqual([{ barbs: 10, kind: 'earned' }]);
    expect(await entries(mentee.id, 'fast_response')).toEqual([]);
  });

  it('a guard opening a task on his phone marks it seen, once', async () => {
    const today = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
    const task = (await ownerQuery(`INSERT INTO tasks (company_id, site_id, title, assignee_type, assignee_employee_id, recurrence, start_date) VALUES ($1, $2, 'Radio check', 'employee', $3, 'once', $4) RETURNING id`, [w.a.companyId, w.a.siteId, mentor.id, today]))[0].id;
    const occ = (await ownerQuery(`INSERT INTO task_occurrences (company_id, task_id, site_id, occurrence_date, title, instructions, photo_required, assignee_type, assignee_employee_id) VALUES ($1, $2, $3, $4, 'Radio check', '', false, 'employee', $5) RETURNING id`, [w.a.companyId, task, w.a.siteId, today, mentor.id]))[0].id;
    const token = (await w.http().post('/api/device/login').set('X-Device-Token', device).send({ login: mentor.number, pin: mentor.pin })).body.token;
    const phone = { 'X-Device-Token': device, Authorization: `Bearer ${token}` };
    expect((await w.http().post(`/api/device/tasks/${occ}/seen`).set(phone).send({ trustedAt: now(), deviceClock: now() })).body).toEqual({ seen: true, first: true });
    expect((await w.http().post(`/api/device/tasks/${occ}/seen`).set(phone).send({ trustedAt: now(), deviceClock: now() })).body).toEqual({ seen: true, first: false });
    expect((await ownerQuery(`SELECT seen_by FROM task_occurrences WHERE id = $1`, [occ]))[0].seen_by).toBe(mentor.id);
    // My Wire on his phone names his mentee, and the year's Bob Wire once named.
    await w.http().put('/api/wire/settings').set(auth(admin)).send({ standardBearer: { name: 'Thabo Mentor', year: 2026 } });
    const wire = (await w.http().get('/api/device/wire').set(phone)).body;
    expect(wire).toMatchObject({ mentees: ['Sipho Learner'], mentor: null, standardBearer: { name: 'Thabo Mentor', year: 2026 } });
    expect((await w.http().get('/api/wire/standard-bearer').set(auth(admin))).body).toMatchObject({ current: { name: 'Thabo Mentor', year: 2026 }, candidates: [] });
  });

  it('the month’s supplied hand-ins come out as a file for payroll and franchisees', async () => {
    const item = (await ownerQuery(`INSERT INTO wire_items (company_id, name, category, barbs, cost_rand) VALUES ($1, 'Airtime, own number', 'airtime', 50, 50) RETURNING id`, [w.a.companyId]))[0].id;
    await ownerQuery(
      `INSERT INTO wire_handins (id, company_id, employee_id, site_id, item_id, item_name, category, barbs, cost_rand, status, done_at) VALUES ($1, $2, $3, $4, $5, 'Airtime, own number', 'airtime', 50, 50, 'supplied', '2026-09-15T10:00:00+02:00')`,
      [randomUUID(), w.a.companyId, mentor.id, w.a.siteId, item],
    );
    const r = await w.http().get('/api/wire/handins.csv?month=2026-09').set(auth(admin));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.text).toContain('Supplied,Employee number,Guard,Site,Employer,Benefit,Kind,Barbs,Cost (R)');
    expect(r.text).toContain('2026-09-15');
    expect(r.text).toContain('Thabo Mentor');
    expect(r.text).toContain('Company A');
    const manager = await w.login('manager@a.test');
    expect((await w.http().get('/api/wire/handins.csv?month=2026-09').set(auth(manager))).status).toBe(403);
  });

  it('a guard who leaves keeps his Wire; his available barbs lapse after the set days', async () => {
    const before = (await w.http().get(`/api/wire/guards/${mentee.id}`).set(auth(admin))).body;
    expect(before.available).toBeGreaterThan(0);
    await ownerQuery(`UPDATE employees SET status = 'inactive' WHERE id = $1`, [mentee.id]);
    await w.http().post('/api/wire/run').set(auth(admin));
    expect((await ownerQuery(`SELECT left_on FROM wire_profiles WHERE employee_id = $1`, [mentee.id]))[0].left_on).not.toBeNull();
    expect(await entries(mentee.id, 'lapsed')).toEqual([]);
    await ownerQuery(`UPDATE wire_profiles SET left_on = current_date - 31 WHERE employee_id = $1`, [mentee.id]);
    await w.http().post('/api/wire/run').set(auth(admin));
    const after = (await w.http().get(`/api/wire/guards/${mentee.id}`).set(auth(admin))).body;
    expect(after.wireTotal).toBe(before.wireTotal);
    expect(after.available).toBe(0);
    await w.http().post('/api/wire/run').set(auth(admin));
    expect(await entries(mentee.id, 'lapsed')).toHaveLength(1);
  });

  it('reminds the owner once about a note that has waited a day', async () => {
    await ownerQuery(`INSERT INTO wire_notes (id, company_id, employee_id, site_id, noticed, suggestion, improves, sent_at) VALUES ($1, $2, $3, $4, 'x x x x x', 'y y y y y', 'z z z', now() - interval '2 days')`, [randomUUID(), w.a.companyId, mentor.id, w.a.siteId]);
    await w.http().post('/api/wire/run').set(auth(admin));
    await w.http().post('/api/wire/run').set(auth(admin));
    const alerts = await ownerQuery(`SELECT n.kind FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.kind = 'wire_waiting' AND u.email = 'admin@a.test'`);
    expect(alerts).toHaveLength(1);
  });
});
