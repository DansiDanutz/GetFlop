import type { SocketExtension } from '../../realtime/io.js';

interface Presence {
  readonly userId: string;
  readonly tables: ReadonlySet<string>;
}

/** Connected app sockets (not TV displays), keyed by socket id. Process-local. */
const connected = new Map<string, Presence>();

function update(socketId: string, fn: (p: Presence) => Presence): void {
  const current = connected.get(socketId);
  if (current) connected.set(socketId, fn(current));
}

/** Tracks who is connected and which table rooms each socket follows. */
export const presenceExtension: SocketExtension = (io) => {
  io.on('connection', (socket) => {
    const user = socket.data.user as { id: string } | undefined;
    if (!user) return;
    connected.set(socket.id, { userId: user.id, tables: new Set() });
    socket.on('join-table', (tableId: unknown) => {
      if (typeof tableId === 'string') update(socket.id, (p) => ({ ...p, tables: new Set([...p.tables, tableId]) }));
    });
    socket.on('leave-table', (tableId: unknown) => {
      update(socket.id, (p) => ({ ...p, tables: new Set([...p.tables].filter((t) => t !== tableId)) }));
    });
    socket.on('disconnect', () => { connected.delete(socket.id); });
  });
};

export interface PresenceSnapshot {
  readonly connections: number;
  readonly users: number;
  readonly atTables: number;
  readonly lobby: number;
  readonly byTable: ReadonlyArray<{ tableId: string; users: number }>;
}

/** Who is online now: people (not sockets) at tables versus browsing. */
export function presenceSnapshot(): PresenceSnapshot {
  const all = [...connected.values()];
  const users = new Set(all.map((p) => p.userId));
  const tableUsers = new Map<string, Set<string>>();
  for (const p of all) {
    for (const t of p.tables) tableUsers.set(t, new Set([...(tableUsers.get(t) ?? []), p.userId]));
  }
  const atTables = new Set(all.filter((p) => p.tables.size > 0).map((p) => p.userId));
  return {
    connections: all.length,
    users: users.size,
    atTables: atTables.size,
    lobby: users.size - atTables.size,
    byTable: [...tableUsers].map(([tableId, set]) => ({ tableId, users: set.size })).sort((a, b) => b.users - a.users),
  };
}
