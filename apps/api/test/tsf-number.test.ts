import { formatTsfNumber, idCardQr } from '@onpar/rules';
import { enrol, enrolmentData, ownerQuery, setupWorld, World } from './helpers';

/**
 * TSF number (owner, 4 Oct 2026): a plate-style username from the home site's province,
 * held in the ID card's QR code. The guard scans the card, then types the PIN every time.
 */
describe('TSF number and ID card sign-in', () => {
  let w: World;
  let admin: string;
  let deviceToken: string;
  let officer: { id: string; tsfNumber: string; employeeNumber: string };
  let pin: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const login = (body: Record<string, string>, token = deviceToken) =>
    w.http().post('/api/device/login').set('X-Device-Token', token).send(body);

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    deviceToken = (
      await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Gate phone', serialOrImei: '356938035643809', siteId: w.a.siteId })
    ).body.deviceToken;
    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    expect(o.status).toBe(201);
    officer = o.body.officer;
    pin = o.body.initialPin;
  });
  afterAll(() => w.app.close());

  it('issues a plate-style number from the home site province at enrolment', () => {
    expect(officer.tsfNumber).toMatch(/^[BCDFGHJKLMNPRSTVWXYZ]{3}\d{3}GP$/);
  });

  it('signs in by scanning the ID card, then the PIN', async () => {
    const r = await login({ login: idCardQr(officer.tsfNumber), pin });
    expect(r.status).toBe(200);
    expect(r.body.employee).toMatchObject({ id: officer.id, tsfNumber: officer.tsfNumber, employeeNumber: officer.employeeNumber });
  });

  it('also accepts the number typed with plate spacing, and the employee number (older apps)', async () => {
    expect((await login({ login: formatTsfNumber(officer.tsfNumber).toLowerCase(), pin })).status).toBe(200);
    expect((await login({ employeeNumber: officer.employeeNumber, pin })).status).toBe(200);
  });

  it('still needs the right PIN: a scanned card alone is not enough', async () => {
    const wrong = pin === '000000' ? '111111' : '000000';
    const r = await login({ login: idCardQr(officer.tsfNumber), pin: wrong });
    expect(r.status).toBe(401);
    expect(r.body.message).toBe('ID card or PIN is incorrect.');
    await ownerQuery('UPDATE employees SET pin_failed_attempts = 0 WHERE id = $1', [officer.id]);
  });

  it('does not let another company\'s phone sign in with the card', async () => {
    const bAdmin = await w.login('admin@b.test');
    const bDevice = (
      await w.http().post('/api/devices').set(auth(bAdmin)).send({ label: 'B phone', serialOrImei: '490154203237518', siteId: w.b.siteId })
    ).body.deviceToken;
    expect((await login({ login: idCardQr(officer.tsfNumber), pin }, bDevice)).status).toBe(401);
  });

  it('never changes a number once issued', async () => {
    await expect(ownerQuery("UPDATE employees SET tsf_number = 'BBB001WC' WHERE id = $1", [officer.id])).rejects.toThrow(/cannot be changed/);
    await expect(ownerQuery('UPDATE employees SET tsf_number = NULL WHERE id = $1', [officer.id])).rejects.toThrow(/cannot be changed/);
  });

  it('a site must have a province', async () => {
    const r = await w.http().post('/api/sites').set(auth(admin)).send({
      name: 'No Province', address: 'x', client: 'x', minimumGrade: 'E', armed: false,
      shifts: [{ name: 'Day', kind: 'day', startTime: '06:00', endTime: '18:00', guardsRequired: 1 }],
    });
    expect(r.status).toBe(400);
    expect(r.body.errors.province).toBeTruthy();
  });

  it('guards at a site from before provinces get their number when the province is set', async () => {
    // A site saved before provinces existed, with a guard enrolled there.
    await ownerQuery('UPDATE sites SET province = NULL WHERE id = $1', [w.a.siteId]);
    const o = await enrol(w, admin, enrolmentData(w.a.siteId, { idNumber: '9001015009086', fullName: 'Late Number' }));
    expect(o.status).toBe(201);
    expect(o.body.officer.tsfNumber).toBeNull();
    const site = (await w.http().get(`/api/sites/${w.a.siteId}`).set(auth(admin))).body;
    const { coverage, updatedAt, id, ...body } = site;
    const r = await w.http().put(`/api/sites/${w.a.siteId}`).set(auth(admin)).send({ ...body, province: 'WC' });
    expect(r.status).toBe(200);
    const after = (await w.http().get(`/api/officers/${o.body.officer.id}`).set(auth(admin))).body;
    expect(after.tsfNumber).toMatch(/WC$/);
    // The first guard keeps their Gauteng number.
    expect((await w.http().get(`/api/officers/${officer.id}`).set(auth(admin))).body.tsfNumber).toBe(officer.tsfNumber);
    const audit = await ownerQuery("SELECT 1 FROM audit_log WHERE action = 'officer.tsf_number_issued' AND entity_id = $1", [o.body.officer.id]);
    expect(audit.length).toBe(1);
  });
});
