import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/main';
import { migrate } from '../src/db/migrate';
import { seedDemo, SeedResult } from '../src/db/seed';
import type { Config } from '../src/config';

const OWNER_URL = process.env.TEST_DATABASE_OWNER_URL ?? 'postgres://onpar_owner:onpar_owner_dev@localhost:5432/onpar_test';
const APP_URL = process.env.TEST_DATABASE_URL ?? 'postgres://onpar_app:onpar_app_dev@localhost:5432/onpar_test';

export const TEST_CONFIG: Config = {
  databaseUrl: APP_URL,
  databaseOwnerUrl: OWNER_URL,
  jwtSecret: randomBytes(32).toString('hex'),
  dataKey: randomBytes(32),
  uploadDir: mkdtempSync(join(tmpdir(), 'onpar-uploads-')),
  port: 0,
  webOrigin: 'http://localhost:3000',
};

/** Drops everything and re-runs all migrations, so each test file starts clean. */
export async function resetDatabase() {
  const c = new Client({ connectionString: OWNER_URL });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO onpar_app;');
  await c.end();
  await migrate(OWNER_URL, () => undefined);
}

export async function ownerQuery(sql: string, params: unknown[] = []) {
  const c = new Client({ connectionString: OWNER_URL });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

export interface World {
  app: INestApplication;
  http: () => ReturnType<typeof request>;
  a: SeedResult;
  b: SeedResult;
  login: (email: string, password?: string) => Promise<string>;
}

/** Two separate companies, A and B, each with demo users and a site. */
export async function setupWorld(): Promise<World> {
  await resetDatabase();
  const a = await seedDemo(OWNER_URL, { companyName: 'Company A', emailDomain: 'a.test' });
  const b = await seedDemo(OWNER_URL, { companyName: 'Company B', emailDomain: 'b.test' });
  const app = await createApp(TEST_CONFIG);
  await app.init();
  const http = () => request(app.getHttpServer());
  const login = async (email: string, password = 'OnPar-demo-2026') => {
    const r = await http().post('/api/auth/login').send({ email, password });
    if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status}`);
    return r.body.token as string;
  };
  return { app, http, a, b, login };
}

// Smallest valid PNG (1×1).
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

export const VALID_ID = '8001015009087';

export function enrolmentData(siteId: string, overrides: Record<string, unknown> = {}) {
  return {
    fullName: 'John Smith',
    idNumber: VALID_ID,
    cellNumber: '082 555 0199',
    nextOfKinName: 'Mary Smith',
    nextOfKinNumber: '082 555 0198',
    psiraNumber: 'PS1234567',
    psiraGrade: 'C',
    psiraExpiry: '2027-12-31',
    siteId,
    qualifications: [{ type: 'first_aid', name: 'First aid level 1', completionDate: '2025-01-10', expiryDate: '2028-01-10' }],
    issuedItems: [
      { item: 'Shirt', size: 'L', issueDate: '2026-09-01' },
      { item: 'Radio', assetNumber: 'RAD-0042', issueDate: '2026-09-01' },
    ],
    ...overrides,
  };
}

/** Builds a multipart enrolment request with the given photos attached. */
export function enrol(
  world: World,
  token: string,
  data: Record<string, unknown>,
  photos: string[] = ['face', 'full_body', 'id_document', 'psira_card'],
) {
  let req = world.http().post('/api/officers').set('Authorization', `Bearer ${token}`).field('data', JSON.stringify(data));
  for (const k of photos) req = req.attach(`photo_${k}`, PNG, { filename: `${k}.png`, contentType: 'image/png' });
  return req;
}
