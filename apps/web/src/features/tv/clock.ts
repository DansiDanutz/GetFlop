/** TVs often have a wrong clock: countdowns use the server time sent with every payload. */
export function clockOffset(serverNow: string | Date, receivedAt: number): number {
  const server = new Date(serverNow).getTime();
  return Number.isFinite(server) ? server - receivedAt : 0;
}

/** A server timestamp expressed on the local clock. */
export function toLocal(serverTime: string | Date | null | undefined, offsetMs: number): Date | null {
  if (!serverTime) return null;
  const ms = new Date(serverTime).getTime();
  return Number.isFinite(ms) ? new Date(ms - offsetMs) : null;
}

/** Seconds (rounded up) from now until a local time. */
export function secondsUntil(at: Date | null, now = Date.now()): number {
  return at ? Math.max(0, Math.ceil((at.getTime() - now) / 1000)) : 0;
}

/** m:ss for a number of seconds. */
export function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
