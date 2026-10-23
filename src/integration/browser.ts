/** Browser-only executors for the integrated ports (not imported by the CLI). */
import type { MonteCarloRunner } from '../physics/port';
import { runMonteCarloInWorker } from '../physics/mc-client';

/** Monte Carlo in a module Web Worker; the same seeded generator as in-process runs. */
export const workerMonteCarlo: MonteCarloRunner = (spec, control) => {
  const job = runMonteCarloInWorker(spec, control?.onProgress);
  const timer = setInterval(() => { if (control?.isCancelled?.()) job.cancel(); }, 50);
  return job.promise.finally(() => clearInterval(timer)).then(result => {
    if (!('n' in result)) throw Object.assign(new Error('Отменено'), { name: 'AbortError' });
    return result;
  });
};
