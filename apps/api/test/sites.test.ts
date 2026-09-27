import { ownerQuery, setupWorld, World } from './helpers';

const newSite = (overrides: Record<string, unknown> = {}) => ({
  name: 'Sandton Office Park',
  address: 'Sandton',
  client: 'Demo client',
  minimumGrade: 'C',
  armed: true,
  payrollStartDay: 26,
  shifts: [
    { name: 'Day', kind: 'day', startTime: '06:00', endTime: '18:00', guardsRequired: 3, equipment: { Radio: 3, Firearm: 1 } },
    { name: 'Night', kind: 'night', startTime: '18:00', endTime: '06:00', guardsRequired: 2 },
  ],
  contacts: { supervisor: { name: 'Peter', phone: '082 555 0101' }, control_room: { phone: '011 555 0100' } },
  ...overrides,
});

describe('sites (sections 6.13, 30, 36, 41)', () => {
  let w: World;
  let admin: string;
  let supervisor: string;

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    supervisor = await w.login('supervisor@a.test');
  });
  afterAll(() => w.app.close());

  it('creates a site with shifts, equipment and contacts, and audits it', async () => {
    const r = await w.http().post('/api/sites').set('Authorization', `Bearer ${admin}`).send(newSite());
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      name: 'Sandton Office Park',
      armed: true,
      payrollStartDay: 26,
      coverage: { officers: 0, neededPerDay: 5 },
      contacts: { supervisor: { phone: '082 555 0101' }, control_room: { phone: '011 555 0100' } },
    });
    expect(r.body.shifts.map((s: { startTime: string }) => s.startTime)).toEqual(['06:00', '18:00']);
    expect(r.body.shifts[0].equipment).toEqual({ Radio: 3, Firearm: 1 });
    const audit = await ownerQuery(`SELECT action FROM audit_log WHERE entity_id = $1`, [r.body.id]);
    expect(audit).toEqual([{ action: 'site.create' }]);
  });

  it('never accepts fewer than 1 guard on a shift', async () => {
    const bad = newSite({ name: 'Bad', shifts: [{ name: 'Day', kind: 'day', startTime: '06:00', endTime: '18:00', guardsRequired: 0 }] });
    const r = await w.http().post('/api/sites').set('Authorization', `Bearer ${admin}`).send(bad);
    expect(r.status).toBe(400);
    expect(r.body.errors['shifts.0.guardsRequired']).toMatch(/At least 1/);
  });

  it('blocks a duplicate site name', async () => {
    const r = await w.http().post('/api/sites').set('Authorization', `Bearer ${admin}`).send(newSite({ name: 'estate abc' }));
    expect(r.status).toBe(409);
  });

  it('edits in place and keeps shift IDs, so later records stay linked', async () => {
    const site = (await w.http().get(`/api/sites/${w.a.siteId}`).set('Authorization', `Bearer ${admin}`)).body;
    const edited = {
      ...site,
      name: 'Estate ABC North',
      payrollStartDay: 1,
      shifts: [{ ...site.shifts[0], startTime: '07:00', guardsRequired: 4 }, site.shifts[1]],
    };
    const r = await w.http().put(`/api/sites/${w.a.siteId}`).set('Authorization', `Bearer ${admin}`).send(edited);
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Estate ABC North');
    expect(r.body.payrollStartDay).toBe(1);
    expect(r.body.shifts[0]).toMatchObject({ id: site.shifts[0].id, startTime: '07:00', guardsRequired: 4 });
    expect(r.body.coverage.neededPerDay).toBe(6);
    const audit = await ownerQuery(`SELECT before->>'name' AS b, after->>'name' AS a FROM audit_log WHERE action = 'site.update'`);
    expect(audit).toEqual([{ b: 'Estate ABC', a: 'Estate ABC North' }]);
  });

  it('lets a supervisor see only assigned sites and not edit them', async () => {
    const list = await w.http().get('/api/sites').set('Authorization', `Bearer ${supervisor}`);
    expect(list.body.map((s: { id: string }) => s.id)).toEqual([w.a.siteId]);
    const create = await w.http().post('/api/sites').set('Authorization', `Bearer ${supervisor}`).send(newSite({ name: 'X' }));
    expect(create.status).toBe(403);
    const other = (await w.http().get('/api/sites').set('Authorization', `Bearer ${admin}`)).body.find(
      (s: { name: string }) => s.name === 'Sandton Office Park',
    );
    const r = await w.http().get(`/api/sites/${other.id}`).set('Authorization', `Bearer ${supervisor}`);
    expect(r.status).toBe(404);
  });

  it('rejects requests without a valid sign-in', async () => {
    expect((await w.http().get('/api/sites')).status).toBe(401);
    expect((await w.http().get('/api/sites').set('Authorization', 'Bearer nonsense')).status).toBe(401);
  });

  it('rejects a wrong password with a generic message', async () => {
    const r = await w.http().post('/api/auth/login').send({ email: 'admin@a.test', password: 'wrong' });
    expect(r.status).toBe(401);
    expect(r.body.message).toBe('Email or password is incorrect.');
    const unknown = await w.http().post('/api/auth/login').send({ email: 'nobody@a.test', password: 'wrong' });
    expect(unknown.body.message).toBe('Email or password is incorrect.');
  });
});
