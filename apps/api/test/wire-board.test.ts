import { randomUUID } from 'node:crypto';
import { enrol, enrolmentData, ownerQuery, setupWorld, World } from './helpers';

/** The Wire, step 4 (owner, 8 Oct 2026): the recognition board. */
describe('The Wire: recognition board', () => {
  let w: World;
  let admin: string;
  let guards: { id: string; number: string; pin: string }[] = [];
  let device: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const ids = ['8001015009087', '9202204720083', '8606065009082'];
  const phoneFor = async (g: { number: string; pin: string }) => {
    const token = (await w.http().post('/api/device/login').set('X-Device-Token', device).send({ login: g.number, pin: g.pin })).body.token;
    return { 'X-Device-Token': device, Authorization: `Bearer ${token}` };
  };
  const month = (employeeId: string, m: string, overall: number, average: number | null, award: string | null = null, streak = 0) =>
    ownerQuery(`INSERT INTO wire_months (employee_id, month, company_id, overall, average, award, streak, facts) VALUES ($1, $2, $3, $4, $5, $6, $7, '{}')`, [employeeId, m, w.a.companyId, overall, average, award, streak]);

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    for (const [i, name] of ['Sipho Climber', 'Thabo Steady', 'Lerato Dip'].entries()) {
      const o = await enrol(w, admin, enrolmentData(w.a.siteId, { fullName: name, idNumber: ids[i] }));
      if (!o.body.officer) throw new Error(JSON.stringify(o.body));
      guards.push({ id: o.body.officer.id, number: o.body.officer.employeeNumber, pin: o.body.initialPin });
    }
    device = (await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Gate', serialOrImei: '356938035643444', siteId: w.a.siteId, postName: 'Main gate' })).body.deviceToken;
    await w.http().get('/api/wire').set(auth(admin));
    const today = new Date().toISOString().slice(0, 10);
    await ownerQuery(`INSERT INTO wire_month_runs (company_id, month) VALUES ($1, '2026-09')`, [w.a.companyId]);
    await month(guards[0].id, '2026-09', 88, 80, 'improvement');
    await month(guards[1].id, '2026-09', 97, 96, 'standard', 4);
    await month(guards[2].id, '2026-09', 70, 85);
    // Sipho passes 1,000 barbs today.
    await ownerQuery(`INSERT INTO wire_entries (company_id, employee_id, entry_date, rule, barbs, source_key) VALUES ($1, $2, $3, 'standard', 990, 'a'), ($1, $2, $3, 'ready_for_duty', 20, 'b')`, [w.a.companyId, guards[0].id, today]);
    void randomUUID;
  });
  afterAll(() => w.app.close());

  it('shows only guards who improved, best first, and nobody in last place', async () => {
    const b = (await w.http().get('/api/wire/board').set(auth(admin))).body;
    expect(b.month).toBe('2026-09');
    expect(b.improved.map((x: { display: string; improvedBy: number }) => [x.display.split(',')[0], x.improvedBy])).toEqual([
      ['Sipho Climber', 8],
      ['Thabo Steady', 1],
    ]);
    expect(JSON.stringify(b)).not.toContain('Lerato');
    expect(b.milestones).toEqual([expect.objectContaining({ label: 'Silver barb' })]);
  });

  it('a guard sees no names until each guard chooses to show his own', async () => {
    const sipho = await phoneFor(guards[0]);
    let b = (await w.http().get('/api/device/wire/board').set(sipho)).body;
    expect(b.improved.map((x: { display: string }) => x.display)).toEqual(['A guard, Estate ABC', 'A guard, Estate ABC']);
    expect(b.showMyName).toBe(false);
    expect(b.ownLine).toBe('Last month you beat your own average by 8 points and earned 0 barbs.');
    expect((await w.http().post('/api/device/wire/show-name').set(sipho).send({ show: true })).body).toEqual({ showMyName: true });
    b = (await w.http().get('/api/device/wire/board').set(sipho)).body;
    expect(b.improved[0].display).toBe('Sipho Climber, Estate ABC');
    expect(b.milestones[0]).toMatchObject({ display: 'Sipho Climber, Estate ABC', label: 'Silver barb' });
    expect(JSON.stringify(b)).not.toMatch(/Lerato|hidden/);
    const thabo = await phoneFor(guards[1]);
    expect((await w.http().get('/api/device/wire/board').set(thabo)).body.ownLine).toBe('Last month you held the standard, 4 months in a row, and earned 0 barbs.');
  });

  it('another company sees none of it', async () => {
    const bAdmin = await w.login('admin@b.test');
    const b = (await w.http().get('/api/wire/board').set(auth(bAdmin))).body;
    expect(b.improved).toEqual([]);
    expect(b.milestones).toEqual([]);
  });
});
