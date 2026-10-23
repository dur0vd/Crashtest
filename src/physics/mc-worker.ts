/// <reference lib="webworker" />
/**
 * Browser Web Worker entry for Monte Carlo. No DOM access: it imports only the
 * pure model registry. Messages: {type:'run', spec} -> {type:'progress'} and
 * {type:'result'|'error'}. Cancellation: the client terminates the worker.
 */
import { type MonteCarloSpec, runMonteCarlo } from './montecarlo';

export type WorkerRequest = { type: 'run'; spec: MonteCarloSpec };
export type WorkerReply =
  | { type: 'progress'; completed: number; total: number }
  | { type: 'result'; result: Awaited<ReturnType<typeof runMonteCarlo>> }
  | { type: 'error'; message: string };

/** Testable message handler; the worker binds it to self.postMessage. */
export async function handleMonteCarloMessage(data: WorkerRequest, post: (reply: WorkerReply) => void): Promise<void> {
  if (!data || data.type !== 'run') { post({ type: 'error', message: 'Неизвестное сообщение' }); return; }
  try {
    const result = await runMonteCarlo(data.spec, { yieldEvery: 100, onProgress: (completed, total) => post({ type: 'progress', completed, total }) });
    post({ type: 'result', result });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

const scope = globalThis as unknown as { WorkerGlobalScope?: unknown; onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null; postMessage(m: WorkerReply): void };
if (typeof scope.WorkerGlobalScope !== 'undefined') {
  scope.onmessage = e => { void handleMonteCarloMessage(e.data, m => scope.postMessage(m)); };
}
