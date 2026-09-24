import type { AppContext } from '../context.js';
import type { SocketExtension } from '../realtime/io.js';

/** Socket handlers contributed by modules (TV displays, …). */
export const socketExtensions: SocketExtension[] = [];

/** Background timers (auto-deal, picks countdown, scheduled messages, renewals). Returns a stop function. */
export function startBackgroundJobs(_ctx: AppContext): () => void {
  const timers: NodeJS.Timeout[] = [];
  return () => timers.forEach(clearInterval);
}
