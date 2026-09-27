import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { hashSecret } from '../common/crypto';

/** A temporary password: 16 characters, easy to read out, changed at first sign-in. */
export function temporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return [...randomBytes(16)].map((b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Creates a new security company (a tenant) and its first system administrator.
 * A platform action, so it runs as the database owner, never through the app.
 */
export async function createCompany(ownerUrl: string, input: { name: string; adminName: string; adminEmail: string }) {
  const name = input.name.trim();
  const adminName = input.adminName.trim();
  const email = input.adminEmail.trim().toLowerCase();
  if (name.length < 2) throw new Error('Give the company name.');
  if (adminName.length < 2) throw new Error("Give the administrator's full name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Give the administrator's email address.");
  const password = temporaryPassword();
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    if ((await client.query('SELECT 1 FROM users WHERE lower(email) = $1', [email])).rowCount) throw new Error('That email address already has an On Par account.');
    const { id: companyId } = (await client.query('INSERT INTO companies (name) VALUES ($1) RETURNING id', [name])).rows[0];
    const { id: userId } = (
      await client.query(
        `INSERT INTO users (company_id, email, full_name, password_hash, role, must_change_password) VALUES ($1, $2, $3, $4, 'system_admin', true) RETURNING id`,
        [companyId, email, adminName, await hashSecret(password)],
      )
    ).rows[0];
    await client.query(
      `INSERT INTO audit_log (company_id, actor_type, actor_label, action, entity_type, entity_id, after)
       VALUES ($1, 'system', 'Platform', 'company.create', 'company', $1, $2)`,
      [companyId, JSON.stringify({ name, adminName, adminEmail: email, adminUserId: userId })],
    );
    await client.query('COMMIT');
    return { companyId, userId, email, password };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}
