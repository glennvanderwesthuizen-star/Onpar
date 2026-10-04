import { randomUUID } from 'node:crypto';
import { addDays, sastDate, sastInstant } from '@onpar/rules';
import { TasksService } from '../src/tasks/tasks.service';
import { enrol, enrolmentData, ownerQuery, PNG, setupWorld, World } from './helpers';

/** Milestone 3: tasks and recurrence (sections 6.4 and 25, scenarios 1 and 9). */
describe('tasks', () => {
  let w: World;
  let admin: string;
  let supervisor: string;
  let deviceToken: string;
  let deviceId: string;
  let otherDeviceId: string;
  let guardToken: string;
  let pin: string;
  let employeeId: string;
  const today = sastDate(new Date());

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const guard = () => ({ 'X-Device-Token': deviceToken, Authorization: `Bearer ${guardToken}` });
  const now = () => new Date().toISOString();
  const createTask = (t: Record<string, unknown>) =>
    w
      .http()
      .post('/api/tasks')
      .set(auth(supervisor))
      .send({ siteId: w.a.siteId, recurrence: 'daily', startDate: today, assigneeType: 'post', assigneeDeviceId: deviceId, ...t });
  const occurrenceFor = async (taskId: string, date = today) =>
    (await ownerQuery('SELECT id, state FROM task_occurrences WHERE task_id = $1 AND occurrence_date = $2', [taskId, date]))[0];
  const complete = (id: string, data: Record<string, unknown> = {}, photo = true) => {
    let r = w
      .http()
      .post(`/api/device/tasks/${id}/complete`)
      .set(guard())
      .field('data', JSON.stringify({ eventId: randomUUID(), trustedAt: now(), deviceClock: now(), ...data }));
    if (photo) r = r.attach('photo', PNG, { filename: 'p.png', contentType: 'image/png' });
    return r;
  };

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    supervisor = await w.login('supervisor@a.test');
    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    pin = o.body.initialPin;
    employeeId = o.body.officer.id;
    const d = await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Device 001', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Gate 2' });
    deviceToken = d.body.deviceToken;
    deviceId = d.body.device.id;
    const d2 = await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Device 002', serialOrImei: '356938035643810', siteId: w.a.siteId, postName: 'Gate 3' });
    otherDeviceId = d2.body.device.id;
    guardToken = (await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: '0001', pin })).body.token;
  });
  afterAll(() => w.app.close());

  describe('setting up tasks', () => {
    it('refuses a first date in the past', async () => {
      const r = await createTask({ title: 'x', startDate: addDays(today, -1) });
      expect(r.status).toBe(400);
      expect(r.body.errors.startDate).toBeDefined();
    });

    it('needs a time only when "specific time required" is ticked (section 25)', async () => {
      const r = await createTask({ title: 'Lock the gate', timeRequired: true });
      expect(r.status).toBe(400);
      expect(r.body.errors.dueTime).toBeDefined();
    });

    it('refuses a post at another site', async () => {
      const site = await w.http().post('/api/sites').set(auth(admin)).send({ name: 'Other', address: 'x', client: 'x', province: 'GP', minimumGrade: 'E', armed: false, shifts: [{ name: 'Day', kind: 'day', startTime: '06:00', endTime: '18:00', guardsRequired: 1 }] });
      const manager = await w.login('manager@a.test');
      const r = await w.http().post('/api/tasks').set(auth(manager)).send({ title: 'x', siteId: site.body.id, recurrence: 'once', startDate: today, assigneeType: 'post', assigneeDeviceId: deviceId });
      expect(r.status).toBe(400);
      expect(r.body.errors.assigneeDeviceId).toMatch(/different site/);
    });

    it('generates a daily task a week ahead, untimed by default', async () => {
      const r = await createTask({ title: 'Generator check', instructions: 'Photo of the fuel gauge', photoRequired: true });
      expect(r.status).toBe(201);
      const rows = await ownerQuery('SELECT occurrence_date, due_time FROM task_occurrences WHERE task_id = $1 ORDER BY 1', [r.body.id]);
      expect(rows.map((x) => x.occurrence_date)).toEqual(Array.from({ length: 8 }, (_, i) => addDays(today, i)));
      expect(rows.every((x) => x.due_time === null)).toBe(true);
    });
  });

  describe('on the guard device', () => {
    let generatorTask: string;
    let generator: string;

    beforeAll(async () => {
      generatorTask = (await w.http().get('/api/tasks').set(auth(supervisor))).body.find((t: { title: string }) => t.title === 'Generator check').id;
      generator = (await occurrenceFor(generatorTask)).id;
    });

    it("lists today's tasks for this post, shown as any time during the shift", async () => {
      const r = await w.http().get('/api/device/tasks').set(guard());
      expect(r.status).toBe(200);
      expect(r.body).toEqual([expect.objectContaining({ id: generator, title: 'Generator check', anyTime: true, photoRequired: true, state: 'open' })]);
    });

    it("does not show tasks for another post", async () => {
      await createTask({ title: 'Gate 3 check', assigneeDeviceId: otherDeviceId });
      const r = await w.http().get('/api/device/tasks').set(guard());
      expect(r.body.map((t: { title: string }) => t.title)).toEqual(['Generator check']);
    });

    it('needs Duty On first', async () => {
      const r = await complete(generator);
      expect(r.status).toBe(409);
      expect(r.body.message).toBe('Log Duty On before doing tasks.');
      const on = await w.http().post('/api/device/duty').set(guard()).send({ eventId: randomUUID(), kind: 'duty_on', pin, trustedAt: now(), deviceClock: now() });
      expect(on.status).toBe(200);
    });

    it('needs the photo when the task requires one', async () => {
      const r = await complete(generator, {}, false);
      expect(r.status).toBe(400);
      expect(r.body.message).toBe('This task needs a photo.');
    });

    const eventId = randomUUID();
    it('completes the generator check with a photo (scenario 1)', async () => {
      const r = await complete(generator, { eventId, comment: 'Fuel at 70 litres' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ state: 'completed', photoReceived: true });
      const h = await ownerQuery('SELECT action, actor_label, note FROM task_history WHERE occurrence_id = $1', [generator]);
      expect(h).toEqual([{ action: 'completed', actor_label: 'John Smith', note: 'Fuel at 70 litres' }]);
    });

    it('treats a retry as the same completion, and refuses a second one', async () => {
      expect((await complete(generator, { eventId, comment: 'Fuel at 70 litres' })).status).toBe(200);
      expect((await ownerQuery('SELECT count(*)::int AS n FROM task_history WHERE occurrence_id = $1', [generator]))[0].n).toBe(1);
      expect((await complete(generator)).status).toBe(409);
    });

    it('takes the photo later when sent offline', async () => {
      const t = await createTask({ title: 'Photograph the perimeter fence', photoRequired: true, assigneeType: 'employee', assigneeEmployeeId: employeeId, assigneeDeviceId: null });
      const occ = (await occurrenceFor(t.body.id)).id;
      const r = await complete(occ, { photoToFollow: true }, false);
      expect(r.body).toMatchObject({ state: 'completed', photoReceived: false, photoPending: true });
      const p = await w.http().post(`/api/device/tasks/${occ}/photo`).set(guard()).attach('photo', PNG, { filename: 'p.png', contentType: 'image/png' });
      expect(p.body).toMatchObject({ photoReceived: true, photoPending: false });
    });

    let fireCheck: string;
    it('records "could not complete" with a reason, awaiting review with no penalty (section 6.4)', async () => {
      const t = await createTask({ title: 'Check fire extinguishers', assigneeType: 'employee', assigneeEmployeeId: employeeId, assigneeDeviceId: null });
      fireCheck = (await occurrenceFor(t.body.id)).id;
      const send = (data: Record<string, unknown>) =>
        w.http().post(`/api/device/tasks/${fireCheck}/cannot-complete`).set(guard()).send({ eventId: randomUUID(), trustedAt: now(), deviceClock: now(), ...data });
      expect((await send({ reason: 'other' })).status).toBe(400);
      const r = await send({ reason: 'access_unavailable', comment: 'Plant room locked, no key' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ state: 'could_not_complete', cannotReason: 'access_unavailable' });
      const board = await w.http().get('/api/tasks/board').set(auth(supervisor));
      expect(board.body.counts).toMatchObject({ couldNotComplete: 1, awaitingReview: 1 });
    });

    it('lets a supervisor review it once, with a note', async () => {
      const review = (body: Record<string, unknown>) => w.http().post(`/api/tasks/occurrences/${fireCheck}/review`).set(auth(supervisor)).send(body);
      expect((await review({ decision: 'accepted' })).status).toBe(400);
      expect((await review({ decision: 'accepted', note: 'Key is with the estate manager, confirmed' })).status).toBe(201);
      expect((await review({ decision: 'not_accepted', note: 'Changed my mind' })).status).toBe(409);
      const d = await w.http().get(`/api/tasks/occurrences/${fireCheck}`).set(auth(supervisor));
      expect(d.body.review).toBe('accepted');
      expect(d.body.history.map((h: { action: string }) => h.action)).toEqual(['could_not_complete', 'review_accepted']);
    });

    it('shows a timed task past its time as overdue', async () => {
      await createTask({ title: 'Morning radio check', timeRequired: true, dueTime: '00:01' });
      const board = await w.http().get('/api/tasks/board').set(auth(supervisor));
      expect(board.body.rows.find((r: { title: string }) => r.title === 'Morning radio check').status).toBe('overdue');
    });
  });

  describe('changing and stopping', () => {
    it('applies an edit to open occurrences from today, not to completed ones', async () => {
      const t = await createTask({ title: 'Patrol log review' });
      const r = await w.http().put(`/api/tasks/${t.body.id}`).set(auth(supervisor)).send({ title: 'Review patrol log', assigneeType: 'post', assigneeDeviceId: deviceId });
      expect(r.status).toBe(200);
      const titles = await ownerQuery('SELECT DISTINCT title FROM task_occurrences WHERE task_id = $1', [t.body.id]);
      expect(titles).toEqual([{ title: 'Review patrol log' }]);
      const generatorTask = (await w.http().get('/api/tasks').set(auth(supervisor))).body.find((x: { title: string }) => x.title === 'Generator check').id;
      await w.http().put(`/api/tasks/${generatorTask}`).set(auth(supervisor)).send({ title: 'Generator check (new)', assigneeType: 'post', assigneeDeviceId: deviceId, photoRequired: true });
      const done = await ownerQuery(`SELECT title FROM task_occurrences WHERE task_id = $1 AND state = 'completed'`, [generatorTask]);
      expect(done).toEqual([{ title: 'Generator check' }]);
    });

    it('stops a task: later occurrences are cancelled, today stays', async () => {
      const t = await createTask({ title: 'Temporary check' });
      const r = await w.http().post(`/api/tasks/${t.body.id}/stop`).set(auth(supervisor));
      expect(r.body.cancelled).toBe(7);
      expect((await occurrenceFor(t.body.id)).state).toBe('open');
    });

    it("keeps one company's tasks from another (scenario 14)", async () => {
      const b = await w.login('manager@b.test');
      const board = await w.http().get('/api/tasks/board').set(auth(b));
      expect(board.body.rows).toEqual([]);
      expect((await w.http().get(`/api/tasks/occurrences/${(await ownerQuery('SELECT id FROM task_occurrences LIMIT 1'))[0].id}`).set(auth(b))).status).toBe(404);
    });
  });

  // These move the scheduler's clock forward, so they run last.
  describe('the scheduler', () => {
    it('keeps creating a monthly task on schedule after one is missed (scenario 9)', async () => {
      const start = addDays(today, 1);
      const t = await createTask({ title: 'Check all fire extinguishers', recurrence: 'monthly', startDate: start });
      const scheduler = w.app.get(TasksService);

      // The day after the first one: nobody did it.
      await scheduler.runSchedule(sastInstant(addDays(start, 1), '00:30'));
      expect((await occurrenceFor(t.body.id, start)).state).toBe('missed');
      const history = await ownerQuery(`SELECT action, actor_type FROM task_history h JOIN task_occurrences o ON o.id = h.occurrence_id WHERE o.task_id = $1`, [t.body.id]);
      expect(history).toEqual([{ action: 'missed', actor_type: 'system' }]);

      // A week before the next month's date, it exists and is open.
      const nextMonth = new Date(`${start}T12:00:00Z`);
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
      const next = sastDate(nextMonth).slice(0, 8);
      await scheduler.runSchedule(sastInstant(addDays(start, 28), '12:00'));
      const rows = await ownerQuery('SELECT occurrence_date, state FROM task_occurrences WHERE task_id = $1 ORDER BY 1', [t.body.id]);
      expect(rows[0]).toEqual({ occurrence_date: start, state: 'missed' });
      expect(rows[1].occurrence_date.startsWith(next)).toBe(true);
      expect(rows[1].state).toBe('open');
      expect(rows).toHaveLength(2);
    });

    it('still accepts a task done before midnight but synced after the sweep', async () => {
      const t = await createTask({ title: 'Lock the pump room', assigneeType: 'employee', assigneeEmployeeId: employeeId, assigneeDeviceId: null });
      const occ = (await occurrenceFor(t.body.id)).id;
      await w.app.get(TasksService).runSchedule(sastInstant(addDays(today, 1), '00:10'));
      expect((await occurrenceFor(t.body.id)).state).toBe('missed');
      const r = await complete(occ, {}, false);
      expect(r.status).toBe(200);
      expect(r.body.state).toBe('completed');
      const [h] = await ownerQuery(`SELECT note FROM task_history WHERE occurrence_id = $1 AND action = 'completed'`, [occ]);
      expect(h.note).toMatch(/synced after the day ended/);
    });
  });
});
