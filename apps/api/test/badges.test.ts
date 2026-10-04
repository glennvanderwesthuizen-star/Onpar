import { enrol, enrolmentData, ownerQuery, setupWorld, World } from './helpers';

/**
 * ID badge v2 (owner, 4 Oct 2026): the QR code holds only a random card code in a link.
 * The guard scans it at the post phone (then types the PIN); a supervisor scans it with any
 * camera and must be signed in and allowed to see the guard. Reissuing cancels the old card.
 */
describe('ID badges', () => {
  let w: World;
  let admin: string;
  let deviceToken: string;
  let officer: { id: string; fullName: string };
  let pin: string;
  let qr: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const token = (url: string) => url.split('/b/')[1];
  const login = (text: string, p = pin) => w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ login: text, pin: p });

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    deviceToken = (
      await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Gate phone', serialOrImei: '356938035643809', siteId: w.a.siteId })
    ).body.deviceToken;
    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    officer = o.body.officer;
    pin = o.body.initialPin;
  });
  afterAll(() => w.app.close());

  it('lists cards to print, with only a random code in the QR link', async () => {
    const r = await w.http().get('/api/badges').set(auth(admin));
    expect(r.status).toBe(200);
    const card = r.body.find((c: { id: string }) => c.id === officer.id);
    expect(card).toMatchObject({ fullName: officer.fullName, hasPhoto: true });
    qr = card.qr;
    expect(qr).toMatch(/^http:\/\/localhost:3000\/b\/[A-Za-z0-9_-]{24}$/);
    expect(qr).not.toContain(card.tsfNumber);
    // Listing again gives the same card, not a new one.
    expect((await w.http().get('/api/badges').set(auth(admin))).body.find((c: { id: string }) => c.id === officer.id).qr).toBe(qr);
  });

  it('only managers and admins print cards', async () => {
    const sup = await w.login('supervisor@a.test');
    expect((await w.http().get('/api/badges').set(auth(sup))).status).toBe(403);
  });

  it('signs the guard in at the post phone with the card and his PIN', async () => {
    const r = await login(qr);
    expect(r.status).toBe(200);
    expect(r.body.employee.id).toBe(officer.id);
    const wrong = pin === '000000' ? '111111' : '000000';
    expect((await login(qr, wrong)).status).toBe(401);
    await ownerQuery('UPDATE employees SET pin_failed_attempts = 0 WHERE id = $1', [officer.id]);
  });

  it('opens the guard\'s record for a signed-in supervisor of his site, and audits the scan', async () => {
    const sup = await w.login('supervisor@a.test');
    const r = await w.http().get(`/api/badges/scan/${token(qr)}`).set(auth(sup));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ employeeId: officer.id, cancelledAt: null });
    const audit = await ownerQuery("SELECT 1 FROM audit_log WHERE action = 'officer.badge_scan' AND entity_id = $1", [officer.id]);
    expect(audit.length).toBeGreaterThan(0);
  });

  it('shows nothing without signing in, or to another company', async () => {
    expect((await w.http().get(`/api/badges/scan/${token(qr)}`)).status).toBe(401);
    const b = await w.login('admin@b.test');
    expect((await w.http().get(`/api/badges/scan/${token(qr)}`).set(auth(b))).status).toBe(404);
  });

  it('reissuing cancels the old card at once', async () => {
    const r = await w.http().post(`/api/officers/${officer.id}/badge/reissue`).set(auth(admin)).send({ reason: 'Card lost' });
    expect(r.status).toBe(201);
    expect(r.body.qr).not.toBe(qr);
    const old = await login(qr);
    expect(old.status).toBe(401);
    expect(old.body.message).toMatch(/cancelled/);
    expect((await login(r.body.qr)).status).toBe(200);
    // The supervisor still sees whose card it was, marked cancelled.
    const scan = await w.http().get(`/api/badges/scan/${token(qr)}`).set(auth(admin));
    expect(scan.body.cancelReason).toBe('Card lost');
    const rec = (await w.http().get(`/api/officers/${officer.id}`).set(auth(admin))).body;
    expect(rec.badges).toHaveLength(2);
  });

  it('never deletes or un-cancels a card', async () => {
    await expect(ownerQuery('DELETE FROM employee_badges WHERE employee_id = $1', [officer.id])).rejects.toThrow(/never deleted/);
    await expect(ownerQuery('UPDATE employee_badges SET revoked_at = NULL, revoke_reason = NULL WHERE employee_id = $1', [officer.id])).rejects.toThrow(/only be cancelled/);
  });
});
