import { randomUUID } from 'node:crypto';
import { enrol, enrolmentData, ownerQuery, PNG, setupWorld, World } from './helpers';

/** First versions of Panic and BOLO (owner's decisions D-27, D-28). */
// The start of an MP4 file (an "ftyp" box), enough for the file-type check.
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(16)]);

describe('panic and BOLO', () => {
  let w: World;
  let admin: string;
  let manager: string;
  let supervisor: string;
  let managerB: string;
  let deviceToken: string;
  let otherSiteDevice: string;
  let guard: { token: string; id: string };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const now = () => new Date().toISOString();
  const panic = (device: string, extra: Record<string, unknown> = {}, guardToken?: string) => {
    const r = w.http().post('/api/device/panic').set('X-Device-Token', device);
    if (guardToken) r.set(auth(guardToken));
    return r.send({ eventId: randomUUID(), trustedAt: now(), deviceClock: now(), lat: -26.1076, lng: 28.0567, accuracyM: 12, callStarted: true, ...extra });
  };
  const bolo = (device: string, note: string, photo = true, guardToken?: string, eventId = randomUUID()) => {
    let r = w.http().post('/api/device/bolo').set('X-Device-Token', device);
    if (guardToken) r = r.set(auth(guardToken));
    r = r.field('data', JSON.stringify({ eventId, note, trustedAt: now(), deviceClock: now() }));
    if (photo) r = r.attach('photo', PNG, { filename: 'car.png', contentType: 'image/png' });
    return r;
  };
  const openPanics = async (token: string) => (await w.http().get('/api/panic').set(auth(token))).body;

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    manager = await w.login('manager@a.test');
    supervisor = await w.login('supervisor@a.test');
    managerB = await w.login('manager@b.test');
    deviceToken = (
      await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Device 001', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Main gate' })
    ).body.deviceToken;
    // A second site the supervisor is not linked to, with its own phone.
    const otherSite = (
      await w.http().post('/api/sites').set(auth(manager)).send({
        name: 'Office Park',
        address: 'Rosebank',
        client: 'Office Park Body Corporate',
        minimumGrade: 'E',
        armed: false,
        shifts: [{ name: 'Day', kind: 'day', startTime: '06:00', endTime: '18:00', guardsRequired: 1 }],
      })
    ).body.id;
    otherSiteDevice = (
      await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Device 002', serialOrImei: '356938035643817', siteId: otherSite })
    ).body.deviceToken;
    const o = await enrol(w, admin, enrolmentData(w.a.siteId, { fullName: 'John Smith' }));
    const token = (
      await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ employeeNumber: o.body.officer.employeeNumber, pin: o.body.initialPin })
    ).body.token;
    guard = { token, id: o.body.officer.id };
  });
  afterAll(() => w.app.close());

  describe('panic', () => {
    it('works with nobody signed in and records the location taken at that moment', async () => {
      const r = await panic(deviceToken);
      expect(r.status).toBe(200);
      const list = await openPanics(manager);
      const p = list.find((x: { id: string }) => x.id === r.body.id);
      expect(p).toMatchObject({ siteId: w.a.siteId, deviceLabel: 'Device 001', postName: 'Main gate', employeeName: null, lat: -26.1076, lng: 28.0567, callStarted: true, acknowledgedAt: null });
    });

    it('records the guard when one is signed in on that phone', async () => {
      const r = await panic(deviceToken, {}, guard.token);
      const p = (await openPanics(manager)).find((x: { id: string }) => x.id === r.body.id);
      expect(p.employeeName).toBe('John Smith');
    });

    it('ignores a guard sign-in from another phone, but still raises the panic', async () => {
      const r = await panic(otherSiteDevice, {}, guard.token);
      expect(r.status).toBe(200);
      const p = (await openPanics(manager)).find((x: { id: string }) => x.id === r.body.id);
      expect(p.employeeName).toBeNull();
    });

    it('still raises a panic when no location could be taken', async () => {
      const r = await panic(deviceToken, { lat: null, lng: null, accuracyM: null, callStarted: false });
      expect(r.status).toBe(200);
      const p = (await openPanics(manager)).find((x: { id: string }) => x.id === r.body.id);
      expect(p.lat).toBeNull();
    });

    it('is recorded once when the phone retries', async () => {
      const eventId = randomUUID();
      await panic(deviceToken, { eventId });
      await panic(deviceToken, { eventId });
      const [{ n }] = await ownerQuery('SELECT count(*)::int AS n FROM panic_alerts WHERE id = $1', [eventId]);
      expect(n).toBe(1);
    });

    it('needs a registered phone', async () => {
      expect((await panic('not-a-device')).status).toBe(401);
    });

    it('is acknowledged and resolved once each, with a note', async () => {
      const id = (await panic(deviceToken)).body.id;
      expect((await w.http().post(`/api/panic/${id}/acknowledge`).set(auth(supervisor))).status).toBe(200);
      expect((await w.http().post(`/api/panic/${id}/resolve`).set(auth(supervisor)).send({ note: '' })).status).toBe(400);
      expect((await w.http().post(`/api/panic/${id}/resolve`).set(auth(supervisor)).send({ note: 'False alarm, checked by phone' })).status).toBe(200);
      expect((await w.http().post(`/api/panic/${id}/resolve`).set(auth(supervisor)).send({ note: 'Again' })).status).toBe(409);
      expect((await openPanics(manager)).some((x: { id: string }) => x.id === id)).toBe(false);
      const all = (await w.http().get('/api/panic?status=all').set(auth(manager))).body;
      expect(all.find((x: { id: string }) => x.id === id)).toMatchObject({ acknowledgedBy: 'Peter Supervisor', resolvedBy: 'Peter Supervisor', resolutionNote: 'False alarm, checked by phone' });
    });

    it('cannot be changed or deleted in the database, apart from acknowledging and resolving once', async () => {
      const id = (await panic(deviceToken)).body.id;
      await expect(ownerQuery('UPDATE panic_alerts SET lat = 0 WHERE id = $1', [id])).rejects.toThrow(/immutable/);
      await expect(ownerQuery('DELETE FROM panic_alerts WHERE id = $1', [id])).rejects.toThrow(/immutable/);
      await w.http().post(`/api/panic/${id}/resolve`).set(auth(manager)).send({ note: 'Resolved' });
      await expect(ownerQuery("UPDATE panic_alerts SET resolution_note = 'changed' WHERE id = $1", [id])).rejects.toThrow(/immutable/);
      await expect(ownerQuery('UPDATE panic_alerts SET resolved_at = now() WHERE id = $1', [id])).rejects.toThrow(/immutable/);
    });

    it('shows a site supervisor only the sites they look after', async () => {
      const r = await panic(otherSiteDevice);
      expect((await openPanics(supervisor)).some((x: { id: string }) => x.id === r.body.id)).toBe(false);
      expect((await w.http().post(`/api/panic/${r.body.id}/acknowledge`).set(auth(supervisor))).status).toBe(404);
      expect((await openPanics(manager)).some((x: { id: string }) => x.id === r.body.id)).toBe(true);
    });

    it('is never seen by another company', async () => {
      const r = await panic(deviceToken);
      expect(await openPanics(managerB)).toEqual([]);
      expect((await w.http().post(`/api/panic/${r.body.id}/acknowledge`).set(auth(managerB))).status).toBe(404);
    });
  });

  describe('BOLO', () => {
    it('takes a photo and a note with nobody signed in, and shows under Reports', async () => {
      const r = await bolo(deviceToken, 'White Toyota Hilux CA 123-456 circling the block');
      expect(r.status).toBe(200);
      const list = (await w.http().get('/api/bolos').set(auth(supervisor))).body;
      expect(list.find((x: { id: string }) => x.id === r.body.id)).toMatchObject({ note: 'White Toyota Hilux CA 123-456 circling the block', hasPhoto: true, employeeName: null, siteName: 'Estate ABC' });
      const photo = await w.http().get(`/api/bolos/${r.body.id}/photo`).set(auth(supervisor));
      expect(photo.status).toBe(200);
      expect(photo.headers['content-type']).toBe('image/png');
      const [{ n }] = await ownerQuery("SELECT count(*)::int AS n FROM audit_log WHERE action = 'bolo.photo_view' AND entity_id = $1", [r.body.id]);
      expect(n).toBe(1);
    });

    it('records the guard when signed in, and works without a photo', async () => {
      const r = await bolo(deviceToken, 'Man in a red jacket at the back fence', false, guard.token);
      const b = (await w.http().get('/api/bolos').set(auth(manager))).body.find((x: { id: string }) => x.id === r.body.id);
      expect(b).toMatchObject({ employeeName: 'John Smith', hasPhoto: false });
    });

    it('needs a note and is recorded once when the phone retries', async () => {
      expect((await bolo(deviceToken, '', false)).status).toBe(400);
      const eventId = randomUUID();
      await bolo(deviceToken, 'Grey Polo', true, undefined, eventId);
      await bolo(deviceToken, 'Grey Polo', true, undefined, eventId);
      const [{ n }] = await ownerQuery('SELECT count(*)::int AS n FROM bolos WHERE id = $1', [eventId]);
      expect(n).toBe(1);
      await expect(ownerQuery("UPDATE bolos SET note = 'x' WHERE id = $1", [eventId])).rejects.toThrow();
    });

    it('takes a video and a voice note too, and can be sent without a written note', async () => {
      const r = await w
        .http()
        .post('/api/device/bolo')
        .set('X-Device-Token', deviceToken)
        .set(auth(guard.token))
        .field('data', JSON.stringify({ eventId: randomUUID(), trustedAt: now(), deviceClock: now() }))
        .attach('voice', MP4, { filename: 'v.m4a', contentType: 'audio/mp4' })
        .attach('video', MP4, { filename: 'v.mp4', contentType: 'video/mp4' });
      expect(r.status).toBe(200);
      const b = (await w.http().get('/api/bolos').set(auth(manager))).body.find((x: { id: string }) => x.id === r.body.id);
      expect(b).toMatchObject({ hasVoice: true, hasVideo: true, hasPhoto: false, note: '' });
      const video = await w.http().get(`/api/bolos/${r.body.id}/video`).set(auth(manager));
      expect(video.status).toBe(200);
      expect(video.headers['content-type']).toBe('video/mp4');
      expect((await w.http().get(`/api/bolos/${r.body.id}/voice`).set(auth(manager))).status).toBe(200);
      // Nothing at all is refused.
      expect((await bolo(deviceToken, '', false)).status).toBe(400);
    });

    it('raises an orange alert that is acknowledged, then closed with what was done', async () => {
      const id = (await bolo(deviceToken, 'Blue Corolla, no plates, at the back gate')).body.id;
      const open = (await w.http().get('/api/bolos?status=open').set(auth(supervisor))).body;
      expect(open.some((x: { id: string }) => x.id === id)).toBe(true);
      expect((await w.http().post(`/api/bolos/${id}/acknowledge`).set(auth(supervisor))).status).toBe(200);
      expect((await w.http().post(`/api/bolos/${id}/resolve`).set(auth(supervisor)).send({ note: '' })).status).toBe(400);
      expect((await w.http().post(`/api/bolos/${id}/resolve`).set(auth(supervisor)).send({ note: 'SAPS informed; vehicle left' })).status).toBe(200);
      expect((await w.http().post(`/api/bolos/${id}/resolve`).set(auth(supervisor)).send({ note: 'again' })).status).toBe(409);
      expect((await w.http().get('/api/bolos?status=open').set(auth(supervisor))).body.some((x: { id: string }) => x.id === id)).toBe(false);
      await expect(ownerQuery("UPDATE bolos SET note = 'changed' WHERE id = $1", [id])).rejects.toThrow(/immutable/);
      await expect(ownerQuery("UPDATE bolos SET resolution_note = 'changed' WHERE id = $1", [id])).rejects.toThrow(/immutable/);
    });

    it('points only at a manager or supervisor discretion, once per BOLO, within the award limits', async () => {
      const id = (await bolo(deviceToken, 'Man photographing the gate', false, guard.token)).body.id;
      const [{ n: before }] = await ownerQuery("SELECT count(*)::int AS n FROM performance_events WHERE employee_id = $1", [guard.id]);
      expect(before).toBe(0); // nothing automatic
      expect((await w.http().post(`/api/bolos/${id}/award`).set(auth(supervisor)).send({ points: 3 })).status).toBe(403); // supervisor limit is 2
      expect((await w.http().post(`/api/bolos/${id}/award`).set(auth(supervisor)).send({ points: 2 })).status).toBe(200);
      expect((await w.http().post(`/api/bolos/${id}/award`).set(auth(manager)).send({ points: 1 })).status).toBe(409);
      const [ev] = await ownerQuery("SELECT impact, evidence, source_type FROM performance_events WHERE employee_id = $1", [guard.id]);
      expect(ev).toMatchObject({ source_type: 'bolo' });
      expect(Number(ev.impact)).toBe(2);
      expect(ev.evidence).toContain('Useful BOLO');
      // A BOLO sent with nobody signed in has nobody to award.
      const anon = (await bolo(deviceToken, 'Dog loose in the street', false)).body.id;
      expect((await w.http().post(`/api/bolos/${anon}/award`).set(auth(manager)).send({ points: 1 })).status).toBe(409);
    });

    it('keeps to site scope and company', async () => {
      const r = await bolo(otherSiteDevice, 'Blue bakkie');
      expect((await w.http().get('/api/bolos').set(auth(supervisor))).body.some((x: { id: string }) => x.id === r.body.id)).toBe(false);
      expect((await w.http().get(`/api/bolos/${r.body.id}/photo`).set(auth(supervisor))).status).toBe(404);
      expect((await w.http().get('/api/bolos').set(auth(managerB))).body).toEqual([]);
      expect((await w.http().get(`/api/bolos/${r.body.id}/photo`).set(auth(managerB))).status).toBe(404);
    });
  });
});
