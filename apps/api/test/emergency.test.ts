import { randomUUID } from 'node:crypto';
import { ownerQuery, PNG, setupWorld, World } from './helpers';

/** The emergency panel (owner, 7 Oct 2026): police, fire, ambulance and armed response on the post phone. */
describe('emergency panel', () => {
  let w: World;
  let admin: string;
  let manager: string;
  let device: string;
  let siteId: string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const now = () => new Date().toISOString();
  const contacts = async () => (await w.http().get('/api/device/contacts').set('X-Device-Token', device)).body as { kind: string; phone: string; emergency?: string; logo?: string | null; name: string }[];
  const site = (contactsBody: Record<string, unknown>) => ({
    name: 'Emergency Estate', address: 'Sandton', client: 'HOA', province: 'GP', minimumGrade: 'E', armed: false,
    shifts: [{ name: 'Day', kind: 'day', startTime: '06:00', endTime: '18:00', guardsRequired: 1 }],
    contacts: contactsBody,
  });

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    manager = await w.login('manager@a.test');
    siteId = (await w.http().post('/api/sites').set(auth(manager)).send(site({ control_room: { phone: '011 555 0100' } }))).body.id;
    device = (await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Device E1', serialOrImei: '356938035643999', siteId, postName: 'Main gate' })).body.deviceToken;
  });
  afterAll(() => w.app.close());

  it('a site with no emergency numbers still gives the phone the national ones', async () => {
    const c = await contacts();
    expect(c.filter((x) => x.emergency).map((x) => [x.kind, x.phone])).toEqual([
      ['police_national', '10111'],
      ['fire_national', '10177'],
      ['ambulance_national', '10177'],
    ]);
    expect(c.filter((x) => !x.emergency).map((x) => x.kind)).toEqual(['control_room']);
  });

  it('the site’s own numbers are saved with the site and reach the phone: two for police, one each for the rest', async () => {
    const r = await w.http().put(`/api/sites/${siteId}`).set(auth(manager)).send(
      site({
        control_room: { phone: '011 555 0100' },
        police_station: { name: 'Sandton SAPS', phone: '011 555 0001' },
        fire: { name: 'Sandton fire station', phone: '011 555 0002' },
        ambulance: { name: 'Private ambulance', phone: '011 555 0003' },
        armed_response: { name: 'Fast Response', phone: '011 555 0004' },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.body.contacts.armed_response).toEqual({ name: 'Fast Response', phone: '011 555 0004' });
    const e = (await contacts()).filter((x) => x.emergency);
    expect(e.map((x) => x.kind)).toEqual(['police_national', 'police_station', 'fire', 'ambulance', 'armed_response']);
    expect(e.find((x) => x.kind === 'armed_response')).toMatchObject({ name: 'Fast Response', logo: null });
  });

  it('the armed response logo is uploaded by a manager, reaches the phone, and can be removed', async () => {
    expect((await w.http().get('/api/device/armed-response-logo').set('X-Device-Token', device)).status).toBe(404);
    const bad = await w.http().post(`/api/sites/${siteId}/armed-response-logo`).set(auth(manager)).attach('logo', Buffer.from('hello'), { filename: 'x.txt', contentType: 'text/plain' });
    expect(bad.status).toBe(400);
    const up = await w.http().post(`/api/sites/${siteId}/armed-response-logo`).set(auth(manager)).attach('logo', PNG, { filename: 'logo.png', contentType: 'image/png' });
    expect(up.status).toBe(200);
    expect((await w.http().get(`/api/sites/${siteId}`).set(auth(manager))).body.armedResponseLogo).toBe(true);
    const onPhone = await w.http().get('/api/device/armed-response-logo').set('X-Device-Token', device);
    expect(onPhone.status).toBe(200);
    expect(onPhone.headers['content-type']).toContain('image/png');
    expect((await contacts()).find((x) => x.kind === 'armed_response')?.logo).toBeTruthy();
    // Another company cannot see or change it.
    const other = await w.login('manager@b.test');
    expect((await w.http().get(`/api/sites/${siteId}/armed-response-logo`).set(auth(other))).status).toBe(404);
    expect((await w.http().delete(`/api/sites/${siteId}/armed-response-logo`).set(auth(manager))).status).toBe(200);
    expect((await contacts()).find((x) => x.kind === 'armed_response')?.logo).toBeNull();
  });

  it('records each emergency number the guard taps, once, against the panic, without storing the number', async () => {
    const panicId = randomUUID();
    await w.http().post('/api/device/panic').set('X-Device-Token', device).send({ eventId: panicId, trustedAt: now(), deviceClock: now(), callStarted: true });
    const eventId = randomUUID();
    const call = () => w.http().post('/api/device/emergency-calls').set('X-Device-Token', device).send({ eventId, kind: 'police_station', panicId, trustedAt: now(), deviceClock: now() });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    await w.http().post('/api/device/emergency-calls').set('X-Device-Token', device).send({ eventId: randomUUID(), kind: 'ambulance_national', trustedAt: now(), deviceClock: now() });
    const rows = await ownerQuery('SELECT service, national, panic_id FROM emergency_calls WHERE site_id = $1 ORDER BY called_at', [siteId]);
    expect(rows).toEqual([
      { service: 'police', national: false, panic_id: panicId },
      { service: 'ambulance', national: true, panic_id: null },
    ]);
    const open = (await w.http().get('/api/panic').set(auth(manager))).body.find((p: { id: string }) => p.id === panicId);
    expect(open.emergencyCalls).toHaveLength(1);
    expect(open.emergencyCalls[0]).toMatchObject({ service: 'police', national: false });
    expect((await w.http().get(`/api/supervisor/panic/${panicId}`).set(auth(manager))).body.emergencyCalls).toHaveLength(1);
    const audit = await ownerQuery(`SELECT after FROM audit_log WHERE action = 'emergency.call' ORDER BY id`);
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain('011 555');
    // The record cannot be changed or removed.
    await expect(ownerQuery('DELETE FROM emergency_calls')).rejects.toThrow();
  });

  it('refuses an unknown kind and a phone without its key', async () => {
    expect((await w.http().post('/api/device/emergency-calls').set('X-Device-Token', device).send({ eventId: randomUUID(), kind: 'pizza', trustedAt: now(), deviceClock: now() })).status).toBe(400);
    expect((await w.http().post('/api/device/emergency-calls').send({ eventId: randomUUID(), kind: 'fire', trustedAt: now(), deviceClock: now() })).status).toBe(401);
  });
});
