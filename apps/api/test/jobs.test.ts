import { forEachCompany, JobRunner } from '../src/common/jobs';
import { setupWorld, World } from './helpers';

/** Phase 2: one runner for the background jobs. */
describe('background jobs', () => {
  let w: World;
  beforeAll(async () => {
    w = await setupWorld();
  });
  afterAll(() => w.app.close());

  it('never runs a job twice at once, and another server skips a job this one is running', async () => {
    const url = process.env.TEST_DATABASE_URL ?? 'postgres://onpar_app:onpar_app_dev@localhost:5432/onpar_test';
    const a = new JobRunner(url);
    const b = new JobRunner(url);
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    let runs = 0;
    const work = async () => {
      runs++;
      await slow;
    };
    const first = a.run('Test job', work);
    await new Promise((r) => setTimeout(r, 200));
    expect(await a.run('Test job', work)).toBe(false); // still running here
    expect(await b.run('Test job', work)).toBe(false); // "another server" holds it
    release();
    expect(await first).toBe(true);
    expect(await b.run('Test job', async () => runs++)).toBe(true);
    expect(runs).toBe(2);
    a.stop();
    b.stop();
  });

  it('carries on with the other companies when one company fails', async () => {
    const done: string[] = [];
    await forEachCompany(w.app.get(require('../src/db/db.service').DbService), 'Test', async (id) => {
      if (id === w.a.companyId) throw new Error('broken');
      done.push(id);
    });
    expect(done).toContain(w.b.companyId);
  });
});
