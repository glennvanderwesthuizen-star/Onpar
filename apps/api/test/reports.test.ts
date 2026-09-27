import { randomUUID } from 'node:crypto';
import { REPORT_COLOURS } from '@onpar/rules';
import { enrol, enrolmentData, ownerQuery, PNG, setupWorld, World } from './helpers';

/** Milestone 5: reports and close-out (section 6.6; scenarios 1, 8, 10, 16). */
describe('reports', () => {
  let w: World;
  let admin: string;
  let supervisor: string;
  let manager: string;
  let deviceToken: string;
  let john: { token: string; pin: string; id: string };
  let mary: { token: string; pin: string; id: string };
  let plumber: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const g = (who: { token: string }) => ({ 'X-Device-Token': deviceToken, Authorization: `Bearer ${who.token}` });
  const now = () => new Date().toISOString();
  const report = (who: { token: string }, data: Record<string, unknown>, photo = false) => {
    let r = w
      .http()
      .post('/api/device/reports')
      .set(g(who))
      .field('data', JSON.stringify({ eventId: randomUUID(), category: 'maintenance', priority: 'amber', description: 'Gate 2 motor is damaged', trustedAt: now(), deviceClock: now(), ...data }));
    if (photo) r = r.attach('photo', PNG, { filename: 'gate.png', contentType: 'image/png' });
    return r;
  };
  const followUp = (who: { token: string }, id: string, outcome: string, note = '') =>
    w.http().post(`/api/device/reports/${id}/follow-up`).set(g(who)).send({ eventId: randomUUID(), outcome, note, trustedAt: now(), deviceClock: now() });
  const act = (token: string, id: string, action: string, body: Record<string, unknown> = {}) =>
    w.http().post(`/api/reports/${id}/${action}`).set(auth(token)).send({ note: '', ...body });
  const detail = async (id: string) => (await w.http().get(`/api/reports/${id}`).set(auth(supervisor))).body;

  const onDuty = async (idNumber: string, name: string) => {
    const o = await enrol(w, admin, enrolmentData(w.a.siteId, { idNumber, fullName: name }));
    const token = (await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: o.body.officer.employeeNumber, pin: o.body.initialPin })).body.token;
    const who = { token, pin: o.body.initialPin, id: o.body.officer.id };
    const on = await w.http().post('/api/device/duty').set(g(who)).send({ eventId: randomUUID(), kind: 'duty_on', pin: who.pin, trustedAt: now(), deviceClock: now() });
    return { ...who, dutyEventId: on.body.dutyEventId as string };
  };

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    supervisor = await w.login('supervisor@a.test');
    manager = await w.login('manager@a.test');
    // A site manager for Estate ABC, to receive Red reports.
    const [sm] = await ownerQuery(
      `INSERT INTO users (company_id, email, full_name, password_hash, role) VALUES ($1, 'sitemanager@a.test', 'Lerato Site Manager', 'x', 'site_manager') RETURNING id`,
      [w.a.companyId],
    );
    await ownerQuery('INSERT INTO user_sites (company_id, user_id, site_id) VALUES ($1, $2, $3)', [w.a.companyId, sm.id, w.a.siteId]);
    const d = await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Device 001', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Gate 2' });
    deviceToken = d.body.deviceToken;
    const j = await onDuty('8001015009087', 'John Smith');
    // John completes his Duty On declaration, raising a comment as an equipment report.
    await w
      .http()
      .post('/api/device/declarations')
      .set(g(j))
      .field('data', JSON.stringify({ eventId: randomUUID(), dutyEventId: j.dutyEventId, accepted: [true, true, true], comment: 'Torch at Gate 2 does not work', raiseEquipmentReport: true, equipmentReportPriority: 'amber', trustedAt: now(), deviceClock: now() }))
      .attach('selfie', PNG, { filename: 's.png', contentType: 'image/png' });
    john = j;
    mary = await onDuty('9202204720083', 'Mary Dube');
  });
  afterAll(() => w.app.close());

  it('turns a declaration comment raised as an equipment report into a report (section 6.2)', async () => {
    const r = await w.http().get('/api/reports').set(auth(supervisor));
    expect(r.body.rows).toEqual([expect.objectContaining({ number: 1, category: 'equipment', priority: 'amber', source: 'declaration', reportedBy: 'John Smith', description: 'Torch at Gate 2 does not work' })]);
  });

  let gate: string;
  it('lets a guard report the damaged gate with a photo, routed to the site supervisor (scenario 1)', async () => {
    const eventId = randomUUID();
    const r = await report(john, { eventId }, true);
    expect(r.status).toBe(200);
    expect(r.body.number).toBe(2);
    gate = r.body.id;
    const again = await report(john, { eventId }, true);
    expect(again.body.id).toBe(gate);
    const d = await detail(gate);
    expect(d).toMatchObject({ stage: 'reported', hasPhoto: true, reportedBy: 'John Smith', recipients: [{ name: 'Peter Supervisor', role: 'site_supervisor' }] });
    expect(d.history).toEqual([expect.objectContaining({ action: 'reported', actorLabel: 'John Smith', actorRole: 'Security officer' })]);
  });

  it('routes Red reports to the site manager as well', async () => {
    const r = await report(mary, { category: 'security', priority: 'red', description: 'Suspicious vehicle circling the estate' });
    const d = await detail(r.body.id);
    expect(d.recipients.map((x: { name: string }) => x.name).sort()).toEqual(['Lerato Site Manager', 'Peter Supervisor']);
  });

  it('gives open reports different colours (scenario 16)', async () => {
    const rows = (await w.http().get('/api/reports').set(auth(supervisor))).body.rows;
    const colours = rows.map((r: { colour: string }) => r.colour);
    expect(new Set(colours).size).toBe(colours.length);
  });

  it('links an injury report to the Duty On declaration (scenario 10)', async () => {
    const r = await report(john, { category: 'injury', priority: 'amber', description: 'Twisted my ankle on the stairs' });
    const d = await detail(r.body.id);
    expect(d.declaration.statements[0].text).toMatch(/fit and free of injury/);
    expect(d.declaration.statements.every((s: { accepted: boolean }) => s.accepted)).toBe(true);
  });

  it('refuses a follow-up before the report is assigned', async () => {
    expect((await followUp(john, gate, 'in_progress')).status).toBe(409);
  });

  describe('the full lifecycle (scenarios 1 and 8)', () => {
    it('lets a supervisor add a contractor to the people directory', async () => {
      const r = await w.http().post('/api/people').set(auth(supervisor)).send({ name: 'Bongani Mokoena', role: 'Gate technician', phone: '083 555 0199', kind: 'contractor' });
      expect(r.status).toBe(201);
      plumber = r.body.id;
    });

    it('assigns the report to the contractor', async () => {
      expect((await act(supervisor, gate, 'assign', {})).status).toBe(400);
      const r = await act(supervisor, gate, 'assign', { assigneePersonId: plumber, note: 'Please attend today' });
      expect(r.status).toBe(201);
      expect(await detail(gate)).toMatchObject({ stage: 'assigned', assigneeName: 'Bongani Mokoena', assigneeRole: 'Gate technician' });
    });

    it('lets the reporter follow up without waiting; it is flagged for the supervisor', async () => {
      const r = await followUp(john, gate, 'not_started', 'Nobody has come yet');
      expect(r.body.stage).toBe('assigned');
      const d = await detail(gate);
      expect(d.needsAttention).toBe(true);
      expect(d.history.at(-1)).toMatchObject({ action: 'follow_up', outcome: 'not_started', note: 'Not started yet · Nobody has come yet' });
    });

    it('records the work as actioned; "Not fixed" from another officer on site sends it back to Assigned', async () => {
      expect((await act(supervisor, gate, 'attendance_checked')).status).toBe(409);
      expect((await act(supervisor, gate, 'actioned', { note: 'Technician replaced the gate motor fuse' })).status).toBe(201);
      expect((await detail(gate)).needsAttention).toBe(false);
      const r = await followUp(mary, gate, 'not_fixed', 'Gate still does not close');
      expect(r.body.stage).toBe('assigned');
    });

    it('sends an inspection task to the post once attendance is checked', async () => {
      await act(supervisor, gate, 'actioned', { note: 'Technician came back and replaced the motor' });
      await act(supervisor, gate, 'attendance_checked', { note: 'Technician signed in at the gate at 10:05' });
      const tasks = (await w.http().get('/api/device/tasks').set(g(john))).body;
      const inspect = tasks.find((t: { reportId: string }) => t.reportId === gate);
      expect(inspect).toMatchObject({ title: 'Inspect the work on report #2', state: 'open' });
      const done = await w.http().post(`/api/device/tasks/${inspect.id}/complete`).set(g(john)).send({ eventId: randomUUID(), trustedAt: now(), deviceClock: now() });
      expect(done.status).toBe(409);
      expect(done.body.message).toMatch(/Record this inspection on the report/);
    });

    it('"Repair done, all OK" completes Job inspected and the inspection task (scenario 8)', async () => {
      const r = await followUp(john, gate, 'done_ok', 'Gate opens and closes properly');
      expect(r.body.stage).toBe('job_inspected');
      const d = await detail(gate);
      expect(d.inspection).toEqual([expect.objectContaining({ state: 'completed' })]);
      const [ev] = await ownerQuery(`SELECT employee_id FROM performance_events WHERE event_type = 'task_completed'`);
      expect(ev.employee_id).toBe(john.id);
    });

    it('is closed only by a company manager, and the reporter gets +1 (scenario 1)', async () => {
      expect((await act(supervisor, gate, 'close', { note: 'Done' })).status).toBe(403);
      expect((await act(manager, gate, 'close', { note: 'Signed off' })).status).toBe(201);
      const [ev] = await ownerQuery(`SELECT employee_id, impact::float AS impact, evidence FROM performance_events WHERE event_type = 'report_closed'`);
      expect(ev).toMatchObject({ employee_id: john.id, impact: 1 });
      expect(ev.evidence).toMatch(/^Report #2 \(Maintenance\) you made on .* was closed\.$/);
    });

    it('records every stage with who, role, note and time (scenario 8)', async () => {
      const d = await detail(gate);
      expect(d.history.map((h: { action: string }) => h.action)).toEqual([
        'reported',
        'assigned',
        'follow_up',
        'actioned',
        'follow_up',
        'actioned',
        'attendance_checked',
        'follow_up',
        'closed',
      ]);
      for (const h of d.history) {
        expect(h.actorLabel).toBeTruthy();
        expect(h.actorRole).toBeTruthy();
        expect(h.at).toBeTruthy();
      }
      expect(d.history.find((h: { action: string }) => h.action === 'closed')).toMatchObject({ actorLabel: 'Thandi Manager', actorRole: 'Company manager', note: 'Signed off' });
      await expect(ownerQuery(`UPDATE report_history SET note = 'x'`)).rejects.toThrow(/immutable/);
      await expect(ownerQuery('DELETE FROM report_history')).rejects.toThrow(/immutable/);
    });

    it('frees the closed report’s colour for the next new report (scenario 16)', async () => {
      const closed = await detail(gate);
      const r = await report(mary, { category: 'observation', priority: 'green', description: 'Street light out on the corner' });
      const next = await detail(r.body.id);
      expect(next.colour).toBe(closed.colour);
      expect(next.colour).toBe(REPORT_COLOURS[1]);
    });

    it('refuses follow-ups once closed', async () => {
      expect((await followUp(john, gate, 'not_fixed')).status).toBe(409);
    });
  });

  it('counts reported, resolved and outstanding', async () => {
    const r = await w.http().get('/api/reports?status=all').set(auth(supervisor));
    expect(r.body.counts).toMatchObject({ reported: 5, resolved: 1, outstanding: 4, redOpen: 1 });
  });

  it('lets a supervisor make a report too', async () => {
    const r = await w.http().post('/api/reports').set(auth(supervisor)).send({ siteId: w.a.siteId, category: 'client_issue', priority: 'green', description: 'Client asked for extra patrols on Friday' });
    expect(r.status).toBe(201);
  });

  it("keeps reports inside the company (scenario 14)", async () => {
    const b = await w.login('manager@b.test');
    expect((await w.http().get('/api/reports').set(auth(b))).body.rows).toEqual([]);
    expect((await w.http().get(`/api/reports/${gate}`).set(auth(b))).status).toBe(404);
    expect((await w.http().get('/api/people').set(auth(b))).body).toEqual([]);
  });
});
