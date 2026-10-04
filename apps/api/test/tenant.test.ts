import { Client } from 'pg';
import { enrol, enrolmentData, ownerQuery, setupWorld, TEST_CONFIG, World } from './helpers';

/** Acceptance scenario 14: a user from one company can never read another company's data. */
describe('tenant separation', () => {
  let w: World;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    w = await setupWorld();
    tokenA = await w.login('admin@a.test');
    tokenB = await w.login('admin@b.test');
    const r = await enrol(w, tokenB, enrolmentData(w.b.siteId));
    expect(r.status).toBe(201);
  });
  afterAll(() => w.app.close());

  it("lists only the company's own sites", async () => {
    const r = await w.http().get('/api/sites').set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.map((s: { id: string }) => s.id)).toEqual([w.a.siteId]);
  });

  it("cannot open another company's site by ID", async () => {
    const r = await w.http().get(`/api/sites/${w.b.siteId}`).set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(404);
  });

  it("cannot edit another company's site", async () => {
    const r = await w
      .http()
      .put(`/api/sites/${w.b.siteId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        name: 'Hijacked',
        address: 'x',
        client: 'x',
        province: 'GP', minimumGrade: 'E',
        armed: false,
        payrollStartDay: 26,
        shifts: [{ name: 'Day', kind: 'day', startTime: '06:00', endTime: '18:00', guardsRequired: 1 }],
      });
    expect(r.status).toBe(404);
    const [site] = await ownerQuery('SELECT name FROM sites WHERE id = $1', [w.b.siteId]);
    expect(site.name).toBe('Estate ABC');
  });

  it("cannot see another company's officers or enrol onto its site", async () => {
    const list = await w.http().get('/api/officers').set('Authorization', `Bearer ${tokenA}`);
    expect(list.body).toEqual([]);
    const r = await enrol(w, tokenA, enrolmentData(w.b.siteId, { idNumber: '9202204720083' }));
    expect(r.status).toBe(400);
    expect(r.body.errors.siteId).toBeDefined();
  });

  it("does not show another company's audit log", async () => {
    const r = await w.http().get('/api/audit').set('Authorization', `Bearer ${tokenA}`);
    expect(r.body.every((e: { action: string }) => e.action !== 'officer.enrol')).toBe(true);
  });

  describe('in the database itself (row-level security)', () => {
    let db: Client;
    beforeAll(async () => {
      db = new Client({ connectionString: TEST_CONFIG.databaseUrl });
      await db.connect();
    });
    afterAll(() => db.end());

    const asCompany = async <T>(companyId: string | null, fn: () => Promise<T>) => {
      await db.query('BEGIN');
      try {
        if (companyId) await db.query(`SELECT set_config('app.company_id', $1, true)`, [companyId]);
        return await fn();
      } finally {
        await db.query('ROLLBACK');
      }
    };

    it('returns no rows at all when no company is set', async () => {
      const rows = await asCompany(null, async () => (await db.query('SELECT id FROM sites')).rows);
      expect(rows).toEqual([]);
      const emps = await asCompany(null, async () => (await db.query('SELECT id FROM employees')).rows);
      expect(emps).toEqual([]);
    });

    it("hides company B's rows from company A even with a direct query", async () => {
      const rows = await asCompany(w.a.companyId, async () =>
        (await db.query('SELECT id FROM employees UNION ALL SELECT id FROM sites WHERE id = $1', [w.b.siteId])).rows,
      );
      expect(rows).toEqual([]);
    });

    it("refuses to write a row into company B while acting for company A", async () => {
      await expect(
        asCompany(w.a.companyId, () =>
          db.query(
            `INSERT INTO sites (company_id, name, address, client, minimum_grade, armed) VALUES ($1, 'x', 'x', 'x', 'E', false)`,
            [w.b.companyId],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('cannot turn row-level security off', async () => {
      await expect(asCompany(w.a.companyId, () => db.query('ALTER TABLE sites DISABLE ROW LEVEL SECURITY'))).rejects.toThrow(
        /must be owner/,
      );
    });

    it('cannot edit or delete the audit log', async () => {
      await expect(asCompany(w.a.companyId, () => db.query(`UPDATE audit_log SET action = 'x'`))).rejects.toThrow(
        /permission denied/,
      );
      await expect(asCompany(w.a.companyId, () => db.query('DELETE FROM audit_log'))).rejects.toThrow(/permission denied/);
    });

    it('stops even the owner from editing the audit log', async () => {
      await expect(ownerQuery(`UPDATE audit_log SET action = 'x'`)).rejects.toThrow(/append-only/);
      await expect(ownerQuery('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
    });
  });
});
