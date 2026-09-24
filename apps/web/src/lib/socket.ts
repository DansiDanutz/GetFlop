import { io, type Socket } from 'socket.io-client';
import { useEffect } from 'react';

let socket: Socket | null = null;
const joinedTables = new Set<string>();
type StatusListener = (status: 'connected' | 'reconnecting' | 'disconnected') => void;
const statusListeners = new Set<StatusListener>();

/** One shared connection, authenticated by the session cookie. */
export function getSocket(): Socket {
  if (socket) return socket;
  socket = io({ path: '/socket.io', withCredentials: true, reconnectionAttempts: 20, reconnectionDelay: 1_000, reconnectionDelayMax: 5_000 });
  socket.on('connect', () => {
    for (const id of joinedTables) socket?.emit('join-table', id);
    statusListeners.forEach((l) => l('connected'));
  });
  socket.io.on('reconnect_attempt', () => statusListeners.forEach((l) => l('reconnecting')));
  socket.on('disconnect', () => statusListeners.forEach((l) => l('disconnected')));
  return socket;
}

export function closeSocket(): void {
  socket?.disconnect();
  socket = null;
  joinedTables.clear();
}

export function onSocketStatus(fn: StatusListener): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

/** Subscribes to a server event for the lifetime of the component. */
export function useSocketEvent<T = unknown>(event: string, handler: (payload: T) => void, deps: unknown[] = []): void {
  useEffect(() => {
    const s = getSocket();
    const fn = (payload: T) => handler(payload);
    s.on(event, fn);
    return () => { s.off(event, fn); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, ...deps]);
}

/** Joins a table room while mounted (re-joined automatically after reconnects). */
export function useTableRoom(tableId: string | null | undefined): void {
  useEffect(() => {
    if (!tableId) return;
    const s = getSocket();
    joinedTables.add(tableId);
    s.emit('join-table', tableId);
    return () => {
      joinedTables.delete(tableId);
      s.emit('leave-table', tableId);
    };
  }, [tableId]);
}
