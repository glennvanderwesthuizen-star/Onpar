import { randomUUID } from 'node:crypto';
import { enrol, enrolmentData, ownerQuery, setupWorld, World } from './helpers';

/** The shift handover (owner, 7 Oct 2026; D-45). */
describe('shift handover', () => {
  let w: World;
  let admin: string;
  let device: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const people: { id: string; phone: Record<string, string> }[] = [];
  const onDuty = (employeeId: string) =>
    ownerQuery(
      `INSERT INTO attendance (company_id, employee_id, site_id, shift_id, shift_name, shift_date, duty_on_at, arrival_status)
       SELECT $1, $2, $3, id, name, current_date, now(), 'ON_TIME' FROM site_shifts WHERE site_id = $3 AND name = 'Day'`,
      [w.a.companyId, employeeId, w.a.siteId],
    );
  const items = (over: Partial<Record<string, { present: number; damaged?: boolean }>> = {}) =>
    [
      ['Radio', 2],
      ['Torch', 2],
      ['Handheld device', 1],
    ].map(([name, expected]) => ({ name, expected, present: over[name as string]?.present ?? expected, damaged: over[name as string]?.damaged ?? false }));

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    device = (await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Gate', serialOrImei: '356938035643666', siteId: w.a.siteId, postName: 'Main gate' })).body.deviceToken;
    for (const [name, idNumber] of [
      ['Outgoing Guard', '8001015009087'],
      ['Incoming Guard', '9202204720083'],
    ]) {
      const o = await enrol(w, admin, enrolmentData(w.a.siteId, { fullName: name, idNumber }));
      const token = (await w.http().post('/api/device/login').set('X-Device-Token', device).send({ login: o.body.officer.employeeNumber, pin: o.body.initialPin })).body.token;
      people.push({ id: o.body.officer.id, phone: { 'X-Device-Token': device, Authorization: `Bearer ${token}` } });
    }
  });
  afterAll(() => w.app.close());

  it('lists the shift’s equipment from the site setup once he is on duty', async () => {
    expect((await w.http().get('/api/device/shift-handover').set(people[0].phone)).body).toMatchObject({ onDuty: false });
    await onDuty(people[0].id);
    const r = (await w.http().get('/api/device/shift-handover').set(people[0].phone)).body;
    expect(r.equipment).toEqual([
      { name: 'Radio', count: 2 },
      { name: 'Torch', count: 2 },
      { name: 'Handheld device', count: 1 },
    ]);
    expect(r.mine).toBeNull();
  });

  it('the outgoing guard signs it once; a missing or damaged item becomes an equipment report', async () => {
    const eventId = randomUUID();
    const r = await w.http().post('/api/device/shift-handover').set(people[0].phone).send({ eventId, items: items({ Torch: { present: 1 } }), note: 'Gate 2 lock sticks' });
    expect(r.status).toBe(200);
    expect(r.body.mine).toMatchObject({ note: 'Gate 2 lock sticks' });
    // A retry is one handover; a second one for the same shift is refused.
    expect((await w.http().post('/api/device/shift-handover').set(people[0].phone).send({ eventId, items: items(), note: '' })).status).toBe(200);
    expect((await w.http().post('/api/device/shift-handover').set(people[0].phone).send({ eventId: randomUUID(), items: items(), note: '' })).status).toBe(409);
    const rep = await ownerQuery(`SELECT category, priority, description FROM reports WHERE site_id = $1`, [w.a.siteId]);
    expect(rep).toEqual([{ category: 'equipment', priority: 'amber', description: 'Shift handover: Torch: 1 of 2. Note: Gate 2 lock sticks' }]);
  });

  it('the incoming guard sees it, receives it, and a difference is reported', async () => {
    await ownerQuery(`UPDATE attendance SET duty_from_at = now() WHERE employee_id = $1`, [people[0].id]);
    await onDuty(people[1].id);
    const view = (await w.http().get('/api/device/shift-handover').set(people[1].phone)).body;
    expect(view.incoming).toMatchObject({ from: 'Outgoing Guard', note: 'Gate 2 lock sticks' });
    const received = view.incoming.items.map((i: { name: string; present: number }) => (i.name === 'Radio' ? { ...i, present: 1 } : i));
    const r = await w.http().post(`/api/device/shift-handover/${view.incoming.id}/receive`).set(people[1].phone).send({ items: received, note: 'One radio not on the charger' });
    expect(r.status).toBe(200);
    expect(r.body.incoming).toBeNull();
    expect((await w.http().post(`/api/device/shift-handover/${view.incoming.id}/receive`).set(people[1].phone).send({ items: received })).status).toBe(409);
    const reps = await ownerQuery(`SELECT description FROM reports WHERE site_id = $1 ORDER BY number`, [w.a.siteId]);
    expect(reps[1].description).toBe('Received at shift handover: Radio: handed over 2, received 1. Note: One radio not on the charger');
  });

  it('supervisors see the site’s handovers; another company does not', async () => {
    const supervisor = await w.login('supervisor@a.test');
    const list = (await w.http().get(`/api/sites/${w.a.siteId}/shift-handovers`).set(auth(supervisor))).body;
    expect(list[0]).toMatchObject({ from: 'Outgoing Guard', to: 'Incoming Guard', post: 'Main gate', reportNumber: 1, receivedReportNumber: 2 });
    const bAdmin = await w.login('admin@b.test');
    expect((await w.http().get(`/api/sites/${w.a.siteId}/shift-handovers`).set(auth(bAdmin))).status).toBe(404);
  });
});
