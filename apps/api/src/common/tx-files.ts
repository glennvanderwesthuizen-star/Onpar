import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Files stored during a database step (phase 2). If the step is rolled back, the files it
 * stored are removed again, so a failed save never leaves a photo behind with no record.
 */
const store = new AsyncLocalStorage<{ undo: (() => Promise<void>)[] }>();

/** Runs `work` with its own list of things to undo on rollback. */
export function trackingFiles<T>(work: () => Promise<T>): { run: () => Promise<T>; undo: () => Promise<void> } {
  const ctx = { undo: [] as (() => Promise<void>)[] };
  return {
    run: () => store.run(ctx, work),
    undo: async () => {
      await Promise.all(ctx.undo.map((u) => u().catch(() => undefined)));
    },
  };
}

/** Called by storage after writing a file: within a database step, it is removed if that step fails. */
export function onRollback(undo: () => Promise<void>) {
  store.getStore()?.undo.push(undo);
}
