import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from '../../components/Toast';
import { Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { api, ApiError } from '../../lib/api';
import { errorMessage } from '../../i18n/i18n';
import { INSP } from './api';
import { StaffFrame } from './StaffFrame';

interface SimOverview {
  budget: { tripped: boolean; trippedAt: string | null; reason: 'picks' | 'database' | null; picks: number; maxPicks: number; dbBytes: number | null; maxBytes: number };
  tables: { id: string; name: string; status: string; intervalSeconds: number; lastHandNumber: number; liveHand: { handNumber: number; status: string } | null }[];
}

const MB = 1024 * 1024;

/** Simulation club: budget guard and auto-deal tables with manual steps (07 §7). */
export function Simulation() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({ queryKey: [INSP, 'simulation'], queryFn: () => api.get<SimOverview>('/inspector/simulation'), retry: false });

  async function step(tableId: string) {
    setBusy(tableId);
    try {
      await api.post(`/player/table/${tableId}/sim-step`);
      await qc.invalidateQueries({ queryKey: [INSP] });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  const b = q.data?.budget;
  return (
    <StaffFrame>
      <h1>{t('insp_sim_title')}</h1>
      {q.isLoading && <Spinner />}
      {q.error instanceof ApiError && <div className="banner danger">{errorMessage(q.error.code, q.error.params)}</div>}
      {b && (
        <section className={`banner ${b.tripped ? 'danger' : 'ok'}`}>
          {b.tripped ? t('insp_alert_sim_budget') : t('insp_sim_budget_ok')}
          <div className="insp-sub">{t('insp_sim_picks', { n: b.picks.toLocaleString(), max: b.maxPicks.toLocaleString() })}</div>
          {b.dbBytes !== null && <div className="insp-sub">{t('insp_sim_db', { mb: Math.round(b.dbBytes / MB), max: Math.round(b.maxBytes / MB) })}</div>}
        </section>
      )}
      <div className="card tight list">
        {(q.data?.tables ?? []).map((tb) => (
          <div key={tb.id} className="list-row">
            <span className="grow insp-rowtext">
              <strong>{tb.name}</strong>
              <span className="muted insp-sub">{t('insp_sim_every', { n: tb.intervalSeconds })} · {tb.liveHand ? t('insp_hand_n', { n: tb.liveHand.handNumber }) : t('insp_hands_n', { n: tb.lastHandNumber })}</span>
            </span>
            <button type="button" className="btn ghost" disabled={busy === tb.id || b?.tripped} onClick={() => void step(tb.id)}>
              {t(tb.liveHand ? 'insp_sim_deal' : 'insp_sim_new_hand')}
            </button>
          </div>
        ))}
      </div>
    </StaffFrame>
  );
}
