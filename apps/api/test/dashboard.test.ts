import { randomUUID } from 'node:crypto';
import { addDays } from '@onpar/rules';
import { enrol, enrolmentData, ownerQuery, setupWorld, World } from './helpers';

/**
 * Milestone 9: the management dashboard (section 6.11). One past day of known
 * activity is written straight into the database, so every figure can be checked exactly.
 */
describe('management dashboard', () => {
  let w: World;
  let manager: string;
  let supervisor: string;
  let john: string;
  let thabo: string;
  let officeSite: string;
  const D = '2026-03-10';
  const at = (hhmm: string, date = D) => `${date}T${hhmm}:00+02:00`;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const get = async (token: string, path: string) => w.http().get(`/api${path}`).set(auth(token));

  beforeAll(async () => {
    w = await setupWorld();
    const admin = await w.login('admin@a.test');
    manager = await w.login('manager@a.test');
    supervisor = await w.login('supervisor@a.test');
    const site = w.a.siteId;
    const c = w.a.companyId;
    john = (await enrol(w, admin, enrolmentData(site))).body.officer.id;
    thabo = (await enrol(w, admin, enrolmentData(site, { idNumber: '9202204720083', fullName: 'Thabo Nkosi' }))).body.officer.id;
    // A second site with no activity, which the supervisor is not assigned to.
    [{ id: officeSite }] = await ownerQuery(
      `INSERT INTO sites (company_id, name, address, client, minimum_grade, armed) VALUES ($1, 'Sandton Office Park', 'Sandton', 'Office Park', 'D', false) RETURNING id`,
      [c],
    );
    await ownerQuery(`INSERT INTO site_shifts (company_id, site_id, name, kind, start_time, end_time, guards_required) VALUES ($1, $2, 'Day', 'day', '07:00', '17:00', 1)`, [c, officeSite]);

    const [day] = await ownerQuery(`SELECT id FROM site_shifts WHERE site_id = $1 AND name = 'Day'`, [site]);
    // Attendance: John on time, Thabo 17 minutes late; nobody on the night shift.
    const shift = async (emp: string, status: string, late: number, on: string) => {
      const [a] = await ownerQuery(
        `INSERT INTO attendance (company_id, employee_id, site_id, shift_id, shift_name, shift_date, scheduled_start, scheduled_end, duty_on_at, duty_from_at,
                                 arrival_status, late_minutes, departure_status)
         VALUES ($1, $2, $3, $4, 'Day', $5, $6, $7, $8, $9, $10, $11, 'ON_TIME') RETURNING id`,
        [c, emp, site, day.id, D, at('06:00'), at('18:00'), at(on), at('18:02'), status, late],
      );
      return a.id as string;
    };
    const johnShift = await shift(john, 'ON_TIME', 0, '05:57');
    await shift(thabo, 'LATE', 17, '06:17');
    // John's Duty On declaration, with a comment.
    const ev = randomUUID();
    await ownerQuery(
      `INSERT INTO duty_events (id, company_id, attendance_id, employee_id, kind, official_at, trusted_at, device_clock, late_synced, drift_seconds, drift_flagged)
       VALUES ($1, $2, $3, $4, 'duty_on', $5, $5, $5, false, 0, false)`,
      [ev, c, johnShift, john, at('05:57')],
    );
    await ownerQuery(
      `INSERT INTO declarations (id, company_id, attendance_id, duty_event_id, employee_id, kind, wording_version, statements, comment, official_at, device_clock,
                                 late_synced, drift_seconds, drift_flagged, selfie_key)
       VALUES ($1, $2, $3, $4, $5, 'duty_on', 1, '[]', 'Torch at Gate 2 does not work', $6, $6, false, 0, false, 'selfie')`,
      [randomUUID(), c, johnShift, ev, john, at('05:58')],
    );

    // Tasks: a post task John completed, and a timed one nobody did (missed, as the day is over).
    const device = randomUUID();
    await ownerQuery(
      `INSERT INTO devices (id, company_id, label, serial_or_imei, site_id, status, last_seen_at, token_hash) VALUES ($1, $2, 'Device 001', '1', $3, 'active', now() - interval '2 hours', 'x')`,
      [device, c, site],
    );
    const [task] = await ownerQuery(
      `INSERT INTO tasks (company_id, site_id, title, assignee_type, assignee_device_id, recurrence, start_date) VALUES ($1, $2, 'Generator check', 'post', $3, 'daily', $4) RETURNING id`,
      [c, site, device, D],
    );
    const [task2] = await ownerQuery(
      `INSERT INTO tasks (company_id, site_id, title, assignee_type, assignee_employee_id, recurrence, start_date, time_required, due_time)
       VALUES ($1, $2, 'Lock the pool gate', 'employee', $3, 'once', $4, true, '09:00') RETURNING id`,
      [c, site, thabo, D],
    );
    await ownerQuery(
      `INSERT INTO task_occurrences (company_id, task_id, site_id, occurrence_date, title, instructions, photo_required, assignee_type, assignee_device_id, state, done_by, done_at)
       VALUES ($1, $2, $3, $4, 'Generator check', '', false, 'post', $5, 'completed', $6, $7)`,
      [c, task.id, site, D, device, john, at('07:10')],
    );
    await ownerQuery(
      `INSERT INTO task_occurrences (company_id, task_id, site_id, occurrence_date, title, instructions, due_time, photo_required, assignee_type, assignee_employee_id)
       VALUES ($1, $2, $3, $4, 'Lock the pool gate', '', '09:00', false, 'employee', $5)`,
      [c, task2.id, site, D, thabo],
    );

    // Reports: a Red one reported two days ago and never assigned (overdue, action required); an Amber one assigned today.
    const rep = (n: number, priority: string, stage: string, reportedAt: string) =>
      ownerQuery(
        `INSERT INTO reports (company_id, number, site_id, category, priority, description, stage, colour_slot, reported_by_employee, source, reported_at)
         VALUES ($1, $2::int, $3, 'security', $4, 'Report', $5, $2::int, $6, 'guard', $7)`,
        [c, n, site, priority, stage, john, reportedAt],
      );
    await rep(1, 'red', 'reported', new Date(Date.now() - 2 * 86400_000).toISOString());
    await rep(2, 'amber', 'assigned', new Date().toISOString());
    await rep(3, 'green', 'closed', at('10:00'));

    // A site re-order waiting.
    await ownerQuery(
      `INSERT INTO reorders (company_id, number, site_id, employee_id, kind, item, quantity, requested_at) VALUES ($1, 1, $2, $3, 'site', 'Toilet paper', '2 packs', now())`,
      [c, site, john],
    );

    // Patrols: John completed one internal patrol and missed one; a third is in progress and overdue.
    const [type] = await ownerQuery(`INSERT INTO patrol_types (company_id, site_id, code, name) VALUES ($1, $2, 'A', 'Internal') RETURNING id`, [c, site]);
    const [point] = await ownerQuery(
      `INSERT INTO patrol_points (company_id, site_id, patrol_type_id, name, qr_code, lat, lng) VALUES ($1, $2, $3, 'Generator room', 'QR-1', -26.1, 28.05) RETURNING id`,
      [c, site, type.id],
    );
    const patrol = async (i: number, state: string) => {
      const id = randomUUID();
      await ownerQuery(
        `INSERT INTO patrol_instances (id, company_id, site_id, patrol_type_id, attendance_id, employee_id, window_index, window_start, window_end, state, max_duration_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 30)`,
        [id, c, site, type.id, johnShift, john, i, at(`${String(6 + i * 4).padStart(2, '0')}:00`), at(`${String(10 + i * 4).padStart(2, '0')}:00`), state],
      );
      return id;
    };
    const done = await patrol(0, 'completed');
    await patrol(1, 'missed');
    const active = await patrol(2, 'active');
    await ownerQuery(`INSERT INTO patrol_alerts (company_id, patrol_id, site_id, employee_id, raised_at) VALUES ($1, $2, $3, $4, $5)`, [c, active, site, john, at('14:31')]);
    await ownerQuery(
      `INSERT INTO patrol_readings (company_id, patrol_id, point_id, check_id, label, kind, value_num, unit, out_of_limit, at)
       VALUES ($1, $2, $3, 'fuel', 'Fuel', 'number', 30, 'litres', true, $4)`,
      [c, done, point.id, at('06:20')],
    );

    // Training: Thabo's fire fighting has expired.
    await ownerQuery(`INSERT INTO qualifications (company_id, employee_id, type, name, expiry_date) VALUES ($1, $2, 'fire_fighting', 'Fire fighting', '2026-01-01')`, [c, thabo]);

    // Performance: Thabo lost 15 points over the three days before, so he needs attention; John was on time on the day.
    for (const n of [1, 2, 3]) {
      await ownerQuery(
        `INSERT INTO performance_events (company_id, employee_id, site_id, event_date, event_type, impact, source_type, evidence, created_by_type)
         VALUES ($1, $2, $3, $4, 'missed_shift', -5, 'manual', 'Test', 'system')`,
        [c, thabo, site, addDays(D, -n)],
      );
    }
    await ownerQuery(
      `INSERT INTO performance_events (company_id, employee_id, site_id, event_date, event_type, impact, source_type, source_id, evidence, created_by_type)
       VALUES ($1, $2, $3, $4, 'on_time', 1, 'attendance', $5, 'On time for the Day shift.', 'system')`,
      [c, john, site, D, johnShift],
    );
  });
  afterAll(() => w.app.close());

  it('shows every figure in section 6.11 for the company', async () => {
    const r = await get(manager, `/dashboard?date=${D}`);
    expect(r.status).toBe(200);
    const t = r.body.totals;
    // 2 + 2 posts at Estate ABC and 1 at the office park; the night shift and the office park post were never filled.
    expect(t.attendance).toEqual({ scheduled: 5, onTime: 1, late: 1, absent: 3, onDuty: 0 });
    expect(t.tasks).toEqual({ total: 2, completed: 1, outstanding: 0, overdue: 0, missed: 1, couldNotComplete: 0 });
    expect(t.reports).toEqual({ open: 2, actionRequired: 1, overdue: 1, redOpen: 1 });
    expect(t.reorders).toEqual({ open: 1 });
    expect(t.patrols).toEqual({ alertsOpen: 1, completed: 1, due: 2, compliancePercent: 50 });
    expect(t.training).toEqual({ total: 5, compliant: 4, expiring: 0, expired: 1, compliantPercent: 80 });
    expect(t.performance).toEqual({ officers: 2, needsAttention: 1 });
    expect(t.devices).toEqual({ active: 1, offline: 1 });
    expect(r.body.patrolCompliance).toEqual([expect.objectContaining({ siteName: 'Estate ABC', typeCode: 'A', completed: 1, due: 2, compliancePercent: 50 })]);
    expect(r.body.alerts).toEqual([expect.objectContaining({ employeeName: 'John Smith', typeName: 'Internal' })]);
  });

  it('breaks the figures down by site', async () => {
    const r = await get(manager, `/dashboard?date=${D}`);
    expect(r.body.sites.map((s: { siteName: string }) => s.siteName)).toEqual(['Estate ABC', 'Sandton Office Park']);
    const office = r.body.sites[1].figures;
    expect(office.attendance).toEqual({ scheduled: 1, onTime: 0, late: 0, absent: 1, onDuty: 0 });
    expect(office.training.total).toBe(0);
  });

  it("limits a supervisor to their own sites", async () => {
    const r = await get(supervisor, `/dashboard?date=${D}`);
    expect(r.body.sites.map((s: { siteName: string }) => s.siteName)).toEqual(['Estate ABC']);
    expect(r.body.totals.attendance.scheduled).toBe(4);
    expect((await get(supervisor, `/dashboard/sites/${officeSite}?date=${D}`)).status).toBe(404);
  });

  it('drills down to a site: each officer, declarations, readings and devices', async () => {
    const r = await get(supervisor, `/dashboard/sites/${w.a.siteId}?date=${D}`);
    expect(r.status).toBe(200);
    const [j, t] = r.body.officers;
    expect(j).toMatchObject({ name: 'John Smith', tasks: { completed: 1, open: 0 }, patrols: { completed: 1, missed: 1, total: 2 }, reportsMade: 1, training: 'COMPLIANT', position: 'ON_PAR' });
    expect(j.shifts).toEqual([expect.objectContaining({ shiftName: 'Day', arrivalStatus: 'ON_TIME' })]);
    expect(t).toMatchObject({ name: 'Thabo Nkosi', training: 'EXPIRED', score: 65, position: 'NEEDS_ATTENTION', positionLabel: 'Needs Attention' });
    expect(t.shifts[0]).toMatchObject({ arrivalStatus: 'LATE', lateMinutes: 17 });
    expect(r.body.declarations).toEqual([expect.objectContaining({ employeeName: 'John Smith', kind: 'duty_on', comment: 'Torch at Gate 2 does not work', hasSelfie: true })]);
    expect(r.body.readings).toEqual([expect.objectContaining({ pointName: 'Generator room', label: 'Fuel', valueNum: 30, outOfLimit: true })]);
    expect(r.body.devices).toEqual([expect.objectContaining({ label: 'Device 001', status: 'active' })]);
  });

  it("drills down to an officer's day and each event", async () => {
    const r = await get(supervisor, `/dashboard/officers/${john}?date=${D}`);
    expect(r.status).toBe(200);
    expect(r.body.officer).toMatchObject({ name: 'John Smith', homeSiteName: 'Estate ABC' });
    expect(r.body.shifts).toEqual([expect.objectContaining({ arrivalStatus: 'ON_TIME', declarations: [expect.objectContaining({ kind: 'duty_on', comment: 'Torch at Gate 2 does not work' })] })]);
    // The post's task counts for every guard on duty there.
    expect(r.body.tasks).toEqual([expect.objectContaining({ title: 'Generator check', status: 'completed', doneByMe: true })]);
    expect(r.body.patrols.map((p: { state: string }) => p.state)).toEqual(['completed', 'missed', 'active']);
    expect(r.body.performance).toMatchObject({ score: 81, position: 'ON_PAR', events: [expect.objectContaining({ type: 'on_time', impact: 1 })] });
    expect(r.body.training.map((q: { name: string }) => q.name)).toEqual(['PSIRA registration (grade C)', 'First aid level 1']);
    const thabos = await get(supervisor, `/dashboard/officers/${thabo}?date=${D}`);
    // Thabo was on duty too, so he shares the post's task (done by John) as well as his own.
    expect(thabos.body.tasks).toEqual([
      expect.objectContaining({ title: 'Lock the pool gate', status: 'missed' }),
      expect.objectContaining({ title: 'Generator check', status: 'completed', doneByMe: false, doneByName: 'John Smith' }),
    ]);
  });

  it('gives a client or estate manager the summary only, without people', async () => {
    const [u] = await ownerQuery(
      `INSERT INTO users (company_id, email, full_name, password_hash, role) SELECT company_id, 'client@a.test', 'Client', password_hash, 'client_manager' FROM users WHERE email = 'manager@a.test' RETURNING id`,
    );
    await ownerQuery('INSERT INTO user_sites (company_id, user_id, site_id) VALUES ($1, $2, $3)', [w.a.companyId, u.id, w.a.siteId]);
    const client = await w.login('client@a.test');
    const r = await get(client, `/dashboard?date=${D}`);
    expect(r.status).toBe(200);
    expect(r.body.totals.attendance.scheduled).toBe(4);
    expect(r.body.totals).toMatchObject({ training: null, performance: null, devices: null });
    expect(r.body.alerts).toEqual([]);
    expect((await get(client, `/dashboard/sites/${w.a.siteId}?date=${D}`)).status).toBe(403);
    expect((await get(client, `/dashboard/officers/${john}?date=${D}`)).status).toBe(403);
  });

  it('keeps each company to its own figures (scenario 14)', async () => {
    const b = await w.login('manager@b.test');
    const r = await get(b, `/dashboard?date=${D}`);
    expect(r.body.sites.map((s: { siteName: string }) => s.siteName)).toEqual(['Estate ABC']);
    expect(r.body.totals.reports.open).toBe(0);
    expect(r.body.totals.performance.officers).toBe(0);
    expect((await get(b, `/dashboard/sites/${w.a.siteId}`)).status).toBe(404);
    expect((await get(b, `/dashboard/officers/${john}`)).status).toBe(404);
  });

  it('uses today when no valid date is given', async () => {
    const r = await get(manager, '/dashboard?date=yesterday');
    expect(r.body.date).toBe(r.body.today);
  });
});
