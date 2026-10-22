import { io, type Socket } from 'socket.io-client';
import { useEffect, useRef, useState } from 'react';

export type TvConnection = 'connecting' | 'live' | 'reconnecting';

/** Server events a TV reacts to (it refetches its payload on each). */
export const TV_EVENTS = [
  'hand:started', 'coupon:placed', 'hand:betting-closed', 'hand:flop-revealed', 'hand:settled', 'hand:cancelled',
  'table:updated', 'table:closed',
  'tournament:registered', 'tournament:unregistered', 'tournament:rebuy', 'tournament:addon', 'tournament:started',
  'tournament:cancelled', 'tournament:level:updated', 'tournament:player:busted', 'tournament:finished', 'tournament:chips:updated',
] as const;

export type TvEventHandler = (event: string, payload: unknown) => void;

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;

/**
 * A dedicated socket authenticated by the display token (not the user session).
 * It reconnects forever with a 1–10 s backoff, as a TV has nobody to press "retry".
 */
export function useTvSocket(token: string | null, onEvent: TvEventHandler, onRevoked: () => void): TvConnection {
  const [state, setState] = useState<TvConnection>('connecting');
  const handlers = useRef({ onEvent, onRevoked });
  handlers.current = { onEvent, onRevoked };

  useEffect(() => {
    if (!token) return undefined;
    const socket: Socket = io({
      path: '/socket.io', auth: { displayToken: token }, withCredentials: false,
      reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: RECONNECT_MIN_MS, reconnectionDelayMax: RECONNECT_MAX_MS,
    });
    socket.on('tv:ready', () => setState('live'));
    socket.on('disconnect', () => setState('reconnecting'));
    socket.on('connect_error', (err: Error) => {
      setState('reconnecting');
      // A refused token: refetch the payload, which answers 410 and shows the expired screen.
      if (err.message === 'tv.display_expired') handlers.current.onEvent('tv:auth-failed', null);
    });
    socket.on('tv:revoked', () => handlers.current.onRevoked());
    for (const event of TV_EVENTS) socket.on(event, (payload: unknown) => handlers.current.onEvent(event, payload));
    return () => { socket.disconnect(); };
  }, [token]);

  return state;
}
