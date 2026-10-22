import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import { tvApi } from './api';
import { clockOffset } from './clock';
import { clearDisplay, saveDisplay } from './storage';
import type { CashTvData, TournamentTvData, TvKind } from './types';
import { useTvSocket, type TvConnection } from './useTvSocket';

/** The settle reveal plays before the totals refresh. */
export const REVEAL_REFRESH_MS = 1_100;
/** Safety net if an event was missed while reconnecting. */
const POLL_MS = 30_000;

export type DisplayEnd = 'expired' | 'revoked' | null;

interface Display<T> {
  readonly data: T | undefined;
  readonly error: unknown;
  readonly offsetMs: number;
  readonly connection: TvConnection;
  readonly reveal: string[] | null;
  readonly ended: DisplayEnd;
  readonly pairAgain: () => void;
}

type Payload<K extends TvKind> = K extends 'cash' ? CashTvData : TournamentTvData;

/** Loads a display payload, keeps it live over the TV socket and handles expiry / revocation. */
export function useTvDisplay<K extends TvKind>(kind: K, token: string): Display<Payload<K>> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [offsetMs, setOffsetMs] = useState(0);
  const [reveal, setReveal] = useState<string[] | null>(null);
  const [revoked, setRevoked] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryKey = ['tv', kind, token];

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const data = (kind === 'cash' ? await tvApi.cash(token) : await tvApi.tournament(token)) as Payload<K>;
      setOffsetMs(clockOffset(data.serverNow, Date.now()));
      saveDisplay(kind, { token, expiresAt: data.expiresAt });
      return data;
    },
    refetchInterval: POLL_MS,
    retry: (count, err) => !(err instanceof ApiError && err.status === 410) && count < 3,
  });

  const expired = query.error instanceof ApiError && query.error.status === 410;
  useEffect(() => { if (expired || revoked) clearDisplay(kind); }, [expired, revoked, kind]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // A burst of events (many coupons) must not keep cancelling the fetch in flight.
  const refetch = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
  }, [queryClient, kind, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const onEvent = useCallback((event: string, payload: unknown) => {
    if (event === 'hand:flop-revealed') {
      const p = payload as { card1?: string; card2?: string; card3?: string };
      if (p.card1 && p.card2 && p.card3) setReveal([p.card1, p.card2, p.card3]);
    }
    if (event === 'hand:flop-revealed' || event === 'hand:settled') {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { setReveal(null); refetch(); }, REVEAL_REFRESH_MS);
      return;
    }
    refetch();
  }, [refetch]);

  const connection = useTvSocket(expired || revoked ? null : token, onEvent, () => setRevoked(true));
  const pairAgain = useCallback(() => {
    clearDisplay(kind);
    navigate(`/tv/${kind}`, { replace: true });
  }, [kind, navigate]);

  return {
    data: query.data, error: query.error, offsetMs, connection, reveal,
    ended: revoked ? 'revoked' : expired ? 'expired' : null, pairAgain,
  };
}
