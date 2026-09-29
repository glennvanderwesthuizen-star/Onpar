import { randomUUID } from 'node:crypto';
import { addDays, patternSymbolOn, parsePattern, sastDate, validateSaId, weekStart } from '@onpar/rules';
import { enrol, enrolmentData, ownerQuery, setupWorld, World } from './helpers';

/** A valid SA ID number for a sequence number, so each officer is unique. */
function idNumber(n: number): string {
  const base = `850101${String(5000 + n).padStart(4, '0')}08`;
  for (let d = 0; d <= 9; d++) if (validateSaId(base + d).valid) return base + d;
  throw new Error('no check digit');
}

/**
 * Milestone 21: shift patterns and rostering. Acceptance scenarios 22 to 25 and
 * 29 to 31, plus the owner's decisions D-19, D-20 and D-25.
 */
describe('rostering', () => {
  let w: World;
  let admin: string;
  let manager: string;
  let supervisor: string;
  let siteA: string;
  let siteB: string;
  let armedSite: string;
  let patternId: string;
  let deviceToken: string;
  const g: { id: string; number: string; pin: string }[] = [];
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const today = sastDate(new Date());
  const monday = weekStart(today);
  const DNO = parsePattern('DDDNNNOOO');
  const week = async (site: string, from = monday, token = manager) =>
    (await w.http().get(`/api/roster/sites/${site}/week?from=${from}`).set(auth(token))).body;
  const cell = (wk: { rows: { id: string; cells: { date: string }[] }[] }, emp: string, date: string) =>
    wk.rows.find((r) => r.id === emp)?.cells.find((c) => c.date === date) as Record<string, unknown> | undefined;
  const allocate = (employeeId: string, siteId: string, startDate: string, position: number, token = manager) =>
    w.http().post('/api/roster/allocations').set(auth(token)).send({ employeeId, siteId, patternId, startDate, position });
  const change = (body: Record<string, unknown>, token = manager) => w.http().post('/api/roster/changes').set(auth(token)).send(body);
  const shiftsOf = async (site: string) => (await w.http().get(`/api/sites/${site}`).set(auth(manager))).body.shifts;

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    manager = await w.login('manager@a.test');
    supervisor = await w.login('supervisor@a.test');
    siteA = w.a.siteId;
    siteB = (
      await w.http().post('/api/sites').set(auth(manager)).send({
        name: 'Office Park',
        address: 'Rosebank',
        client: 'Office Park Body Corporate',
        minimumGrade: 'E',
        armed: false,
        shifts: [
          { name: 'Morning', kind: 'day', startTime: '07:00', endTime: '15:00', guardsRequired: 1 },
          { name: 'Graveyard', kind: 'night', startTime: '19:00', endTime: '07:00', guardsRequired: 1 },
        ],
      })
    ).body.id;
    armedSite = (
      await w.http().post('/api/sites').set(auth(manager)).send({
        name: 'Bank Vault',
        address: 'Midrand',
        client: 'Bank',
        minimumGrade: 'B',
        armed: true,
        shifts: [{ name: 'Day', kind: 'day', startTime: '06:00', endTime: '18:00', guardsRequired: 1 }],
      })
    ).body.id;
    for (let i = 0; i < 8; i++) {
      const o = await enrol(w, admin, enrolmentData(siteA, { idNumber: idNumber(i), fullName: `Guard ${i}` }));
      if (o.status !== 201) throw new Error(JSON.stringify(o.body));
      g.push({ id: o.body.officer.id, number: o.body.officer.employeeNumber, pin: o.body.initialPin });
    }
    deviceToken = (
      await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Device 001', serialOrImei: '356938035643809', siteId: siteA })
    ).body.deviceToken;
  });
  afterAll(() => w.app.close());

  describe('patterns (scenario 23)', () => {
    it('rejects a night straight into a day, including across the wrap', async () => {
      const bad = await w.http().post('/api/roster/patterns').set(auth(manager)).send({ name: 'Bad', sequence: 'DNDO' });
      expect(bad.status).toBe(400);
      expect(bad.body.errors.sequence).toMatch(/night shift followed straight by a day shift/);
      const wrap = await w.http().post('/api/roster/patterns').set(auth(manager)).send({ name: 'Wrap', sequence: 'DDNN' });
      expect(wrap.body.errors.sequence).toMatch(/starts again with a day shift/);
    });
    it('accepts a day into a night, numbers it 01 and describes it', async () => {
      const r = await w.http().post('/api/roster/patterns').set(auth(manager)).send({ name: '3 day / 3 night / 3 off', sequence: 'DDD NNN OOO' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ code: '01', sequence: DNO, description: '3 day / 3 night / 3 off', inUse: 0 });
      patternId = r.body.id;
    });
    it('only managers create patterns; a supervisor may view them', async () => {
      expect((await w.http().post('/api/roster/patterns').set(auth(supervisor)).send({ name: 'x', sequence: 'DO' })).status).toBe(403);
      expect((await w.http().get('/api/roster/patterns').set(auth(supervisor))).body).toHaveLength(1);
    });
    it('keeps each company separate', async () => {
      const b = await w.login('manager@b.test');
      expect((await w.http().get('/api/roster/patterns').set(auth(b))).body).toEqual([]);
      const r = await w.http().post('/api/roster/allocations').set(auth(b)).send({ employeeId: g[0].id, siteId: w.b.siteId, patternId, startDate: today, position: 1 });
      expect(r.status).toBe(404);
    });
  });

  describe('allocation and the computed table (scenarios 22, 24)', () => {
    beforeAll(async () => {
      for (const [i, pos] of [[0, 1], [1, 1], [2, 4], [3, 4]] as const) {
        const r = await allocate(g[i].id, siteA, monday, pos);
        if (r.status !== 201) throw new Error(JSON.stringify(r.body));
      }
    });

    it('positions 1 and 4 are on different shift types on the same date', async () => {
      const wk = await week(siteA);
      expect(cell(wk, g[0].id, monday)).toMatchObject({ status: 'working', kind: 'day', shiftName: 'Day', source: 'pattern' });
      expect(cell(wk, g[2].id, monday)).toMatchObject({ status: 'working', kind: 'night', shiftName: 'Night' });
    });

    it('moving the week forward advances everyone with no re-entry', async () => {
      const next = addDays(monday, 7);
      const wk = await week(siteA, next);
      expect(wk.from).toBe(next);
      for (const [i, pos] of [[0, 1], [2, 4]] as const) {
        for (const c of wk.rows.find((r: { id: string }) => r.id === g[i].id).cells) {
          const sym = patternSymbolOn(DNO, monday, pos, c.date);
          expect(c.status).toBe(sym === 'O' ? 'off' : 'working');
          if (sym !== 'O') expect(c.kind).toBe(sym === 'D' ? 'day' : 'night');
        }
      }
    });

    it('shows required, actual and pass/short/over per shift', async () => {
      const wk = await week(siteA);
      const day = wk.shifts.find((s: { name: string }) => s.name === 'Day');
      expect(day.days[0]).toMatchObject({ date: monday, required: 2, actual: 2, status: 'pass' });
      // Day 4 of the pattern: positions 1 are on nights, positions 4 are off.
      expect(day.days[3]).toMatchObject({ required: 2, actual: 0, status: 'short' });
    });

    it('a site edit shows at once in the requirement row, with per-day figures (scenario 22, D-20)', async () => {
      const site = (await w.http().get(`/api/sites/${siteA}`).set(auth(manager))).body;
      site.shifts[0].guardsByDay = [3, 3, 3, 3, 3, 2, 2, 1];
      site.shifts[1].guardsRequired = 1;
      const r = await w.http().put(`/api/sites/${siteA}`).set(auth(manager)).send(site);
      expect(r.status).toBe(200);
      const wk = await week(siteA);
      expect(wk.shifts[0].days[0]).toMatchObject({ required: 3, actual: 2, status: 'short' });
      expect(wk.shifts[0].days[6].required).toBe(2);
      expect(wk.shifts[1].days[0]).toMatchObject({ required: 1, actual: 2, status: 'over' });
    });

    it('a single date can need a different number of guards', async () => {
      const [day] = await shiftsOf(siteA);
      expect((await w.http().put('/api/roster/requirements').set(auth(manager)).send({ shiftId: day.id, date: monday, guards: 2, note: 'Quiet day' })).status).toBe(200);
      expect((await week(siteA)).shifts[0].days[0]).toMatchObject({ required: 2, status: 'pass', changed: true, note: 'Quiet day' });
      await w.http().put('/api/roster/requirements').set(auth(manager)).send({ shiftId: day.id, date: monday, guards: null });
      expect((await week(siteA)).shifts[0].days[0].required).toBe(3);
    });

    it('rejects a position outside the pattern', async () => {
      expect((await allocate(g[4].id, siteA, monday, 10)).status).toBe(409);
    });
  });

  describe('day changes (scenario 25, D-25)', () => {
    it('changing one day changes only that cell', async () => {
      const before = await week(siteA);
      const d = addDays(monday, 1);
      const r = await change({ employeeId: g[0].id, date: d, shiftId: null, note: 'Family event' });
      expect(r.status).toBe(201);
      const after = await week(siteA);
      const rowBefore = before.rows.find((x: { id: string }) => x.id === g[0].id);
      const rowAfter = after.rows.find((x: { id: string }) => x.id === g[0].id);
      rowAfter.cells.forEach((c: { date: string }, i: number) => {
        if (c.date === d) expect(c).toMatchObject({ status: 'off', source: 'change' });
        else expect(c).toEqual(rowBefore.cells[i]);
      });
      // Everyone else is untouched.
      expect(after.rows.filter((x: { id: string }) => x.id !== g[0].id)).toEqual(before.rows.filter((x: { id: string }) => x.id !== g[0].id));
    });

    it('moves a guard to a second site for a day; both sites show it (D-19)', async () => {
      // Position 1: day 7 of the pattern (Sunday) is off, after the nights end on day 6, so use day 8 (next Monday) = off.
      const d = addDays(monday, 7);
      const [morning] = await shiftsOf(siteB);
      const r = await change({ employeeId: g[1].id, date: d, shiftId: morning.id });
      expect(r.status).toBe(201);
      expect(cell(await week(siteB, d), g[1].id, d)).toMatchObject({ status: 'working', shiftName: 'Morning', elsewhere: false, source: 'change' });
      expect(cell(await week(siteA, d), g[1].id, d)).toMatchObject({ status: 'working', siteName: 'Office Park', elsewhere: true });
      expect((await week(siteB, d)).shifts[0].days[0]).toMatchObject({ actual: 1, status: 'pass' });
    });

    it('always blocks a day shift straight after a night shift', async () => {
      // Position 4 works nights on days 1 to 3; putting a day shift on day 2 breaks the rule.
      const [day] = await shiftsOf(siteA);
      const r = await change({ employeeId: g[2].id, date: addDays(monday, 1), shiftId: day.id });
      expect(r.status).toBe(409);
      expect(r.body.message).toMatch(/A night shift may never be followed straight by a day shift/);
      // Nothing was saved.
      expect((await ownerQuery('SELECT count(*)::int AS n FROM roster_changes WHERE employee_id = $1', [g[2].id]))[0].n).toBe(0);
    });

    it('a weekly change repeats, and is refused if any week would break the rest rule', async () => {
      const [morning] = await shiftsOf(siteB);
      // On a 9-day pattern a weekly day shift sooner or later lands after a night.
      const bad = await change({ employeeId: g[0].id, weekday: 5, fromDate: monday, shiftId: morning.id });
      expect(bad.status).toBe(409);
      // A relief guard with no pattern can be given a regular Saturday at the second site.
      const ok = await change({ employeeId: g[5].id, weekday: 5, fromDate: monday, shiftId: morning.id, note: 'Every Saturday at Office Park' });
      expect(ok.status).toBe(201);
      for (const off of [0, 7, 14]) {
        const sat = addDays(monday, 5 + off);
        expect(cell(await week(siteB, sat), g[5].id, sat)).toMatchObject({ status: 'working', source: 'weekly' });
      }
      expect((await change({ employeeId: g[5].id, weekday: 5, fromDate: addDays(monday, 14), shiftId: morning.id })).status).toBe(409);
    });

    it('a change can be removed, and the pattern shows again', async () => {
      const [c] = await ownerQuery('SELECT id FROM roster_changes WHERE employee_id = $1 AND date IS NOT NULL', [g[0].id]);
      expect((await w.http().delete(`/api/roster/changes/${c.id}`).set(auth(manager))).status).toBe(200);
      expect(cell(await week(siteA), g[0].id, addDays(monday, 1))).toMatchObject({ status: 'working', source: 'pattern' });
      const [a] = await ownerQuery(`SELECT before->>'note' AS note FROM audit_log WHERE action = 'roster.change_removed'`);
      expect(a.note).toBe('Family event');
    });

    it('a supervisor can only move people into their own sites', async () => {
      const [morning] = await shiftsOf(siteB);
      const [day] = await shiftsOf(siteA);
      expect((await change({ employeeId: g[6].id, date: addDays(monday, 20), shiftId: morning.id }, supervisor)).status).toBe(404);
      expect((await change({ employeeId: g[6].id, date: addDays(monday, 20), shiftId: day.id }, supervisor)).status).toBe(201);
      expect((await allocate(g[6].id, siteB, monday, 1, supervisor)).status).toBe(404);
      expect((await w.http().get(`/api/roster/sites/${siteB}/week`).set(auth(supervisor))).status).toBe(404);
    });
  });

  describe('one allocation per person (scenarios 29, 30)', () => {
    it('warns before moving a guard, then leaves exactly one allocation at the new site', async () => {
      const check = await w.http().get(`/api/roster/allocation-check?employeeId=${g[3].id}&siteId=${siteB}`).set(auth(manager));
      expect(check.body.warnings[0]).toBe('Currently rostered at Estate ABC. Allocating here will move them off that roster.');
      const next = addDays(monday, 7);
      expect((await allocate(g[3].id, siteB, next, 1)).status).toBe(201);
      const active = await ownerQuery('SELECT site_id FROM roster_allocations WHERE employee_id = $1 AND end_date IS NULL', [g[3].id]);
      expect(active).toEqual([{ site_id: siteB }]);
      // History is kept: this week still computes at Estate ABC, next week at Office Park.
      expect(cell(await week(siteA), g[3].id, monday)).toMatchObject({ status: 'working', siteName: 'Estate ABC' });
      expect(cell(await week(siteB, next), g[3].id, next)).toMatchObject({ status: 'working', shiftName: 'Morning' });
      const [a] = await ownerQuery(`SELECT before FROM audit_log WHERE action = 'roster.allocate' ORDER BY id DESC LIMIT 1`);
      expect(a.before.ended).toHaveLength(1);
    });

    it('a second allocation made behind the system’s back is caught and named', async () => {
      await ownerQuery(
        `INSERT INTO roster_allocations (company_id, employee_id, site_id, pattern_id, start_date, position) VALUES ($1, $2, $3, $4, $5, 1)`,
        [w.a.companyId, g[3].id, siteA, patternId, monday],
      );
      const r = await w.http().get('/api/roster/clashes').set(auth(manager));
      expect(r.body).toHaveLength(1);
      expect(r.body[0].message).toBe('Guard 3 is allocated to more than one site at once: Estate ABC and Office Park. Allocate them again to keep only one.');
      expect((await week(siteA)).clashes).toHaveLength(1);
      // Allocating again through the normal path fixes it.
      await allocate(g[3].id, siteB, addDays(monday, 7), 1);
      expect((await w.http().get('/api/roster/clashes').set(auth(manager))).body).toEqual([]);
    });

    it('checks grade and firearm competency at allocation, without blocking', async () => {
      const r = await w.http().get(`/api/roster/allocation-check?employeeId=${g[4].id}&siteId=${armedSite}`).set(auth(manager));
      expect(r.body.warnings).toEqual([
        "PSIRA grade C is below Bank Vault's minimum of grade B.",
        'Bank Vault is an armed site and this officer has no firearm competency on file.',
      ]);
      const a = await w.http().post('/api/roster/allocations').set(auth(manager)).send({
        employeeId: g[4].id, siteId: armedSite, patternId, startDate: addDays(monday, 7), position: 1, reason: 'Competency certificate on its way',
      });
      expect(a.status).toBe(201);
      expect(a.body.warnings).toHaveLength(2);
      const [log] = await ownerQuery(`SELECT reason FROM audit_log WHERE action = 'roster.allocate' ORDER BY id DESC LIMIT 1`);
      expect(log.reason).toBe('Competency certificate on its way');
    });
  });

  describe('on the device (scenario 31)', () => {
    const login = async (i: number) =>
      (await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: g[i].number, pin: g[i].pin })).body.token;
    const me = async (i: number) => {
      const token = await login(i);
      return (await w.http().get('/api/device/me').set({ 'X-Device-Token': deviceToken, ...auth(token) })).body;
    };

    it('shows the real shift today, and the coming working days', async () => {
      const r = (await me(0)).roster;
      const sym = patternSymbolOn(DNO, monday, 1, today);
      expect(r.rostered).toBe(true);
      expect(r.today.status).toBe(sym === 'O' ? 'off' : 'working');
      if (sym !== 'O') expect(r.today).toMatchObject({ siteName: 'Estate ABC', shiftName: sym === 'D' ? 'Day' : 'Night' });
      expect(r.comingUp.every((d: { status: string }) => d.status === 'working')).toBe(true);
      expect(r.comingUp.length).toBeGreaterThan(0);
    });

    it('says Not yet rostered for someone with no roster, and Off today when off', async () => {
      expect((await me(7)).roster).toMatchObject({ rostered: false, today: { status: 'not_rostered' }, comingUp: [] });
      await change({ employeeId: g[1].id, date: today, shiftId: null });
      expect((await me(1)).roster.today).toMatchObject({ status: 'off', siteName: 'Estate ABC' });
    });

    it('My roster lists the working days of the next four weeks', async () => {
      const token = await login(0);
      const r = (await w.http().get('/api/device/roster').set({ 'X-Device-Token': deviceToken, ...auth(token) })).body;
      const expected = Array.from({ length: 27 }, (_, i) => addDays(today, i + 1)).filter((d) => patternSymbolOn(DNO, monday, 1, d) !== 'O');
      expect(r.comingUp.map((d: { date: string }) => d.date)).toEqual(expected);
    });
  });

  describe('Duty On against the roster', () => {
    const D1 = sastDate(new Date(Date.now() - 24 * 3600 * 1000));
    const at = (hhmm: string) => `${D1}T${hhmm}:00+02:00`;
    const dutyOn = async (i: number, hhmm: string) => {
      const token = (await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: g[i].number, pin: g[i].pin })).body.token;
      return w.http().post('/api/device/duty').set({ 'X-Device-Token': deviceToken, ...auth(token) }).send({ eventId: randomUUID(), kind: 'duty_on', pin: g[i].pin, trustedAt: at(hhmm), deviceClock: at(hhmm) });
    };

    it('measures lateness against the rostered shift', async () => {
      // Guard 6 has only a day change in the future; give him a pattern with yesterday as a day shift.
      await ownerQuery('DELETE FROM roster_changes WHERE employee_id = $1', [g[6].id]);
      expect((await allocate(g[6].id, siteA, D1, 1)).status).toBe(201);
      const r = await dutyOn(6, '06:40');
      expect(r.status).toBe(200);
      expect(r.body.attendance).toMatchObject({ shiftName: 'Day', arrivalStatus: 'LATE', lateMinutes: 40, rosterStatus: 'rostered' });
    });

    it('records but does not score a guard who is rostered elsewhere', async () => {
      // Guard 3 is now rostered at Office Park only.
      await allocate(g[3].id, siteB, D1, 1);
      const r = await dutyOn(3, '06:00');
      expect(r.status).toBe(200);
      expect(r.body.attendance).toMatchObject({ arrivalStatus: 'UNSCHEDULED', rosterStatus: 'not_rostered_here' });
      const events = await ownerQuery(`SELECT 1 FROM performance_events WHERE employee_id = $1 AND event_type IN ('late','on_time')`, [g[3].id]);
      expect(events).toHaveLength(0);
    });

    it('counts a rostered guard who never arrived as absent on the dashboard', async () => {
      const r = await w.http().get(`/api/dashboard?date=${D1}`).set(auth(manager));
      const office = r.body.sites.find((x: { siteName: string }) => x.siteName === 'Office Park').figures.attendance;
      // Guard 3 was rostered at Office Park yesterday but logged Duty On at Estate ABC; guard 5 works there on Saturdays.
      const saturday = new Date(`${D1}T12:00:00Z`).getUTCDay() === 6 && D1 >= monday ? 1 : 0;
      expect(office).toMatchObject({ scheduled: 1 + saturday, absent: 1 + saturday });
    });

    it('uses the site shifts for someone with no roster yet', async () => {
      const r = await dutyOn(7, '06:00');
      expect(r.body.attendance).toMatchObject({ shiftName: 'Day', arrivalStatus: 'ON_TIME', rosterStatus: 'no_roster' });
    });
  });
});
