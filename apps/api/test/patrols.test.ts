import { randomUUID } from 'node:crypto';
import { addDays, sastDate, sastInstant } from '@onpar/rules';
import { PatrolsService } from '../src/patrols/patrols.service';
import { enrol, enrolmentData, ownerQuery, PNG, setupWorld, World } from './helpers';

/**
 * Milestone 6: patrols (section 6.5, scenarios 2–7). Everything happens on
 * yesterday's day shift, sent late from the device, so results do not depend
 * on when the tests run.
 */
describe('patrols', () => {
  let w: World;
  let admin: string;
  let manager: string;
  let supervisor: string;
  let deviceToken: string;
  let guardToken: string;
  let pin: string;
  let dayShift: string;
  let typeA: string;
  let typeC: string;
  const codes: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const D1 = addDays(sastDate(new Date()), -1);
  const at = (hhmm: string) => `${D1}T${hhmm}:00+02:00`;
  const BASE = { lat: -26.1076, lng: 28.0567 };
  const near = (dLat = 0, dLng = 0) => ({ lat: BASE.lat + dLat, lng: BASE.lng + dLng });
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const guard = () => ({ 'X-Device-Token': deviceToken, Authorization: `Bearer ${guardToken}` });
  const scan = (point: string, hhmm: string, patrolId: string, where = near(), accuracyM = 6) =>
    w
      .http()
      .post('/api/device/patrols/scan')
      .set(guard())
      .send({ eventId: randomUUID(), patrolId, qrCode: codes[point], ...where, accuracyM, trustedAt: at(hhmm), deviceClock: at(hhmm) });
  const checks = (patrolId: string, point: string, hhmm: string, readings: unknown[], photo = true) => {
    let r = w
      .http()
      .post(`/api/device/patrols/${patrolId}/points/${ids[point]}`)
      .set(guard())
      .field('data', JSON.stringify({ eventId: randomUUID(), readings, trustedAt: at(hhmm), deviceClock: at(hhmm) }));
    if (photo) r = r.attach('photo', PNG, { filename: 'gauge.png', contentType: 'image/png' });
    return r;
  };
  const timer = () => w.app.get(PatrolsService);

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    manager = await w.login('manager@a.test');
    supervisor = await w.login('supervisor@a.test');
    const site = (await w.http().get(`/api/sites/${w.a.siteId}`).set(auth(manager))).body;
    dayShift = site.shifts.find((s: { name: string }) => s.name === 'Day').id;
    await w.http().put('/api/patrols/allocation').set(auth(manager)).send({ shiftId: dayShift, points: 6 });

    typeA = (await w.http().post('/api/patrols/types').set(auth(manager)).send({ siteId: w.a.siteId, code: 'A', name: 'Internal patrol' })).body.id;
    typeC = (await w.http().post('/api/patrols/types').set(auth(manager)).send({ siteId: w.a.siteId, code: 'C', name: 'Guard room check-in', singleScan: true })).body.id;
    await w.http().put(`/api/patrols/types/${typeA}/rules`).set(auth(manager)).send({ shiftId: dayShift, perShift: 4, minGapMinutes: 60, maxDurationMinutes: 45 });
    await w.http().put(`/api/patrols/types/${typeC}/rules`).set(auth(manager)).send({ shiftId: dayShift, perShift: 4, minGapMinutes: 120, maxDurationMinutes: 10 });

    const point = async (key: string, body: Record<string, unknown>) => {
      const r = await w.http().post('/api/patrols/points').set(auth(manager)).send({ lat: BASE.lat, lng: BASE.lng, ...body });
      ids[key] = r.body.id;
    };
    await point('gate', { patrolTypeId: typeA, name: 'Main gate' });
    await point('generator', {
      patrolTypeId: typeA,
      name: 'Generator room',
      instruction: 'Check the fuel gauge and photograph it.',
      photoMode: 'required',
      checks: [{ id: 'fuel', kind: 'number', label: 'Generator fuel', unit: 'litres', below: 50 }],
    });
    await point('fence', { patrolTypeId: typeA, name: 'North fence' });
    await point('guardroom', { patrolTypeId: typeC, name: 'Guard room' });
    const setup = (await w.http().get(`/api/patrols/setup?siteId=${w.a.siteId}`).set(auth(manager))).body;
    for (const p of setup.points) codes[Object.keys(ids).find((k) => ids[k] === p.id)!] = p.qrCode;

    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    pin = o.body.initialPin;
    deviceToken = (await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Device 001', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Gate 2' })).body.deviceToken;
    guardToken = (await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: '0001', pin })).body.token;
    await w.http().post('/api/device/duty').set(guard()).send({ eventId: randomUUID(), kind: 'duty_on', pin, trustedAt: at('05:55'), deviceClock: at('05:55') });
  });
  afterAll(() => w.app.close());

  describe('setup', () => {
    it('warns when the gap plus the maximum duration cannot fit a window', async () => {
      const r = await w.http().put(`/api/patrols/types/${typeA}/rules`).set(auth(manager)).send({ shiftId: dayShift, perShift: 12, minGapMinutes: 30, maxDurationMinutes: 45 });
      expect(r.body.warning).toMatch(/60 minutes.*75 minutes/);
      const ok = await w.http().put(`/api/patrols/types/${typeA}/rules`).set(auth(manager)).send({ shiftId: dayShift, perShift: 4, minGapMinutes: 60, maxDurationMinutes: 45 });
      expect(ok.body.warning).toBeNull();
    });

    it('lets only managers and site managers set patrols up', async () => {
      expect((await w.http().post('/api/patrols/types').set(auth(supervisor)).send({ siteId: w.a.siteId, code: 'B', name: 'Perimeter' })).status).toBe(403);
    });

    it('gives each point a unique QR code', () => {
      expect(new Set(Object.values(codes)).size).toBe(4);
      expect(codes.gate).toMatch(/^OP-/);
    });
  });

  describe('doing a patrol', () => {
    const p1 = randomUUID();

    it('rejects and logs a QR code scanned 480 m away (scenario 4)', async () => {
      const r = await scan('fence', '06:58', p1, near(480 / 111_320));
      expect(r.body).toMatchObject({ accepted: false, result: 'rejected_distance', patrol: null });
      expect(r.body.distanceM).toBeGreaterThan(470);
      const [log] = await ownerQuery(`SELECT result FROM patrol_scans WHERE result = 'rejected_distance'`);
      expect(log).toBeDefined();
    });

    it('rejects a scan with poor GPS accuracy (scenario 4)', async () => {
      const r = await scan('fence', '06:59', p1, near(), 60);
      expect(r.body).toMatchObject({ accepted: false, result: 'rejected_accuracy' });
    });

    it('starts the patrol with the first accepted scan, in any order (scenario 5)', async () => {
      const r = await scan('fence', '07:00', p1);
      expect(r.body.accepted).toBe(true);
      expect(r.body.patrol).toMatchObject({ state: 'active', typeCode: 'A' });
      expect(new Date(r.body.patrol.deadline).toISOString()).toBe(sastInstant(D1, '07:45').toISOString());
    });

    it('ignores a repeat scan within 2 minutes', async () => {
      expect((await scan('fence', '07:01', p1)).body.result).toBe('ignored_duplicate');
    });

    it('shows the instruction and asks for the checks at the generator', async () => {
      await scan('gate', '07:05', p1);
      const r = await scan('generator', '07:10', p1);
      expect(r.body.point).toMatchObject({ name: 'Generator room', instruction: 'Check the fuel gauge and photograph it.', photoMode: 'required' });
      expect(r.body.patrol.state).toBe('active');
    });

    it('will not save the point without the required photo (scenario 7)', async () => {
      const r = await checks(p1, 'generator', '07:11', [{ checkId: 'fuel', value: 30 }], false);
      expect(r.status).toBe(400);
      expect(r.body.message).toBe('A photo is required.');
    });

    it('raises an Amber report for fuel of 30 litres against a limit of 50, and completes the patrol (scenario 7)', async () => {
      const r = await checks(p1, 'generator', '07:12', [{ checkId: 'fuel', value: 30 }]);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ reportRaised: true, state: 'completed', pointsEarned: 0.75 });
      const [rep] = await ownerQuery(`SELECT priority, source, description FROM reports`);
      expect(rep).toMatchObject({ priority: 'amber', source: 'patrol' });
      expect(rep.description).toMatch(/Generator fuel: 30 litres \(below 50\)/);
      const [reading] = await ownerQuery(`SELECT value_num::float AS v, out_of_limit FROM patrol_readings`);
      expect(reading).toEqual({ v: 30, out_of_limit: true });
    });

    it('awards the patrol its share of the 6 patrol points (8 required patrols: 0.75 each)', async () => {
      const [ev] = await ownerQuery(`SELECT impact::float AS impact, evidence FROM performance_events WHERE event_type = 'patrol_completed'`);
      expect(ev.impact).toBe(0.75);
      expect(ev.evidence).toMatch(/patrol 1 of 8/);
    });

    it('completes a single-scan patrol with its one scan', async () => {
      const r = await scan('guardroom', '08:50', randomUUID());
      expect(r.body.patrol).toMatchObject({ state: 'completed', typeCode: 'C' });
    });

    it('blocks the next patrol until the minimum gap has passed (scenario 2)', async () => {
      const early = await scan('guardroom', '09:10', randomUUID());
      expect(early.body).toMatchObject({ accepted: false, result: 'rejected_not_open' });
      expect(early.body.message).toMatch(/minimum gap of 120 minutes/);
      expect(new Date(early.body.opensAt).toISOString()).toBe(sastInstant(D1, '10:50').toISOString());
      const later = await scan('guardroom', '10:51', randomUUID());
      expect(later.body.patrol.state).toBe('completed');
    });
  });

  describe('overdue alerts (scenario 3)', () => {
    const p2 = randomUUID();
    let alertId: string;

    it('raises an alert when a started patrol runs past its maximum duration', async () => {
      await scan('fence', '09:30', p2);
      expect((await timer().tick(sastInstant(D1, '10:14'))).raised).toBe(0);
      expect((await timer().tick(sastInstant(D1, '10:16'))).raised).toBe(1);
      const alerts = (await w.http().get('/api/patrols/alerts').set(auth(supervisor))).body;
      expect(alerts).toEqual([expect.objectContaining({ employeeName: 'John Smith', typeName: 'Internal patrol', escalatedAt: null })]);
      alertId = alerts[0].id;
    });

    it('escalates to the control room when nobody acknowledges within 10 minutes', async () => {
      await timer().tick(sastInstant(D1, '10:24'));
      expect((await w.http().get('/api/patrols/alerts').set(auth(supervisor))).body[0].escalatedAt).toBeNull();
      await timer().tick(sastInstant(D1, '10:26'));
      const [a] = (await w.http().get('/api/patrols/alerts').set(auth(supervisor))).body;
      expect(new Date(a.escalatedAt).toISOString()).toBe(sastInstant(D1, '10:25').toISOString());
    });

    it('clears when the patrol is completed', async () => {
      await scan('gate', '10:28', p2);
      await scan('generator', '10:30', p2);
      await checks(p2, 'generator', '10:31', [{ checkId: 'fuel', value: 80 }]);
      expect((await w.http().get('/api/patrols/alerts').set(auth(supervisor))).body).toEqual([]);
      const [al] = await ownerQuery('SELECT cleared_at, clear_reason FROM patrol_alerts WHERE id = $1', [alertId]);
      expect(al.clear_reason).toBe('The patrol was completed.');
    });

    it('also clears when a supervisor confirms the guard is safe', async () => {
      const p3 = randomUUID();
      await scan('fence', '12:10', p3);
      await timer().tick(sastInstant(D1, '13:00'));
      const [a] = (await w.http().get('/api/patrols/alerts').set(auth(supervisor))).body;
      expect((await w.http().post(`/api/patrols/alerts/${a.id}/safe`).set(auth(supervisor)).send({})).status).toBe(400);
      expect((await w.http().post(`/api/patrols/alerts/${a.id}/safe`).set(auth(supervisor)).send({ note: 'Called him: radio battery died, he is fine' })).status).toBe(201);
      expect((await w.http().get('/api/patrols/alerts').set(auth(supervisor))).body).toEqual([]);

      // He cannot finish it: partial, no penalty until reviewed.
      const r = await w.http().post(`/api/device/patrols/${p3}/cannot-finish`).set(guard()).send({ reason: 'Generator room locked', trustedAt: at('13:05'), deviceClock: at('13:05') });
      expect(r.body.state).toBe('partial');
      const before = await ownerQuery(`SELECT count(*)::int AS n FROM performance_events WHERE event_type = 'missed_patrol' AND source_id = $1`, [p3]);
      expect(before[0].n).toBe(0);
      await w.http().post(`/api/patrols/${p3}/review`).set(auth(supervisor)).send({ decision: 'not_accepted', note: 'The key is in the guard room' });
      const [ev] = await ownerQuery(`SELECT evidence FROM performance_events WHERE event_type = 'missed_patrol' AND source_id = $1`, [p3]);
      expect(ev.evidence).toMatch(/did not accept the reason/);
    });
  });

  describe('after the shift', () => {
    it('records windows with no patrol as missed patrols (0 points by default)', async () => {
      await timer().tick(sastInstant(D1, '18:30'));
      const missed = await ownerQuery(`SELECT t.code, p.window_index FROM patrol_instances p JOIN patrol_types t ON t.id = p.patrol_type_id WHERE p.state = 'missed' ORDER BY 1, 2`);
      expect(missed).toEqual([
        { code: 'A', window_index: 3 },
        { code: 'C', window_index: 2 },
        { code: 'C', window_index: 3 },
      ]);
      const ev = await ownerQuery(`SELECT impact::float AS impact FROM performance_events WHERE event_type = 'missed_patrol' AND source_type = 'patrol' AND evidence LIKE 'No %'`);
      expect(ev).toHaveLength(3);
      expect(ev.every((e) => e.impact === 0)).toBe(true);
    });

    it("shows the day's patrols with compliance per type, and rejected scans", async () => {
      const r = await w.http().get(`/api/patrols?date=${D1}`).set(auth(supervisor));
      const states = r.body.rows.map((x: { typeCode: string; state: string }) => `${x.typeCode}:${x.state}`);
      expect(states).toEqual(['A:completed', 'C:completed', 'A:completed', 'C:completed', 'A:partial', 'C:missed', 'A:missed', 'C:missed']);
      expect(r.body.compliance).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ typeCode: 'A', completed: 2, total: 4 }),
          expect.objectContaining({ typeCode: 'C', completed: 2, total: 4 }),
        ]),
      );
      expect(r.body.rejectedWithoutPatrol.map((x: { result: string }) => x.result).sort()).toEqual(['rejected_accuracy', 'rejected_distance', 'rejected_not_open']);
    });

    it('shows a patrol in full: scans, readings and the report raised', async () => {
      const first = (await w.http().get(`/api/patrols?date=${D1}`).set(auth(supervisor))).body.rows[0];
      const d = (await w.http().get(`/api/patrols/${first.id}`).set(auth(supervisor))).body;
      expect(d.scans.map((s: { result: string }) => s.result)).toEqual(['accepted', 'ignored_duplicate', 'accepted', 'accepted']);
      expect(d.readings).toEqual([expect.objectContaining({ label: 'Generator fuel', value: 30, outOfLimit: true, reportNumber: 1 })]);
    });

    it('keeps patrols inside the company (scenario 14)', async () => {
      const b = await w.login('manager@b.test');
      expect((await w.http().get(`/api/patrols?date=${D1}`).set(auth(b))).body.rows).toEqual([]);
      expect((await w.http().get(`/api/patrols/setup?siteId=${w.a.siteId}`).set(auth(b))).body.points).toEqual([]);
    });
  });

  describe('a point set up without a location learns it from its first scans (owner, 4 Oct 2026)', () => {
    let typeD: string;
    it('can be created without a location, and accepts scans while it learns', async () => {
      typeD = (await w.http().post('/api/patrols/types').set(auth(manager)).send({ siteId: w.a.siteId, code: 'D', name: 'Pump house check', singleScan: true })).body.id;
      await w.http().put(`/api/patrols/types/${typeD}/rules`).set(auth(manager)).send({ shiftId: dayShift, perShift: 12, minGapMinutes: 0, maxDurationMinutes: 10 });
      const r = await w.http().post('/api/patrols/points').set(auth(manager)).send({ patrolTypeId: typeD, name: 'Pump house' });
      expect(r.status).toBe(201);
      ids.pump = r.body.id;
      // Only one of latitude and longitude is refused.
      expect((await w.http().post('/api/patrols/points').set(auth(manager)).send({ patrolTypeId: typeD, name: 'Half', lat: -26.1 })).status).toBe(400);
      const setup = (await w.http().get(`/api/patrols/setup?siteId=${w.a.siteId}`).set(auth(manager))).body;
      const pt = setup.points.find((p: { id: string }) => p.id === ids.pump);
      codes.pump = pt.qrCode;
      expect(pt).toMatchObject({ lat: null, lng: null, learning: { agreeing: 0, needed: 10 } });
    });

    it('learns the location after 10 scans that agree, then checks distance as usual', async () => {
      // An inaccurate scan is still refused and does not count.
      expect((await scan('pump', '07:05', randomUUID(), near(), 60)).body.result).toBe('rejected_accuracy');
      for (let h = 8; h <= 16; h++) {
        const r = await scan('pump', `${String(h).padStart(2, '0')}:05`, randomUUID(), near((h % 3) * 0.00003, 0));
        expect(r.body.accepted).toBe(true);
      }
      let pt = (await w.http().get(`/api/patrols/setup?siteId=${w.a.siteId}`).set(auth(manager))).body.points.find((p: { id: string }) => p.id === ids.pump);
      expect(pt.learning.agreeing).toBe(9);
      expect((await scan('pump', '17:05', randomUUID(), near(0.00003, 0))).body.accepted).toBe(true);
      pt = (await w.http().get(`/api/patrols/setup?siteId=${w.a.siteId}`).set(auth(manager))).body.points.find((p: { id: string }) => p.id === ids.pump);
      expect(pt.locationSource).toBe('learned');
      expect(pt.lat).toBeCloseTo(BASE.lat, 3);
      const far = await scan('pump', '17:20', randomUUID(), near(480 / 111_320));
      expect(far.body.result).toBe('rejected_distance');
      const [audit] = await ownerQuery("SELECT after FROM audit_log WHERE action = 'patrol.point_location_learned'");
      expect(audit.after.fromScans).toBe(10);
    });

    it('clearing the location starts learning again', async () => {
      const body = { patrolTypeId: typeD, name: 'Pump house', lat: null, lng: null };
      expect((await w.http().put(`/api/patrols/points/${ids.pump}`).set(auth(manager)).send(body)).status).toBe(200);
      const pt = (await w.http().get(`/api/patrols/setup?siteId=${w.a.siteId}`).set(auth(manager))).body.points.find((p: { id: string }) => p.id === ids.pump);
      expect(pt).toMatchObject({ lat: null, locationSource: null });
    });
  });
});
