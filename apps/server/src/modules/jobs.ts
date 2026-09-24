import type { AppContext } from '../context.js';
import type { SocketExtension } from '../realtime/io.js';
import { closeExpiredBetting } from './game/hands.js';

/** Socket handlers contributed by modules (TV displays, …). */
export const socketExtensions: SocketExtension[] = [];

/** Registers a socket extension once (call at module top level). */
export function addSocketExtension(ext: SocketExtension): void {
  if (!socketExtensions.includes(ext)) socketExtensions.push(ext);
}

export interface Job {
  readonly name: string;
  readonly everyMs: number;
  run(ctx: AppContext): Promise<unknown>;
}

/** Background jobs. Modules append theirs (auto-deal, scheduled messages, renewals …). */
export const jobs: Job[] = [
  { name: 'close-expired-betting', everyMs: 1_000, run: closeExpiredBetting },
];

/** Adds or replaces a job by name (call at module top level). */
export function addJob(job: Job): void {
  const i = jobs.findIndex((j) => j.name === job.name);
  if (i >= 0) jobs.splice(i, 1, job);
  else jobs.push(job);
}

/** Starts every job on its own interval; a run never overlaps itself. Returns a stop function. */
export function startBackgroundJobs(ctx: AppContext): () => void {
  const timers = jobs.map((job) => {
    let running = false;
    return setInterval(() => {
      if (running) return;
      running = true;
      job.run(ctx)
        .catch((err: unknown) => ctx.logger.error(`Job ${job.name} failed`, err))
        .finally(() => { running = false; });
    }, job.everyMs);
  });
  return () => timers.forEach(clearInterval);
}
