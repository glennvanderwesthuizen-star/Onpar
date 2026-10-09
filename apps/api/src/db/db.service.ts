import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { CONFIG, Config } from '../config';
import { trackingFiles } from '../common/tx-files';

// Return DATE columns as 'YYYY-MM-DD' strings, not JS Dates shifted by time zone.
import { types } from 'pg';
types.setTypeParser(1082, (v) => v);

export type Tx = PoolClient;

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(CONFIG) config: Config) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  }

  /**
   * Runs `fn` in a transaction acting for one company. Row-level security in
   * the database limits every query to that company's rows.
   */
  async withTenant<T>(companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const files = trackingFiles(async () => {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.company_id', $1, true)`, [companyId]);
      await client.query(`SET LOCAL TIME ZONE 'Africa/Johannesburg'`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    });
    try {
      return await files.run();
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      // Photos stored during this step are removed again: no file without its record.
      await files.undo();
      throw e;
    } finally {
      client.release();
    }
  }

  /** For the few lookups that happen before the company is known (login). */
  async query<T extends object>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pool.query(sql, params);
    return r.rows as T[];
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
