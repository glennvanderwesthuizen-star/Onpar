import { Logger } from '@nestjs/common';
import { Client } from 'pg';

/**
 * Runs the server's background jobs (optimisation review, phase 2). Every job:
 * - never overlaps itself: a slow run is not started again before it ends;
 * - runs on one server only: a database lock per job, so a second server later does not
 *   run every job twice (the other server simply skips that turn);
 * - logs the same way, and says when a run was slow.
 */
export class JobRunner {
  private readonly log = new Logger('Jobs');
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<string>();
  private lockClient: Client | null = null;
  private stopped = false;

  constructor(private readonly databaseUrl: string | null) {}

  /** Runs `work` every `everyMs`, and once straight away when `now` is set. */
  every(name: string, everyMs: number, work: () => Promise<unknown>, opts: { now?: boolean } = {}) {
    const tick = () => void this.run(name, work);
    if (opts.now) tick();
    this.timers.push(setInterval(tick, everyMs));
  }

  /** One run of a job. Returns false when it was skipped (already running, or another server has it). */
  async run(name: string, work: () => Promise<unknown>): Promise<boolean> {
    if (this.stopped || this.running.has(name)) return false;
    this.running.add(name);
    let locked = false;
    try {
      locked = await this.lock(name);
      if (!locked) return false;
      const started = Date.now();
      await work();
      const took = Date.now() - started;
      if (took > 30_000) this.log.warn(`${name} took ${Math.round(took / 1000)} s.`);
      return true;
    } catch (e) {
      this.log.error(`${name} failed: ${(e as Error).message}`);
      return true;
    } finally {
      if (locked) await this.unlock(name);
      this.running.delete(name);
    }
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    void this.lockClient?.end().catch(() => undefined);
  }

  /** One connection holds the locks for all jobs, so jobs never use up the app's own connections. */
  private async lock(name: string): Promise<boolean> {
    if (!this.databaseUrl) return true;
    try {
      if (!this.lockClient) {
        const c = new Client({ connectionString: this.databaseUrl });
        c.on('error', () => (this.lockClient = null));
        await c.connect();
        this.lockClient = c;
      }
      const r = await this.lockClient.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [`onpar-job:${name}`]);
      return r.rows[0].ok === true;
    } catch (e) {
      // Without the lock connection the job still runs: one server is the normal case.
      this.log.warn(`Could not take the lock for ${name}: ${(e as Error).message}`);
      this.lockClient = null;
      return true;
    }
  }

  private async unlock(name: string) {
    await this.lockClient?.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`onpar-job:${name}`]).catch(() => undefined);
  }
}

/**
 * Runs `work` for every company, each on its own: one company's error is logged and the
 * companies after it still run (phase 2; before, the first error stopped the whole run).
 */
export async function forEachCompany(
  db: { query<T extends object>(sql: string, params?: unknown[]): Promise<T[]> },
  job: string,
  work: (companyId: string) => Promise<unknown>,
): Promise<void> {
  const companies = await db.query<{ scheduler_company_ids: string }>('SELECT * FROM scheduler_company_ids()');
  for (const { scheduler_company_ids: companyId } of companies) {
    try {
      await work(companyId);
    } catch (e) {
      new Logger('Jobs').error(`${job} failed for company ${companyId}: ${(e as Error).message}`);
    }
  }
}
