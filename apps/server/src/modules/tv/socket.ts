import type { Server, Socket } from 'socket.io';
import type { AppContext } from '../../context.js';
import type { TvKind } from '../../db/schema/index.js';
import { rooms } from '../../realtime/events.js';
import type { SocketExtension } from '../../realtime/io.js';
import { MAX_TIMER_MS } from './constants.js';
import { activeSession } from './service.js';
import { tournamentTvSource } from './tournamentSource.js';

export interface TvSocketData {
  readonly sessionId: string;
  readonly kind: TvKind;
  readonly targetId: string;
  readonly expiresAt: Date;
}

/** Socket server per app context, so the service can disconnect revoked TVs. */
const servers = new WeakMap<AppContext, Server>();

export const tournamentRoom = (id: string): string => `tournament:${id}`;

export function disconnectTv(ctx: AppContext, sessionId: string): void {
  servers.get(ctx)?.in(rooms.tv(sessionId)).disconnectSockets(true);
}

async function roomsFor(ctx: AppContext, tv: TvSocketData): Promise<string[]> {
  if (tv.kind === 'cash') return [rooms.tv(tv.sessionId), rooms.table(tv.targetId)];
  const info = await tournamentTvSource().find(ctx.db, tv.targetId).catch(() => null);
  return [rooms.tv(tv.sessionId), tournamentRoom(tv.targetId), ...(info?.tableId ? [rooms.table(info.tableId)] : [])];
}

async function onTvConnection(ctx: AppContext, socket: Socket, tv: TvSocketData): Promise<void> {
  await Promise.all((await roomsFor(ctx, tv)).map((room) => socket.join(room)));
  const ms = Math.min(MAX_TIMER_MS, Math.max(0, tv.expiresAt.getTime() - ctx.now().getTime()));
  const timer = setTimeout(() => socket.disconnect(true), ms);
  timer.unref?.();
  socket.on('disconnect', () => clearTimeout(timer));
  socket.emit('tv:ready', { sessionId: tv.sessionId, kind: tv.kind, targetId: tv.targetId, expiresAt: tv.expiresAt });
}

/**
 * TV display sockets: `io({ auth: { displayToken } })`. The core socket middleware lets these
 * through without a user; here the token is checked and the socket joins only tv:<session>
 * and the room of the table (or tournament) it shows.
 */
export const tvSocketExtension: SocketExtension = (io, ctx) => {
  servers.set(ctx, io);
  io.use((socket, next) => {
    const { displayToken } = socket.handshake.auth as { displayToken?: unknown };
    if (displayToken === undefined) return next();
    void (async () => {
      const session = typeof displayToken === 'string' ? await activeSession(ctx, displayToken) : null;
      if (!session) return next(new Error('tv.display_expired'));
      const tv: TvSocketData = { sessionId: session.id, kind: session.kind, targetId: session.targetId, expiresAt: session.expiresAt };
      socket.data.tv = tv;
      next();
    })().catch((err: unknown) => {
      ctx.logger.error('TV socket auth failed', err);
      next(new Error('server.error'));
    });
  });
  io.on('connection', (socket) => {
    const tv = socket.data.tv as TvSocketData | undefined;
    if (!tv) return;
    onTvConnection(ctx, socket, tv).catch((err: unknown) => {
      ctx.logger.error('TV socket join failed', err);
      socket.disconnect(true);
    });
  });
};
