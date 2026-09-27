import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Loads apps/api/.env into process.env without overriding values already set. */
function loadDotEnv() {
  const file = resolve(__dirname, '..', '.env');
  const alt = resolve(__dirname, '..', '..', '.env');
  const path = existsSync(file) ? file : existsSync(alt) ? alt : null;
  if (!path) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}. See apps/api/.env.example.`);
  return v;
}

export interface Config {
  databaseUrl: string;
  databaseOwnerUrl: string;
  jwtSecret: string;
  dataKey: Buffer;
  uploadDir: string;
  port: number;
  webOrigin: string;
  /** Send the sign-in cookie over HTTPS only. Browsers treat localhost as secure, so this stays on in development. */
  cookieSecure: boolean;
  /** Which proxies to trust for the caller's IP address (Express 'trust proxy'). */
  trustProxy: string;
  /** File storage. Local disk unless STORAGE_DRIVER=s3. Files are encrypted by the app either way. */
  storage?: { driver: 'local' } | { driver: 's3'; bucket: string; region: string; kmsKeyId?: string };
}

export function loadConfig(): Config {
  const dataKey = Buffer.from(required('DATA_KEY'), 'base64');
  if (dataKey.length !== 32) throw new Error('DATA_KEY must be 32 bytes, base64-encoded.');
  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters.');
  return {
    databaseUrl: required('DATABASE_URL'),
    databaseOwnerUrl: process.env.DATABASE_OWNER_URL ?? '',
    jwtSecret,
    dataKey,
    uploadDir: process.env.UPLOAD_DIR ?? './uploads',
    port: Number(process.env.PORT ?? 4000),
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    cookieSecure: process.env.COOKIE_SECURE !== 'false',
    trustProxy: process.env.TRUST_PROXY ?? 'loopback',
    storage:
      process.env.STORAGE_DRIVER === 's3'
        ? { driver: 's3', bucket: required('S3_BUCKET'), region: process.env.S3_REGION ?? 'af-south-1', kmsKeyId: process.env.S3_KMS_KEY_ID || undefined }
        : { driver: 'local' },
  };
}

export const CONFIG = Symbol('CONFIG');
