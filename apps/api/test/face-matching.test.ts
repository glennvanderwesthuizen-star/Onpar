import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sastDate } from '@onpar/rules';
import { FaceMatchService } from '../src/face/face-match.service';
import { enrolmentData, ownerQuery, setupWorld, World } from './helpers';

const photo = (name: string) => readFileSync(join(__dirname, 'fixtures', 'faces', name));

/**
 * Automatic face matching (D-36 stage 2), with public-domain test photos. Runs on the server,
 * only when the company has switched it on, and only ever produces a flag for a person to look at.
 */
describe('automatic face matching', () => {
  jest.setTimeout(120_000);
  let w: World;
  let admin: string;
  let deviceToken: string;
  let n = 0;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const faces = () => w.app.get(FaceMatchService);

  function idNumber(): string {
    const { validateSaId } = require('@onpar/rules');
    const base = `850303${String(5000 + n++).padStart(4, '0')}08`;
    for (let d = 0; d <= 9; d++) if (validateSaId(base + d).valid) return base + d;
    throw new Error('no check digit');
  }

  /** Enrols a guard with real photos: his face, ID document and PSIRA card. */
  async function enrolWith(face: string, idDoc: string, psira: string) {
    let req = w.http().post('/api/officers').set(auth(admin)).field('data', JSON.stringify(enrolmentData(w.a.siteId, { idNumber: idNumber(), fullName: `Guard ${n}` })));
    for (const [k, f] of [['face', face], ['full_body', face], ['id_document', idDoc], ['psira_card', psira]]) {
      req = req.attach(`photo_${k}`, photo(f), { filename: f, contentType: 'image/jpeg' });
    }
    const r = await req;
    expect(r.status).toBe(201);
    return r.body as { officer: { id: string; employeeNumber: string }; initialPin: string };
  }

  /** Duty On with a selfie, the way the post phone does it. */
  async function dutyOnWithSelfie(o: { officer: { employeeNumber: string }; initialPin: string }, selfie: string, liveness?: string) {
    const login = await w.http().post('/api/device/login').set('X-Device-Token', deviceToken).send({ login: o.officer.employeeNumber, pin: o.initialPin });
    const guard = { 'X-Device-Token': deviceToken, ...auth(login.body.token) };
    const at = `${sastDate(new Date(Date.now() - 24 * 3600 * 1000))}T05:5${n % 10}:00+02:00`;
    await w.http().post('/api/device/duty').set(guard).send({ eventId: randomUUID(), kind: 'duty_on', pin: o.initialPin, trustedAt: at, deviceClock: at });
    const pending = (await w.http().get('/api/device/me').set(guard)).body.pendingDeclaration;
    const declarationId = randomUUID();
    const data = { eventId: declarationId, dutyEventId: pending.dutyEventId, accepted: [true, true, true, true], trustedAt: at, deviceClock: at, ...(liveness ? { liveness } : {}) };
    const d = await w.http().post('/api/device/declarations').set(guard).field('data', JSON.stringify(data)).attach('selfie', photo(selfie), { filename: 's.jpg', contentType: 'image/jpeg' });
    expect(d.status).toBe(200);
    return declarationId;
  }

  beforeAll(async () => {
    w = await setupWorld();
    admin = await w.login('admin@a.test');
    deviceToken = (
      await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Gate', serialOrImei: '356938035643809', siteId: w.a.siteId })
    ).body.deviceToken;
  });
  afterAll(() => w.app.close());

  it('does nothing until the company switches it on', async () => {
    const o = await enrolWith('person-a.jpg', 'person-a.jpg', 'person-b.jpg');
    await faces().idle();
    expect(await ownerQuery('SELECT 1 FROM face_matches WHERE employee_id = $1', [o.officer.id])).toHaveLength(0);
    expect((await w.http().get('/api/privacy/face-matching').set(auth(admin))).body.enabled).toBe(false);
  });

  it('switching it on needs a reason and is audited', async () => {
    expect((await w.http().put('/api/privacy/face-matching').set(auth(admin)).send({ enabled: true })).status).toBe(400);
    const r = await w.http().put('/api/privacy/face-matching').set(auth(admin)).send({ enabled: true, reason: 'Owner decision D-36' });
    expect(r.status).toBe(200);
    expect(await ownerQuery("SELECT 1 FROM audit_log WHERE action = 'privacy.face_matching'")).toHaveLength(1);
  });

  it('at enrolment, checks the face photo against the ID document and the PSIRA card', async () => {
    const o = await enrolWith('person-a.jpg', 'person-a-selfie.jpg', 'person-b.jpg');
    await faces().idle();
    const rec = (await w.http().get(`/api/officers/${o.officer.id}`).set(auth(admin))).body;
    const byKind = Object.fromEntries(rec.faceChecks.map((c: { kind: string; verdict: string }) => [c.kind, c.verdict]));
    expect(byKind).toEqual({ enrolment_id_document: 'match', enrolment_psira_card: 'no_match' });
  });

  it('checks each Duty On selfie: the same person passes, someone else is flagged for a person to look at', async () => {
    const o = await enrolWith('person-a.jpg', 'person-a.jpg', 'person-a.jpg');
    const good = await dutyOnWithSelfie(o, 'person-a-selfie.jpg');
    await faces().idle();
    const [m] = await ownerQuery('SELECT verdict, distance::float AS d FROM face_matches WHERE declaration_id = $1', [good]);
    expect(m.verdict).toBe('match');

    const o2 = await enrolWith('person-a.jpg', 'person-a.jpg', 'person-a.jpg');
    const bad = await dutyOnWithSelfie(o2, 'person-b.jpg');
    await faces().idle();
    const flagged = (await w.http().get('/api/selfie-checks?view=flagged').set(auth(admin))).body.rows;
    expect(flagged).toEqual([expect.objectContaining({ declarationId: bad, autoVerdict: 'no_match', result: null })]);
    // Only a flag: the guard's score and login are untouched.
    const [e] = await ownerQuery('SELECT status, pin_locked_at FROM employees WHERE id = $1', [o2.officer.id]);
    expect(e).toMatchObject({ status: 'active', pin_locked_at: null });
    // Once a person has looked and said it is him, it leaves the flagged list.
    await w.http().post('/api/selfie-checks').set(auth(admin)).send({ declarationId: bad, result: 'match', note: 'His brother covered with permission' });
    expect((await w.http().get('/api/selfie-checks?view=flagged').set(auth(admin))).body.rows).toHaveLength(0);
  });

  it('says so when a selfie shows no face (too dark, covered camera)', async () => {
    const o = await enrolWith('person-a.jpg', 'person-a.jpg', 'person-a.jpg');
    const d = await dutyOnWithSelfie(o, 'no-face.jpg');
    await faces().idle();
    const [m] = await ownerQuery('SELECT verdict, distance FROM face_matches WHERE declaration_id = $1', [d]);
    expect(m).toEqual({ verdict: 'no_face', distance: null });
  });

  it('records the blink check from the phone; a selfie taken without passing it is flagged for a person', async () => {
    const o = await enrolWith('person-a.jpg', 'person-a.jpg', 'person-a.jpg');
    const passed = await dutyOnWithSelfie(o, 'person-a-selfie.jpg', 'passed');
    const o2 = await enrolWith('person-a.jpg', 'person-a.jpg', 'person-a.jpg');
    const skipped = await dutyOnWithSelfie(o2, 'person-a-selfie.jpg', 'not_passed');
    await faces().idle();
    const rows = await ownerQuery('SELECT id, liveness FROM declarations WHERE id = ANY($1)', [[passed, skipped]]);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.liveness]))).toEqual({ [passed]: 'passed', [skipped]: 'not_passed' });
    const flagged = (await w.http().get('/api/selfie-checks?view=flagged').set(auth(admin))).body.rows.map((r: { declarationId: string }) => r.declarationId);
    expect(flagged).toContain(skipped);
    expect(flagged).not.toContain(passed);
  });

  it('keeps only results, which are never changed', async () => {
    await expect(ownerQuery("UPDATE face_matches SET verdict = 'match'")).rejects.toThrow(/immutable/);
    const cols = (await ownerQuery("SELECT column_name FROM information_schema.columns WHERE table_name = 'face_matches'")).map((c) => c.column_name);
    expect(cols).not.toContain('descriptor');
  });
});
