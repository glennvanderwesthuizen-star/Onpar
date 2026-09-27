import { randomUUID } from 'node:crypto';
import { addDays, addWorkingDays, sastDate, sastInstant } from '@onpar/rules';
import { TasksService } from '../src/tasks/tasks.service';
import { enrol, enrolmentData, ownerQuery, setupWorld, World } from './helpers';

/** Milestone 4: the scoring engine (section 6.8, scenarios 1 and 15). */
describe('scoring', () => {
  let w: World;
  let admin: string;
  let supervisor: string;
  let manager: string;
  let deviceToken: string;
  let guardToken: string;
  let pin: string;
  let employeeId: string;
  const today = sastDate(new Date());
  const D1 = addDays(today, -1);
  const D2 = addDays(today, -2);
  const sast = (date: string, hhmm: string) => `${date}T${hhmm}:00+02:00`;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const guard = () => ({ 'X-Device-Token': deviceToken, Authorization: `Bearer ${guardToken}` });
  const duty = (kind: string, at: string) =>
    w.http().post('/api/device/duty').set(guard()).send({ eventId: randomUUID(), kind, pin, trustedAt: at, deviceClock: at });
  const myScore = async () => (await w.http().get('/api/device/score').set(guard())).body;
  const eventOf = async (type: string) =>
    (await ownerQuery('SELECT id, impact::float AS impact FROM performance_events WHERE event_type = $1 ORDER BY created_at', [type]));

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    supervisor = await w.login('supervisor@a.test');
    manager = await w.login('manager@a.test');
    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    pin = o.body.initialPin;
    employeeId = o.body.officer.id;
    const d = await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Device 001', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Gate 2' });
    deviceToken = d.body.deviceToken;
    guardToken = (await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: '0001', pin })).body.token;
  });
  afterAll(() => w.app.close());

  it('starts every officer at 80, On Par', async () => {
    expect(await myScore()).toMatchObject({ score: 80, position: 'ON_PAR', positionLabel: 'On Par', events: [] });
  });

  it('gives +1 for arriving on time, and says why (scenario 1)', async () => {
    expect((await duty('duty_on', sast(D2, '05:57'))).status).toBe(200);
    const s = await myScore();
    expect(s.score).toBe(81);
    expect(s.events[0]).toMatchObject({ type: 'on_time', label: 'On time', impact: 1, date: D2, canQuery: false });
    expect(s.events[0].evidence).toMatch(/^Duty On at 05:57 for the 06:00 Day shift at Estate ABC on /);
  });

  let lateId: string;
  it('takes 1 point for arriving at 06:17, shows the evidence and allows a query (scenario 1)', async () => {
    await duty('duty_from', sast(D2, '18:00'));
    await duty('duty_on', sast(D1, '06:17'));
    const s = await myScore();
    expect(s.score).toBe(80);
    const late = s.events.find((e: { type: string }) => e.type === 'late');
    lateId = late.id;
    expect(late).toMatchObject({ label: 'Late arrival', impact: -1, canQuery: true, queryUntil: addDays(D1, 7) });
    expect(late.evidence).toMatch(/17 minutes late/);
  });

  it('keeps events append-only (scenario 15)', async () => {
    await expect(ownerQuery('UPDATE performance_events SET impact = 0')).rejects.toThrow(/immutable/);
    await expect(ownerQuery('DELETE FROM performance_events')).rejects.toThrow(/immutable/);
  });

  describe('queries', () => {
    let queryId: string;
    it('lets the officer query a lost point, due in 3 working days', async () => {
      const r = await w.http().post(`/api/device/score/events/${lateId}/query`).set(guard()).send({ text: 'Taxi strike, I phoned the supervisor at 05:40' });
      expect(r.status).toBe(201);
      expect(r.body.answerDue).toBe(addWorkingDays(today, 3));
      queryId = r.body.id;
      expect((await w.http().post(`/api/device/score/events/${lateId}/query`).set(guard()).send({ text: 'again please' })).status).toBe(409);
      const onTime = (await myScore()).events.find((e: { type: string }) => e.type === 'on_time');
      expect((await w.http().post(`/api/device/score/events/${onTime.id}/query`).set(guard()).send({ text: 'why not more' })).status).toBe(400);
    });

    it('shows open queries to the supervisor', async () => {
      const r = await w.http().get('/api/scores/queries').set(auth(supervisor));
      expect(r.body).toEqual([expect.objectContaining({ id: queryId, employeeName: 'John Smith', label: 'Late arrival', status: 'open' })]);
    });

    it('lets a supervisor uphold it, but not reverse it', async () => {
      const reverse = await w.http().post(`/api/scores/queries/${queryId}/answer`).set(auth(supervisor)).send({ decision: 'reversed', answer: 'Fine, reversing' });
      expect(reverse.status).toBe(403);
      const uphold = await w.http().post(`/api/scores/queries/${queryId}/answer`).set(auth(supervisor)).send({ decision: 'upheld', answer: 'No call was logged before 06:00.' });
      expect(uphold.status).toBe(201);
      const s = await myScore();
      expect(s.events.find((e: { id: string }) => e.id === lateId)).toMatchObject({ queryStatus: 'upheld', queryAnswer: 'No call was logged before 06:00.', canQuery: false });
    });
  });

  describe('reversals', () => {
    it('are for managers only', async () => {
      expect((await w.http().post(`/api/scores/events/${lateId}/reverse`).set(auth(supervisor)).send({ reason: 'Taxi strike confirmed' })).status).toBe(403);
    });

    it('add an offsetting event instead of deleting (scenario 15)', async () => {
      const r = await w.http().post(`/api/scores/events/${lateId}/reverse`).set(auth(manager)).send({ reason: 'Taxi strike confirmed by the news' });
      expect(r.status).toBe(201);
      const s = await myScore();
      expect(s.score).toBe(81);
      const rev = s.events.find((e: { type: string }) => e.type === 'reversal');
      expect(rev).toMatchObject({ impact: 1, date: D1, reversesEventId: lateId, createdBy: 'Thandi Manager', reason: 'Taxi strike confirmed by the news' });
      expect(s.events.find((e: { id: string }) => e.id === lateId).reversedBy).toBe(rev.id);
      expect(await eventOf('late')).toHaveLength(1);
    });

    it('cannot be repeated or reversed themselves', async () => {
      expect((await w.http().post(`/api/scores/events/${lateId}/reverse`).set(auth(manager)).send({ reason: 'again again' })).status).toBe(409);
      const [rev] = await eventOf('reversal');
      expect((await w.http().post(`/api/scores/events/${rev.id}/reverse`).set(auth(manager)).send({ reason: 'undo it' })).status).toBe(409);
    });
  });

  describe('awards', () => {
    it('lets a supervisor award up to +2 and no more', async () => {
      const big = await w.http().post(`/api/scores/${employeeId}/award`).set(auth(supervisor)).send({ points: 3, reason: 'Caught an intruder' });
      expect(big.status).toBe(403);
      expect(big.body.message).toMatch(/Ask a manager/);
      expect((await w.http().post(`/api/scores/${employeeId}/award`).set(auth(supervisor)).send({ points: 2, reason: 'Caught an intruder' })).status).toBe(201);
    });

    it('lets a manager award more, and the daily cap of +5 holds (scenario 15)', async () => {
      expect((await w.http().post(`/api/scores/${employeeId}/award`).set(auth(manager)).send({ points: 6, reason: 'Too much' })).status).toBe(403);
      expect((await w.http().post(`/api/scores/${employeeId}/award`).set(auth(manager)).send({ points: 5, reason: 'Saved a resident during a fire' })).status).toBe(201);
      // D2: +1. D1: −1 +1 = 0. Today: +2 +5 = 7, capped at 5.
      const s = await myScore();
      expect(s).toMatchObject({ score: 86, counted: 6, cappedOff: 2, position: 'ON_PAR' });
    });

    it('never allows a negative award', async () => {
      expect((await w.http().post(`/api/scores/${employeeId}/award`).set(auth(manager)).send({ points: -1, reason: 'Rude to client' })).status).toBe(400);
    });
  });

  describe('rules', () => {
    it('are editable by a manager only, and validated', async () => {
      expect((await w.http().put('/api/scores/rules').set(auth(supervisor)).send({ points: { late: -2 } })).status).toBe(403);
      expect((await w.http().put('/api/scores/rules').set(auth(manager)).send({ points: { on_time: -1 } })).status).toBe(400);
    });

    it('change future scores only (scenario 15)', async () => {
      const r = await w.http().put('/api/scores/rules').set(auth(manager)).send({ points: { late: -2 } });
      expect(r.status).toBe(200);
      await duty('duty_from', sast(D1, '18:00'));
      await duty('duty_on', sast(D1, '18:30')); // 30 minutes late for the night shift
      expect((await eventOf('late')).map((e) => e.impact)).toEqual([-1, -2]);
      const [a] = await ownerQuery(`SELECT reason FROM audit_log WHERE action = 'score.rules'`);
      expect(a).toBeDefined();
    });
  });

  describe('from attendance exceptions', () => {
    it('reverse the late point when a manager approves, but not when a supervisor does', async () => {
      const [attendance] = await ownerQuery(`SELECT id FROM attendance WHERE arrival_status = 'LATE' ORDER BY duty_on_at DESC LIMIT 1`);
      const sup = await w.http().post(`/api/attendance/${attendance.id}/exception`).set(auth(supervisor)).send({ reason: 'Car broke down' });
      expect(sup.body.pointsReversed).toBe(false);
      const mgr = await w.http().post(`/api/attendance/${attendance.id}/exception`).set(auth(manager)).send({ reason: 'Car broke down, tow slip seen' });
      expect(mgr.body.pointsReversed).toBe(true);
      expect((await eventOf('reversal')).map((e) => e.impact)).toEqual([1, 2]);
    });
  });

  describe('from tasks', () => {
    const task = async (title: string, assignee: Record<string, unknown>) => {
      const t = await w.http().post('/api/tasks').set(auth(supervisor)).send({ title, siteId: w.a.siteId, recurrence: 'once', startDate: today, ...assignee });
      if (t.status !== 201) throw new Error(JSON.stringify(t.body));
      return (await ownerQuery('SELECT id FROM task_occurrences WHERE task_id = $1', [t.body.id]))[0].id;
    };
    const mine = () => ({ assigneeType: 'employee', assigneeEmployeeId: employeeId });

    it('gives +1 for a completed task', async () => {
      const occ = await task('Check the gate motor', mine());
      const now = new Date().toISOString();
      const r = await w.http().post(`/api/device/tasks/${occ}/complete`).set(guard()).send({ eventId: randomUUID(), trustedAt: now, deviceClock: now });
      expect(r.status).toBe(200);
      const [ev] = await ownerQuery(`SELECT impact::float AS impact, evidence FROM performance_events WHERE event_type = 'task_completed'`);
      expect(ev).toEqual({ impact: 1, evidence: expect.stringMatching(/^Completed “Check the gate motor”/) });
    });

    it('takes a point only when a supervisor does not accept "could not complete"', async () => {
      const occ = await task('Test the alarm', mine());
      const now = new Date().toISOString();
      await w.http().post(`/api/device/tasks/${occ}/cannot-complete`).set(guard()).send({ eventId: randomUUID(), reason: 'emergency', comment: 'Break-in at unit 4', trustedAt: now, deviceClock: now });
      expect(await eventOf('missed_task')).toEqual([]);
      await w.http().post(`/api/tasks/occurrences/${occ}/review`).set(auth(supervisor)).send({ decision: 'not_accepted', note: 'The break-in was at 02:00, the task was for the day shift' });
      const [ev] = await ownerQuery(`SELECT impact::float AS impact, evidence FROM performance_events WHERE event_type = 'missed_task'`);
      expect(ev.impact).toBe(-1);
      expect(ev.evidence).toMatch(/did not accept the reason/);
    });

    it('takes a point for a missed task for a person, and for a post from every guard on duty there that day (decision D-21)', async () => {
      await task('Personal radio check', mine());
      const deviceId = (await ownerQuery('SELECT id FROM devices LIMIT 1'))[0].id;
      await task('Post radio check', { assigneeType: 'post', assigneeDeviceId: deviceId });
      await w.app.get(TasksService).runSchedule(sastInstant(addDays(today, 1), '00:05'));
      const missed = await ownerQuery(`SELECT evidence FROM performance_events WHERE event_type = 'missed_task' ORDER BY created_at`);
      expect(missed).toHaveLength(3);
      expect(missed.map((m) => m.evidence)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/did not accept/),
          expect.stringMatching(/^“Personal radio check” was not done/),
          expect.stringMatching(/^“Post radio check” for your post was not done .* you were on duty there that day/),
        ]),
      );
    });
  });

  describe('management view', () => {
    it("lists officers with score and position for the supervisor's sites", async () => {
      const r = await w.http().get('/api/scores').set(auth(supervisor));
      expect(r.body).toEqual([expect.objectContaining({ name: 'John Smith', position: 'ON_PAR', openQueries: 0 })]);
    });

    it('keeps scores inside the company (scenario 14)', async () => {
      const b = await w.login('manager@b.test');
      expect((await w.http().get('/api/scores').set(auth(b))).body).toEqual([]);
      expect((await w.http().get(`/api/scores/${employeeId}`).set(auth(b))).status).toBe(404);
    });
  });
});
