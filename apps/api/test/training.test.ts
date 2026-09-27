import { addDays, sastDate } from '@onpar/rules';
import { enrol, enrolmentData, ownerQuery, setupWorld, World } from './helpers';

/** Milestone 8: qualifications and training (section 6.9). */
describe('qualifications and training', () => {
  let w: World;
  let admin: string;
  let manager: string;
  let supervisor: string;
  let employeeId: string;
  let deviceToken: string;
  let guardToken: string;
  const today = sastDate(new Date());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const add = (token: string, data: Record<string, unknown>, pdf = false) => {
    let r = w.http().post(`/api/officers/${employeeId}/qualifications`).set(auth(token)).field('data', JSON.stringify(data));
    if (pdf) r = r.attach('certificate', Buffer.from('%PDF-1.4 test certificate'), { filename: 'cert.pdf', contentType: 'application/pdf' });
    return r;
  };
  const overview = async (q = '') => (await w.http().get(`/api/training${q}`).set(auth(manager))).body;

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    manager = await w.login('manager@a.test');
    supervisor = await w.login('supervisor@a.test');
    // Enrolment: PSIRA expires 2027-12-31 and first aid 2028-01-10 (test helper).
    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    employeeId = o.body.officer.id;
    deviceToken = (await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Device 001', serialOrImei: '356938035643809', siteId: w.a.siteId })).body.deviceToken;
    guardToken = (await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: '0001', pin: o.body.initialPin })).body.token;
  });
  afterAll(() => w.app.close());

  it('counts PSIRA registration and enrolment qualifications: all compliant', async () => {
    const o = await overview();
    expect(o.summary).toEqual({ total: 2, compliant: 2, expiring: 0, expired: 0, compliantPercent: 100 });
    expect(o.rows.map((r: { name: string }) => r.name)).toEqual(['PSIRA registration (grade C)', 'First aid level 1']);
  });

  it('records a new qualification with its certificate and gives +1 for completed training', async () => {
    const r = await add(manager, { type: 'firearm_competency', name: 'Handgun competency', completionDate: today, expiryDate: addDays(today, 10) }, true);
    expect(r.status).toBe(201);
    const [ev] = await ownerQuery(`SELECT impact::float AS impact, evidence FROM performance_events WHERE event_type = 'training_completed'`);
    expect(ev).toEqual({ impact: 1, evidence: expect.stringMatching(/^Completed Handgun competency on /) });
    const cert = await w.http().get(`/api/qualifications/${r.body.id}/certificate`).set(auth(supervisor));
    expect(cert.status).toBe(200);
    expect(cert.headers['content-type']).toBe('application/pdf');
  });

  it('shows expiring and expired items first, with the compliant percentage', async () => {
    await add(manager, { type: 'fire_fighting', name: 'Fire fighting level 1', expiryDate: '2026-01-01' });
    const o = await overview();
    expect(o.summary).toEqual({ total: 4, compliant: 2, expiring: 1, expired: 1, compliantPercent: 50 });
    expect(o.rows.slice(0, 2).map((r: { status: string }) => r.status)).toEqual(['EXPIRED', 'EXPIRING']);
    expect((await overview('?status=expired')).rows.map((r: { name: string }) => r.name)).toEqual(['Fire fighting level 1']);
  });

  it('keeps the old record when a qualification is renewed; the new one counts', async () => {
    await add(manager, { type: 'fire_fighting', name: 'Fire fighting level 1', completionDate: today, expiryDate: '2029-01-01' });
    expect((await overview()).summary).toMatchObject({ total: 4, expired: 0, expiring: 1 });
    const officer = (await w.http().get(`/api/officers/${employeeId}`).set(auth(manager))).body;
    const fire = officer.qualifications.filter((q: { type: string }) => q.type === 'fire_fighting');
    expect(fire.map((q: { expiryDate: string; current: boolean }) => `${q.expiryDate}:${q.current}`).sort()).toEqual(['2026-01-01:false', '2029-01-01:true']);
  });

  it('refuses a completion date in the future, and an expiry before completion', async () => {
    expect((await add(manager, { type: 'first_aid', name: 'First aid level 2', completionDate: addDays(today, 3) })).status).toBe(400);
    expect((await add(manager, { type: 'first_aid', name: 'First aid level 2', completionDate: today, expiryDate: addDays(today, -1) })).status).toBe(400);
  });

  it('corrects a record with an audit trail', async () => {
    const officer = (await w.http().get(`/api/officers/${employeeId}`).set(auth(manager))).body;
    const firearm = officer.qualifications.find((q: { type: string }) => q.type === 'firearm_competency');
    const r = await w.http().put(`/api/qualifications/${firearm.id}`).set(auth(manager)).send({ type: 'firearm_competency', name: 'Handgun competency', completionDate: today, expiryDate: '2031-06-30' });
    expect(r.status).toBe(200);
    expect((await overview()).summary).toMatchObject({ expiring: 0, compliantPercent: 100 });
    const [a] = await ownerQuery(`SELECT before->>'expiry_date' AS b, after->>'expiryDate' AS a FROM audit_log WHERE action = 'training.correct'`);
    expect(a.a).toBe('2031-06-30');
    // Correcting does not award the training point twice.
    const n = await ownerQuery(`SELECT count(*)::int AS n FROM performance_events WHERE event_type = 'training_completed' AND source_id = $1`, [firearm.id]);
    expect(n[0].n).toBe(1);
  });

  it('updates PSIRA registration, managers only, with a reason', async () => {
    expect((await w.http().put(`/api/officers/${employeeId}/psira`).set(auth(supervisor)).send({ psiraNumber: 'PS1234567', psiraGrade: 'B', psiraExpiry: '2029-12-31', reason: 'Upgraded' })).status).toBe(403);
    const r = await w.http().put(`/api/officers/${employeeId}/psira`).set(auth(manager)).send({ psiraNumber: 'PS1234567', psiraGrade: 'B', psiraExpiry: '2029-12-31', reason: 'Upgraded to grade B, checked on the PSIRA website' });
    expect(r.status).toBe(200);
    expect((await overview()).rows.find((x: { type: string }) => x.type === 'psira').name).toBe('PSIRA registration (grade B)');
  });

  it('lets the officer see their own qualifications on the device', async () => {
    const r = await w.http().get('/api/device/qualifications').set({ 'X-Device-Token': deviceToken, Authorization: `Bearer ${guardToken}` });
    expect(r.body.map((q: { name: string }) => q.name)).toEqual(expect.arrayContaining(['PSIRA registration (grade B)', 'Handgun competency', 'Fire fighting level 1']));
    expect(r.body).toHaveLength(4);
  });

  it('keeps training records inside the company (scenario 14)', async () => {
    const b = await w.login('manager@b.test');
    expect((await w.http().get('/api/training').set(auth(b))).body.rows).toEqual([]);
    expect((await w.http().post(`/api/officers/${employeeId}/qualifications`).set(auth(b)).field('data', JSON.stringify({ type: 'first_aid', name: 'x x' }))).status).toBe(404);
  });
});
