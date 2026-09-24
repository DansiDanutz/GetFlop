import type { Server as HttpServer } from 'node:http';
import { parse as parseCookie } from 'node:querystring';
import { Server } from 'socket.io';
import type { AppContext } from '../context.js';
import { SESSION_COOKIE, userFromToken } from '../modules/auth/session.js';
import { loadClubAccess } from '../modules/clubs/access.js';
import { rooms, type Events } from './events.js';

/** Extra socket handlers a module can register (e.g. TV display auth). */
export type SocketExtension = (io: Server, ctx: AppContext) => void;

export class SocketEvents implements Events {
  private io?: Server;
  attach(io: Server): void {
    this.io = io;
  }
  emit(room: string, event: string, payload: unknown): void {
    this.io?.to(room).emit(event, payload);
  }
}

function cookieToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const pairs = parseCookie(header.replace(/;\s*/g, '&'));
  const value = pairs[SESSION_COOKIE];
  return typeof value === 'string' ? decodeURIComponent(value) : undefined;
}

/**
 * Socket.io server. A signed-in user joins user:<id> and, for every active
 * membership, club:<id> (plus staff:<id> for staff). Clients then join tables
 * with `join-table` / `leave-table`.
 */
export function createIo(http: HttpServer, ctx: AppContext, extensions: SocketExtension[] = []): Server {
  const io = new Server(http, { cors: { origin: ctx.config.webOrigin, credentials: true }, path: '/socket.io' });

  io.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth as { token?: string; displayToken?: string };
      if (auth.displayToken) return next(); // TV displays authenticate in the TV module.
      const token = auth.token ?? cookieToken(socket.handshake.headers.cookie);
      const user = await userFromToken(ctx, token);
      if (!user) return next(new Error('auth.required'));
      socket.data.user = user;
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user as { id: string; activeClubId: string | null } | undefined;
    if (!user) return;
    void socket.join(rooms.user(user.id));
    if (user.activeClubId) void joinClub(user.activeClubId);

    async function joinClub(clubId: string): Promise<void> {
      try {
        const access = await loadClubAccess(ctx.db, socket.data.user, clubId);
        if (!access.membership && !access.isAdmin) return;
        await socket.join(rooms.club(clubId));
        if (access.rank >= 2 || access.isAdmin) await socket.join(rooms.staff(clubId));
      } catch {
        // Unknown club: ignore.
      }
    }

    socket.on('join-club', (clubId: unknown) => { if (typeof clubId === 'string') void joinClub(clubId); });
    socket.on('join-table', (tableId: unknown) => { if (typeof tableId === 'string') void socket.join(rooms.table(tableId)); });
    socket.on('leave-table', (tableId: unknown) => { if (typeof tableId === 'string') void socket.leave(rooms.table(tableId)); });
  });

  for (const extend of extensions) extend(io, ctx);
  return io;
}
