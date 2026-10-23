import type { MonteCarloResult, MonteCarloSpec } from './montecarlo';
import type { WorkerReply } from './mc-worker';

/**
 * Runs Monte Carlo in a module Web Worker (browser only). cancel() terminates
 * the worker and resolves with status 'cancelled' and the last progress.
 */
export function runMonteCarloInWorker(spec: MonteCarloSpec, onProgress?: (completed: number, total: number) => void): { promise: Promise<MonteCarloResult | { status: 'cancelled'; completed: number }>; cancel(): void } {
  const worker = new Worker(new URL('./mc-worker.ts', import.meta.url), { type: 'module' });
  let completed = 0;
  let settle: (v: MonteCarloResult | { status: 'cancelled'; completed: number }) => void = () => {};
  const promise = new Promise<MonteCarloResult | { status: 'cancelled'; completed: number }>((resolve, reject) => {
    settle = resolve;
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const m = e.data;
      if (m.type === 'progress') { completed = m.completed; onProgress?.(m.completed, m.total); }
      else if (m.type === 'result') { worker.terminate(); resolve(m.result); }
      else { worker.terminate(); reject(new Error(m.message)); }
    };
    worker.onerror = e => { worker.terminate(); reject(new Error(e.message)); };
  });
  worker.postMessage({ type: 'run', spec });
  return { promise, cancel: () => { worker.terminate(); settle({ status: 'cancelled', completed }); } };
}
