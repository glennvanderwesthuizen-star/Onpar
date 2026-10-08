import { randomUUID } from 'node:crypto';
import { enrol, enrolmentData, ownerQuery, setupWorld, World } from './helpers';

/** The Wire, the guard reward programme (owner's rule book and build specification, 8 Oct 2026). */
describe('The Wire', () => {
  let w: World;
  let admin: string;
  let manager: string;
  let ready: { id: string; number: string; pin: string };
  let onTheHour: { id: string; number: string; pin: string };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const guard = async (fullName: string, idNumber: string) => {
    const o = await enrol(w, admin, enrolmentData(w.a.siteId, { fullName, idNumber }));
    return { id: o.body.officer.id as string, number: o.body.officer.employeeNumber as string, pin: o.body.initialPin as string };
  };
  /** Twenty worked day shifts in a month, on duty `early` minutes before 06:00. */
  const shifts = (employeeId: string, month: string, early: number, days = 20) =>
    ownerQuery(
      `INSERT INTO attendance (company_id, employee_id, site_id, shift_name, shift_date, scheduled_start, scheduled_end, duty_on_at, duty_from_at, arrival_status)
       SELECT $1, $2, $3, 'Day', d::date, (d::date + time '06:00') AT TIME ZONE 'Africa/Johannesburg', (d::date + time '18:00') AT TIME ZONE 'Africa/Johannesburg',
              ((d::date + time '06:00') AT TIME ZONE 'Africa/Johannesburg') - make_interval(mins => $5), (d::date + time '18:00') AT TIME ZONE 'Africa/Johannesburg', 'ON_TIME'
         FROM generate_series($4::date, $4::date + ($6 - 1), interval '1 day') d`,
      [w.a.companyId, employeeId, w.a.siteId, `${month}-01`, early, days],
    );
  const entries = (employeeId: string) => ownerQuery(`SELECT rule, barbs, source_key, to_char(entry_date, 'YYYY-MM') AS month FROM wire_entries WHERE employee_id = $1 ORDER BY id`, [employeeId]);
  const sum = (rows: { barbs: number }[]) => rows.reduce((a, r) => a + r.barbs, 0);

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    manager = await w.login('manager@a.test');
    ready = await guard('Sipho Ready', '8001015009087');
    onTheHour = await guard('Thabo Hour', '9202204720083');
    // The pilot started on 1 July; three finished months of real shifts.
    expect((await w.http().put('/api/wire/settings').set(auth(admin)).send({ startedOn: '2099-01-01' })).status).toBe(400);
    expect((await w.http().put('/api/wire/settings').set(auth(admin)).send({ startedOn: '2026-07-01' })).status).toBe(200);
    for (const m of ['2026-07', '2026-08', '2026-09']) {
      await shifts(ready.id, m, 20);
      await shifts(onTheHour.id, m, 0);
    }
  });
  afterAll(() => w.app.close());

  it('only managers see The Wire, and only the administrator changes it', async () => {
    expect((await w.http().get('/api/wire')).status).toBe(401);
    const supervisor = await w.login('supervisor@a.test');
    expect((await w.http().get('/api/wire').set(auth(supervisor))).status).toBe(200);
    expect((await w.http().put('/api/wire/settings').set(auth(manager)).send({})).status).toBe(403);
    expect((await w.http().post('/api/wire/run').set(auth(manager))).status).toBe(403);
  });

  it('pays shift barbs and the month-end awards from what On Par recorded, once', async () => {
    const r = await w.http().post('/api/wire/run').set(auth(admin));
    expect(r.status).toBe(200);
    expect(r.body.months).toBe(3);
    const mine = await entries(ready.id);
    // 20 shifts a month, three barbs each.
    expect(mine.filter((e) => e.rule === 'ready_for_duty')).toHaveLength(60);
    // At the standard three months in a row: 20, 25, 30.
    expect(mine.filter((e) => e.rule === 'standard').map((e) => e.barbs)).toEqual([20, 25, 30]);
    expect(mine.filter((e) => e.rule === 'improvement')).toHaveLength(0);
    expect(mine.filter((e) => e.rule === 'long_service').map((e) => e.barbs)).toEqual([2, 2, 2]);
    expect(sum(mine)).toBe(180 + 75 + 6);
    // On duty on the hour: no ready-for-duty barb, nothing negative, no award.
    const theirs = await entries(onTheHour.id);
    expect(theirs.some((e) => e.rule === 'ready_for_duty')).toBe(false);
    expect(theirs.filter((e) => e.rule === 'duties_complete')).toHaveLength(60);
    expect(theirs.every((e) => e.barbs > 0)).toBe(true);
    expect(theirs.some((e) => e.rule === 'standard' || e.rule === 'improvement')).toBe(false);
    // Running again writes nothing more.
    await w.http().post('/api/wire/run').set(auth(admin));
    expect(await entries(ready.id)).toHaveLength(mine.length);
    const months = await ownerQuery(`SELECT month, overall::float, award, streak FROM wire_months WHERE employee_id = $1 ORDER BY month`, [ready.id]);
    // Three months in a row at the standard: the system suggests a recognition award to the owner, once.
    expect(await ownerQuery(`SELECT kind, status, why, source_key FROM wire_awards WHERE employee_id = $1`, [ready.id])).toEqual([
      { kind: 'discretionary', status: 'pending', why: '3 months in a row at the standard', source_key: 'streak:2026-09' },
    ]);
    expect(months.map((m) => [m.month, m.overall, m.award, m.streak])).toEqual([
      ['2026-07', 100, 'standard', 1],
      ['2026-08', 100, 'standard', 2],
      ['2026-09', 100, 'standard', 3],
    ]);
  });

  it('an open task or an unhandled report means no barb for that shift, and a later correction adds it', async () => {
    const day = '2026-10-02';
    await shifts(ready.id, '2026-10', 20, 2);
    const task = (
      await ownerQuery(
        `INSERT INTO tasks (company_id, site_id, title, assignee_type, assignee_employee_id, recurrence, start_date) VALUES ($1, $2, 'Generator check', 'employee', $3, 'once', $4) RETURNING id`,
        [w.a.companyId, w.a.siteId, ready.id, day],
      )
    )[0].id;
    const occ = (
      await ownerQuery(
        `INSERT INTO task_occurrences (company_id, task_id, site_id, occurrence_date, title, instructions, photo_required, assignee_type, assignee_employee_id, state)
         VALUES ($1, $2, $3, $4, 'Generator check', '', false, 'employee', $5, 'missed') RETURNING id`,
        [w.a.companyId, task, w.a.siteId, day, ready.id],
      )
    )[0].id;
    await w.http().post('/api/wire/run').set(auth(admin));
    const oct = async () => (await entries(ready.id)).filter((e) => e.month === '2026-10');
    expect((await oct()).filter((e) => e.rule === 'duties_complete')).toHaveLength(1);
    // The supervisor accepts that it could not be done: the barb is now due, and is added.
    await ownerQuery(`UPDATE task_occurrences SET state = 'could_not_complete', cannot_reason = 'equipment_unavailable' WHERE id = $1`, [occ]);
    await w.http().post('/api/wire/run').set(auth(admin));
    expect((await oct()).filter((e) => e.rule === 'duties_complete')).toHaveLength(2);
  });

  it('a barb, once earned, can never be changed or removed', async () => {
    await expect(ownerQuery(`UPDATE wire_entries SET barbs = 99`)).rejects.toThrow();
    await expect(ownerQuery(`DELETE FROM wire_entries`)).rejects.toThrow();
  });

  it('the overview shows each guard’s Wire, pace and forecast, and Bob Wire’s fastest silver and gold', async () => {
    const o = (await w.http().get('/api/wire').set(auth(manager))).body;
    const sipho = o.guards.find((g: { name: string }) => g.name === 'Sipho Ready');
    expect(sipho).toMatchObject({ insignia: 'black', launchCredit: 0, streak: 3 });
    expect(sipho.wireTotal).toBe(sipho.available);
    expect(sipho.pace).toBe(Math.round((82 + 87 + 92) / 3));
    expect(sipho.monthsToSilver).toBeGreaterThan(0);
    expect(o.bob.monthsToGold).toBeGreaterThan(36);
    expect(o.months.map((m: { month: string }) => m.month)).toEqual(['2026-07', '2026-08', '2026-09', '2026-10']);
    expect(o.settings.silver).toBe(1000);
  });

  it('joining date gives launch credit on the Wire only; a recruitment score pays entry barbs once', async () => {
    const r = await w.http().put(`/api/wire/guards/${onTheHour.id}/profile`).set(auth(admin)).send({ joinedOn: '2023-03-01', recruitmentScore: 85, showName: false });
    expect(r.status).toBe(200);
    expect(r.body.launchCredit).toBe(150);
    const entry = (await entries(onTheHour.id)).filter((e) => e.rule === 'entry');
    expect(entry).toEqual([{ rule: 'entry', barbs: 30, source_key: 'once', month: expect.any(String) }]);
    // Launch credit is on the Wire but cannot be handed in.
    expect(r.body.wireTotal - r.body.available).toBe(150);
    // A changed score does not pay again.
    await w.http().put(`/api/wire/guards/${onTheHour.id}/profile`).set(auth(admin)).send({ joinedOn: '2023-03-01', recruitmentScore: 95 });
    expect((await entries(onTheHour.id)).filter((e) => e.rule === 'entry')).toHaveLength(1);
    // March anniversaries fall before the pilot, so none was paid.
    expect((await entries(onTheHour.id)).some((e) => e.rule === 'anniversary')).toBe(false);
  });

  it('settings are checked, audited and apply only from now on', async () => {
    const bad = await w.http().put('/api/wire/settings').set(auth(admin)).send({ silver: 6000 });
    expect(bad.status).toBe(400);
    const before = await entries(ready.id);
    const ok = await w.http().put('/api/wire/settings').set(auth(admin)).send({ silver: 1200, barbs: { readyForDuty: 2 } });
    expect(ok.status).toBe(200);
    expect(ok.body.barbs.readyForDuty).toBe(2);
    expect(ok.body.barbs.dutiesComplete).toBe(1);
    await w.http().post('/api/wire/run').set(auth(admin));
    expect(sum(await entries(ready.id))).toBe(sum(before));
    expect((await ownerQuery(`SELECT 1 FROM audit_log WHERE action = 'wire.settings_update'`)).length).toBe(2);
    await w.http().put('/api/wire/settings').set(auth(admin)).send({});
  });

  it('a what-if run replays the pilot under other values and writes nothing', async () => {
    const count = (await ownerQuery('SELECT count(*)::int AS n FROM wire_entries'))[0].n;
    const r = await w.http().post('/api/wire/simulate').set(auth(admin)).send({ from: '2026-07', to: '2026-09', settings: { barbs: { readyForDuty: 2, standardCap: 25 } } });
    expect(r.status).toBe(200);
    const sipho = r.body.guards.find((g: { name: string }) => g.name === 'Sipho Ready');
    expect(sipho.current.months.map((m: { barbs: number }) => m.barbs)).toEqual([82, 87, 92]);
    expect(sipho.proposed.months.map((m: { barbs: number }) => m.barbs)).toEqual([102, 107, 107]);
    expect((await ownerQuery('SELECT count(*)::int AS n FROM wire_entries'))[0].n).toBe(count);
  });

  it('the guard’s phone shows only what he earned and what is still open to him', async () => {
    const d = (await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Wire phone', serialOrImei: '356938035643111', siteId: w.a.siteId, postName: 'Main gate' })).body.deviceToken;
    const token = (await w.http().post('/api/device/login').set('X-Device-Token', d).send({ login: ready.number, pin: ready.pin })).body.token;
    const r = await w.http().get('/api/device/wire').set('X-Device-Token', d).set(auth(token));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ insignia: 'black', insigniaLabel: 'Black barb', streak: 3, next: { name: 'Silver barb' } });
    expect(r.body.barbsDrawn).toBe(Math.floor(r.body.wireTotal / 100));
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/R\d|rand|late|missed|lost|score/i);
    expect(r.body.recent.every((e: { barbs: number }) => e.barbs > 0)).toBe(true);
  });

  it('another company sees none of it', async () => {
    const bAdmin = await w.login('admin@b.test');
    const o = (await w.http().get('/api/wire').set(auth(bAdmin))).body;
    expect(o.guards).toHaveLength(0);
    expect((await w.http().get(`/api/wire/guards/${ready.id}`).set(auth(bAdmin))).status).toBe(404);
    expect((await w.http().put(`/api/wire/guards/${ready.id}/profile`).set(auth(bAdmin)).send({ joinedOn: '2020-01-01' })).status).toBe(404);
    void randomUUID;
  });
});
