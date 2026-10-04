import { enrol, enrolmentData, ownerQuery, setupWorld, VALID_ID, World } from './helpers';

/** Acceptance scenario 11 and section 6.12. */
describe('officer enrolment', () => {
  let w: World;
  let manager: string;
  let supervisor: string;
  let armedSiteId: string;

  beforeAll(async () => {
    w = await setupWorld();
    manager = await w.login('manager@a.test');
    supervisor = await w.login('supervisor@a.test');
    const r = await w
      .http()
      .post('/api/sites')
      .set('Authorization', `Bearer ${manager}`)
      .send({
        name: 'Armed Site',
        address: 'Midrand',
        client: 'Bank',
        province: 'GP', minimumGrade: 'B',
        armed: true,
        shifts: [{ name: 'Day', kind: 'day', startTime: '06:00', endTime: '18:00', guardsRequired: 1 }],
      });
    armedSiteId = r.body.id;
  });
  afterAll(() => w.app.close());

  it('is blocked without all four photos', async () => {
    const r = await enrol(w, manager, enrolmentData(w.a.siteId), ['face', 'full_body', 'id_document']);
    expect(r.status).toBe(400);
    expect(r.body.errors.photos).toBe('All four photos are required. Missing: PSIRA card.');
  });

  it('is blocked without required fields', async () => {
    const r = await enrol(w, manager, { siteId: w.a.siteId });
    expect(r.status).toBe(400);
    expect(Object.keys(r.body.errors)).toEqual(
      expect.arrayContaining(['fullName', 'idNumber', 'cellNumber', 'psiraNumber', 'psiraGrade', 'psiraExpiry']),
    );
  });

  it('rejects an ID number that fails the check digit', async () => {
    const r = await enrol(w, manager, enrolmentData(w.a.siteId, { idNumber: '8001015009088' }));
    expect(r.status).toBe(400);
    expect(r.body.errors.idNumber).toMatch(/check digit/);
  });

  let officerId: string;

  it('enrols a complete officer, masks the ID and encrypts it at rest', async () => {
    const r = await enrol(w, manager, enrolmentData(w.a.siteId));
    expect(r.status).toBe(201);
    expect(r.body.initialPin).toMatch(/^\d{6}$/);
    const o = r.body.officer;
    officerId = o.id;
    expect(o).toMatchObject({
      employeeNumber: '0001',
      fullName: 'John Smith',
      idNumberMasked: '•••••••••9087',
      dateOfBirth: '1980-01-01',
      siteName: 'Estate ABC',
      siteWarnings: [],
    });
    expect(o.photos.sort()).toEqual(['face', 'full_body', 'id_document', 'psira_card']);
    expect(o.issuedItems.map((i: { item: string }) => i.item)).toEqual(['Radio', 'Shirt']);
    expect(JSON.stringify(o)).not.toContain(VALID_ID);

    const [row] = await ownerQuery('SELECT id_number_enc, id_number_last4 FROM employees WHERE id = $1', [o.id]);
    expect(row.id_number_enc).not.toContain(VALID_ID);
    expect(row.id_number_last4).toBe('9087');

    const [audit] = await ownerQuery(`SELECT after::text AS after FROM audit_log WHERE action = 'officer.enrol'`);
    expect(audit.after).not.toContain(VALID_ID);
  });

  it('refuses the same ID number twice', async () => {
    const r = await enrol(w, manager, enrolmentData(w.a.siteId, { fullName: 'Someone Else' }));
    expect(r.status).toBe(409);
    expect(r.body.errors.idNumber).toMatch(/already enrolled/);
  });

  it('warns about a low grade and missing firearm competency at an armed site, and needs confirmation', async () => {
    const data = enrolmentData(armedSiteId, { idNumber: '9202204720083', psiraGrade: 'D' });
    const first = await enrol(w, manager, data);
    expect(first.status).toBe(409);
    expect(first.body.warnings).toEqual([
      "PSIRA grade D is below Armed Site's minimum of grade B.",
      'Armed Site is an armed site and this officer has no firearm competency on file.',
    ]);
    const second = await enrol(w, manager, { ...data, acknowledgeWarnings: true });
    expect(second.status).toBe(201);
    expect(second.body.officer.siteWarnings).toHaveLength(2);
    const [audit] = await ownerQuery(`SELECT reason FROM audit_log WHERE action = 'officer.enrol' AND entity_id = $1`, [
      second.body.officer.id,
    ]);
    expect(audit.reason).toMatch(/Enrolled despite warnings/);
  });

  it('does not let a supervisor enrol', async () => {
    const r = await enrol(w, supervisor, enrolmentData(w.a.siteId, { idNumber: '3001015009082' }));
    expect(r.status).toBe(403);
  });

  it('serves photos to permitted users and logs each view', async () => {
    const r = await w.http().get(`/api/officers/${officerId}/photos/face`).set('Authorization', `Bearer ${supervisor}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    const views = await ownerQuery(`SELECT actor_label FROM audit_log WHERE action = 'officer.photo_view'`);
    expect(views).toEqual([{ actor_label: 'Peter Supervisor' }]);
  });

  it('hides officers at sites a supervisor is not assigned to', async () => {
    const list = await w.http().get('/api/officers').set('Authorization', `Bearer ${supervisor}`);
    expect(list.body.map((o: { full_name: string }) => o.full_name)).toEqual(['John Smith']);
  });
});
