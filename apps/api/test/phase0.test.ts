import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { csvCell, csvFile } from '../src/common/csv';
import { enrol, enrolmentData, ownerQuery, setupWorld, World } from './helpers';

const nextSecond = () => new Promise((r) => setTimeout(r, 1100));

/** Phase 0 of the optimisation review (9 Oct 2026): health that alerts, sessions that end, and safe exports. */
describe('phase 0: protect the server', () => {
  let w: World;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    w = await setupWorld();
  });
  afterAll(() => {
    delete process.env.BACKUP_DIR;
    return w.app.close();
  });

  it('reports the database, and last night\'s backup, to the outside monitor', async () => {
    delete process.env.BACKUP_DIR;
    expect((await w.http().get('/api/health')).body).toEqual({ ok: true, problems: [] });
    const dir = mkdtempSync(join(tmpdir(), 'onpar-backups-'));
    process.env.BACKUP_DIR = dir;
    const none = await w.http().get('/api/health');
    expect(none.status).toBe(503);
    expect(none.body.problems).toEqual(['no backup found']);
    const file = join(dir, 'onpar-20261008-021500.tar.enc');
    writeFileSync(file, 'x');
    const old = new Date(Date.now() - 40 * 3600_000);
    utimesSync(file, old, old);
    expect((await w.http().get('/api/health')).body.problems).toEqual(['last backup 40 hours ago']);
    utimesSync(file, new Date(), new Date());
    expect((await w.http().get('/api/health')).status).toBe(200);
  });

  it('stops a guard who is suspended at once, not when his sign-in runs out', async () => {
    const admin = await w.login('admin@a.test');
    const d = await w.http().post('/api/devices').set(auth(admin)).send({ label: 'Post phone', serialOrImei: '356938035643809', siteId: w.a.siteId, postName: 'Gate' });
    const o = await enrol(w, admin, enrolmentData(w.a.siteId));
    const login = await w.http().post('/api/device/login').set('X-Device-Token', d.body.deviceToken).send({ employeeNumber: o.body.officer.employeeNumber, pin: o.body.initialPin });
    const g = { 'X-Device-Token': d.body.deviceToken, Authorization: `Bearer ${login.body.token}` };
    expect((await w.http().get('/api/device/me').set(g)).status).toBe(200);
    await ownerQuery(`UPDATE employees SET status = 'inactive' WHERE id = $1`, [o.body.officer.id]);
    const r = await w.http().get('/api/device/me').set(g);
    expect(r.status).toBe(401);
    await ownerQuery(`UPDATE employees SET status = 'active' WHERE id = $1`, [o.body.officer.id]);
  });

  it('signing out ends the sign-in on every device', async () => {
    const laptop = await w.login('supervisor@a.test');
    const phone = await w.login('supervisor@a.test');
    await nextSecond();
    expect((await w.http().post('/api/auth/logout').set(auth(laptop))).status).toBe(200);
    expect((await w.http().get('/api/auth/me').set(auth(phone))).status).toBe(401);
    // Signing in again works at once.
    const again = await w.login('supervisor@a.test');
    expect((await w.http().get('/api/auth/me').set(auth(again))).status).toBe(200);
  });

  it('a password change ends the other sessions and keeps this one', async () => {
    const other = await w.login('manager@a.test');
    const mine = await w.login('manager@a.test');
    await nextSecond();
    const r = await w.http().post('/api/auth/password').set(auth(mine)).send({ currentPassword: 'OnPar-demo-2026', newPassword: 'quiet river at noon' });
    expect(r.status).toBe(200);
    expect((await w.http().get('/api/auth/me').set(auth(other))).status).toBe(401);
    expect((await w.http().get('/api/auth/me').set(auth(r.body.token))).status).toBe(200);
  });

  it('exports cells that cannot run as spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+27 82 555 0100')).toBe("'+27 82 555 0100");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('Smith, John')).toBe('"Smith, John"');
    expect(csvFile(['A'], [['b']])).toBe('﻿A\r\nb\r\n');
  });
});
