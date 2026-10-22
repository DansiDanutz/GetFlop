import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n/i18n';
import { ApiError } from '../../lib/api';
import { amount } from '../../lib/format';
import { placeCoupon, playerKeys } from './data';
import {
  clampRounds, DEFAULT_ROUNDS, playAgain, setPickStake, setSharedAmount, togglePick, type SlipPick,
} from './slip';
import type { TableView } from './types';

const HAPTIC_MS = 30;

export interface ServerError { code: string; params: Record<string, string | number> }

export interface Slip {
  readonly picks: readonly SlipPick[];
  readonly sharedCents: number;
  readonly rounds: number;
  readonly serverError: ServerError | null;
  readonly busy: boolean;
  toggle(slug: string): void;
  setShared(cents: number): void;
  setStake(slug: string, cents: number): void;
  setRounds(rounds: number): void;
  clear(): void;
  /** Loads a finished coupon's picks; returns false when nothing fits this table. */
  loadPlayAgain(picks: readonly SlipPick[], rounds: number): boolean;
  place(): Promise<boolean>;
}

/** Slip state for one table. Every change clears the last server error. */
export function useSlip(table: TableView | undefined): Slip {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const minCents = table?.limits.minCents ?? 100;
  const [picks, setPicks] = useState<readonly SlipPick[]>([]);
  const [sharedCents, setSharedCents] = useState(minCents);
  const [rounds, setRoundsState] = useState(DEFAULT_ROUNDS);
  const [serverError, setServerError] = useState<ServerError | null>(null);
  const [busy, setBusy] = useState(false);

  const edit = useCallback((fn: () => void) => { setServerError(null); fn(); }, []);

  const toggle = (slug: string) => table && edit(() => setPicks((p) => togglePick(p, slug, sharedCents, table.limits)));
  const setShared = (cents: number) => table && edit(() => {
    setSharedCents(cents);
    setPicks((p) => setSharedAmount(p, cents, table.limits));
  });
  const setStake = (slug: string, cents: number) => table && edit(() => setPicks((p) => setPickStake(p, slug, cents, table.limits)));
  const setRounds = (n: number) => table && edit(() => setRoundsState(clampRounds(n, table.limits.maxRounds)));
  const clear = () => edit(() => setPicks([]));

  const loadPlayAgain = (from: readonly SlipPick[], fromRounds: number): boolean => {
    if (!table) return false;
    const result = playAgain(from, fromRounds, table);
    if (result.empty) {
      toast.show(t('player_again_nothing_fits'), 'error');
      return false;
    }
    edit(() => {
      setPicks(result.picks);
      setRoundsState(result.rounds);
      setSharedCents(result.picks[0]?.stakeCents ?? minCents);
    });
    if (result.dropped > 0) toast.show(t('player_again_dropped', { n: result.dropped }));
    if (result.adjusted > 0) toast.show(t('player_again_adjusted', { n: result.adjusted }));
    if (result.roundsClamped) toast.show(t('player_again_rounds', { n: result.rounds }));
    return true;
  };

  const place = async (): Promise<boolean> => {
    if (!table || picks.length === 0) return false;
    setBusy(true);
    try {
      const res = await placeCoupon(table.id, picks, rounds);
      navigator.vibrate?.(HAPTIC_MS);
      toast.show(t('player_toast_placed', {
        total: amount(res.totalCommitmentCents, res.unit), n: res.rounds, balance: amount(res.balanceCents, res.unit),
      }), 'success');
      setPicks([]);
      setRoundsState(DEFAULT_ROUNDS);
      setServerError(null);
      void qc.invalidateQueries({ queryKey: playerKeys.couponsAll });
      void qc.invalidateQueries({ queryKey: playerKeys.table(table.id) });
      void qc.invalidateQueries({ queryKey: playerKeys.stats(table.id) });
      void qc.invalidateQueries({ queryKey: playerKeys.balance });
      return true;
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'generic';
      setServerError({ code, params: err instanceof ApiError ? err.params : {} });
      toast.error(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { picks, sharedCents, rounds, serverError, busy, toggle, setShared, setStake, setRounds, clear, loadPlayAgain, place };
}
