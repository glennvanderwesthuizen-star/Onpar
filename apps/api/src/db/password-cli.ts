import '../config';
import { Client } from 'pg';
import { hashSecret, hashToken } from '../common/crypto';
import { temporaryPassword } from './company';

/**
 * Gives a user a new temporary password, for when nobody who can reset it on the Users page
 * can sign in (for example the only administrator forgot their password). Runs on the server
 * as the database owner. Also lifts a sign-in lock from too many wrong attempts. Audited.
 *
 * Usage: deploy/onpar.sh password admin@example.co.za
 */
async function main() {
  const email = (process.argv[2] ?? '').trim().toLowerCase();
  const url = process.env.DATABASE_OWNER_URL;
  if (!url || !email) {
    console.error('Usage: deploy/onpar.sh password their@email.co.za');
    process.exit(1);
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    const u = (await client.query('SELECT id, company_id, full_name, active FROM users WHERE lower(email) = $1', [email])).rows[0];
    if (!u) throw new Error(`There is no On Par account for ${email}. Check the spelling.`);
    const password = temporaryPassword();
    await client.query('UPDATE users SET password_hash = $2, must_change_password = true, active = true WHERE id = $1', [u.id, await hashSecret(password)]);
    await client.query('SELECT auth_throttle_clear($1)', [`email:${hashToken(email)}`]);
    await client.query(
      `INSERT INTO audit_log (company_id, actor_type, actor_label, action, entity_type, entity_id, after)
       VALUES ($1, 'system', 'Server administrator', 'user.password_reset', 'user', $2, $3)`,
      [u.company_id, u.id, JSON.stringify({ email, via: 'server command', reactivated: !u.active })],
    );
    await client.query('COMMIT');
    console.log(`New temporary password for ${u.full_name} (${email}):`);
    console.log(`  ${password}`);
    console.log('They sign in with it once and then choose their own password. Any sign-in lock has been lifted.');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
main();
