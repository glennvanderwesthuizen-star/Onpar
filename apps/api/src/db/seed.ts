import { Client } from 'pg';
import { hashSecret } from '../common/crypto';

export interface SeedResult {
  companyId: string;
  users: { email: string; password: string; role: string }[];
  siteId: string;
}

/**
 * Creates a demo company with one user per main role and one site, matching
 * the prototype's demo data. Runs as the owner role, because creating a
 * company is a platform action no tenant user may perform.
 */
export async function seedDemo(ownerUrl: string, opts: { companyName?: string; emailDomain?: string } = {}): Promise<SeedResult> {
  const companyName = opts.companyName ?? 'TSF Demo Security';
  const domain = opts.emailDomain ?? 'demo.onpar.local';
  const password = 'OnPar-demo-2026';
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    const { id: companyId } = (await client.query('INSERT INTO companies (name) VALUES ($1) RETURNING id', [companyName])).rows[0];
    const hash = await hashSecret(password);
    const users = [
      { email: `admin@${domain}`, name: 'Sam Admin', role: 'system_admin' },
      { email: `manager@${domain}`, name: 'Thandi Manager', role: 'company_manager' },
      { email: `supervisor@${domain}`, name: 'Peter Supervisor', role: 'site_supervisor' },
    ];
    const ids: Record<string, string> = {};
    for (const u of users) {
      ids[u.role] = (
        await client.query(
          `INSERT INTO users (company_id, email, full_name, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [companyId, u.email, u.name, hash, u.role],
        )
      ).rows[0].id;
    }
    const { id: siteId } = (
      await client.query(
        `INSERT INTO sites (company_id, name, address, client, minimum_grade, armed, province) VALUES ($1, 'Estate ABC', 'Sandton', 'Estate ABC HOA', 'D', false, 'GP') RETURNING id`,
        [companyId],
      )
    ).rows[0];
    await client.query(
      `INSERT INTO site_shifts (company_id, site_id, name, kind, start_time, end_time, guards_required, equipment, sort_order) VALUES
         ($1, $2, 'Day', 'day', '06:00', '18:00', 2, '{"Radio":2,"Torch":2,"Handheld device":1}', 0),
         ($1, $2, 'Night', 'night', '18:00', '06:00', 2, '{"Radio":2,"Torch":2,"Handheld device":1}', 1)`,
      [companyId, siteId],
    );
    await client.query(
      `INSERT INTO site_contacts (company_id, site_id, kind, name, phone) VALUES
         ($1, $2, 'supervisor', 'Peter Supervisor', '082 555 0101'),
         ($1, $2, 'site_manager', 'Lerato Site Manager', '082 555 0102'),
         ($1, $2, 'control_room', 'Control room', '011 555 0100')`,
      [companyId, siteId],
    );
    await client.query('INSERT INTO user_sites (company_id, user_id, site_id) VALUES ($1, $2, $3)', [
      companyId,
      ids.site_supervisor,
      siteId,
    ]);
    await client.query('COMMIT');
    return { companyId, siteId, users: users.map((u) => ({ email: u.email, password, role: u.role })) };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}
