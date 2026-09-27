import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { enrol, enrolmentData, OWNER_URL, setupWorld, TEST_CONFIG, World } from './helpers';

const RESTORE_OWNER_URL = OWNER_URL.replace(/onpar_test$/, 'onpar_restore_test');
const RESTORE_APP_URL = RESTORE_OWNER_URL.replace('onpar_owner:onpar_owner_dev', 'onpar_app:onpar_app_dev');
const SCRIPTS = resolve(__dirname, '..', '..', '..', 'scripts');

async function owner(url: string, sql: string, params: unknown[] = []) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

/** Milestone 10: backups and a tested recovery process (brief section 9). */
describe('backup and restore', () => {
  let w: World;
  let restored: INestApplication;
  let officerId: string;
  const dir = mkdtempSync(join(tmpdir(), 'onpar-backup-'));
  const passphrase = join(dir, 'passphrase');
  const restoreUploads = join(dir, 'restored-files');
  let backupFile: string;
  const run = (script: string, args: string[], env: Record<string, string>) =>
    execFileSync(join(SCRIPTS, script), args, { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  beforeAll(async () => {
    w = await setupWorld();
    const admin = await w.login('admin@a.test');
    officerId = (await enrol(w, admin, enrolmentData(w.a.siteId))).body.officer.id;
    writeFileSync(passphrase, 'a long test passphrase kept apart from backups');
    // The restore target must start empty.
    await owner(RESTORE_OWNER_URL, 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  });
  afterAll(async () => {
    await restored?.close();
    await w.app.close();
  });

  it('makes one encrypted backup file with a checksum', () => {
    backupFile = run('backup.sh', [], { DATABASE_OWNER_URL: OWNER_URL, UPLOAD_DIR: TEST_CONFIG.uploadDir, BACKUP_DIR: dir, BACKUP_PASSPHRASE_FILE: passphrase }).trim();
    const bytes = readFileSync(backupFile);
    expect(bytes.subarray(0, 8).toString()).toBe('Salted__');
    // Nothing readable inside: not a name, not a table.
    expect(bytes.includes(Buffer.from('John Smith'))).toBe(false);
    expect(bytes.includes(Buffer.from('audit_log'))).toBe(false);
    expect(readFileSync(`${backupFile}.sha256`, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a wrong passphrase, a damaged file, and a database that is not empty', () => {
    const wrong = join(dir, 'wrong');
    writeFileSync(wrong, 'not the passphrase');
    const env = { TARGET_DATABASE_URL: RESTORE_OWNER_URL, TARGET_UPLOAD_DIR: restoreUploads };
    expect(() => run('restore.sh', [backupFile], { ...env, BACKUP_PASSPHRASE_FILE: wrong })).toThrow(/Check the passphrase/);
    const damaged = join(dir, 'damaged.tar.enc');
    const bytes = readFileSync(backupFile);
    bytes[bytes.length - 20] ^= 0xff;
    writeFileSync(damaged, bytes);
    writeFileSync(`${damaged}.sha256`, readFileSync(`${backupFile}.sha256`));
    expect(() => run('restore.sh', [damaged], { ...env, BACKUP_PASSPHRASE_FILE: passphrase })).toThrow(/does not match its checksum/);
    expect(() => run('restore.sh', [backupFile], { TARGET_DATABASE_URL: OWNER_URL, TARGET_UPLOAD_DIR: restoreUploads, BACKUP_PASSPHRASE_FILE: passphrase })).toThrow(
      /not empty/,
    );
  });

  it('restores into an empty database with every row count matching', () => {
    const out = run('restore.sh', [backupFile], { TARGET_DATABASE_URL: RESTORE_OWNER_URL, TARGET_UPLOAD_DIR: restoreUploads, BACKUP_PASSPHRASE_FILE: passphrase });
    expect(out).toMatch(/Restore complete: \d+ tables, all row counts match/);
  });

  describe('the restored copy', () => {
    beforeAll(async () => {
      restored = await createApp({ ...TEST_CONFIG, databaseUrl: RESTORE_APP_URL, databaseOwnerUrl: RESTORE_OWNER_URL, uploadDir: restoreUploads });
      await restored.init();
    });
    const http = () => request(restored.getHttpServer());
    const signIn = async (email: string) => (await http().post('/api/auth/login').send({ email, password: 'OnPar-demo-2026' })).body.token as string;

    it('works: people sign in and see their data, and photos open', async () => {
      const t = await signIn('admin@a.test');
      const officer = await http().get(`/api/officers/${officerId}`).set('Authorization', `Bearer ${t}`);
      expect(officer.body.fullName).toBe('John Smith');
      const photo = await http().get(`/api/officers/${officerId}/photos/face`).set('Authorization', `Bearer ${t}`);
      expect(photo.status).toBe(200);
      expect(photo.headers['content-type']).toBe('image/png');
    });

    it('keeps companies separated (row-level security survived)', async () => {
      const t = await signIn('admin@b.test');
      expect((await http().get('/api/officers').set('Authorization', `Bearer ${t}`)).body).toEqual([]);
      expect((await http().get(`/api/officers/${officerId}`).set('Authorization', `Bearer ${t}`)).status).toBe(404);
    });

    it('keeps the audit log append-only', async () => {
      await expect(owner(RESTORE_OWNER_URL, 'DELETE FROM audit_log')).rejects.toThrow(/append-only/);
    });
  });
});
