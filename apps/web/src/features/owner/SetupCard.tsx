import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ConfirmSheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n/i18n';
import { useSession } from '../../state/session';
import { ownerApi, type Setup } from './api';
import { InviteSheet } from './InviteSheet';
import { setupNext, type SetupStep } from './logic';

/** Owner-only steps show "The owner does this" to others. */
const OWNER_STEPS = new Set(['level']);

/** "Go" for one setup step (03 §3). */
export function useSetupGo(clubId: string) {
  const navigate = useNavigate();
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { user, refresh } = useSession();
  const [dealConfirm, setDealConfirm] = useState(false);
  const [invite, setInvite] = useState(false);
  const go = (key: string) => {
    if (key === 'photo') navigate('/club/settings#profile');
    else if (key === 'table') navigate('/inspector');
    else if (key === 'dealer') setDealConfirm(true);
    else if (key === 'players') setInvite(true);
    else if (key === 'points') navigate('/club/members?filter=players');
    else if (key === 'level') navigate('/club/account');
  };
  async function dealMyself() {
    try {
      await ownerApi.grantRole(clubId, user?.id ?? '', 'dealer');
      setDealConfirm(false);
      toast.show(t('own_setup_dealer_done'), 'success');
      await refresh();
      await qc.invalidateQueries({ queryKey: ['owner'] });
    } catch (err) { toast.error(err); }
  }
  const sheets = (
    <>
      <ConfirmSheet open={dealConfirm} title={t('own_setup_deal_myself')} body={t('own_setup_deal_myself_body')}
        confirmLabel={t('own_setup_deal_myself_cta')} cancelLabel={t('cancel')} onCancel={() => setDealConfirm(false)} onConfirm={() => void dealMyself()} />
      <InviteSheet open={invite} onClose={() => setInvite(false)} clubId={clubId} />
    </>
  );
  return { go, sheets };
}

export function StepRow({ step, onGo, isOwner }: { step: SetupStep; onGo: () => void; isOwner: boolean }) {
  const t = useT();
  const ownerOnly = OWNER_STEPS.has(step.key) && !isOwner;
  return (
    <div className="own-step">
      <span className={`tick${step.done ? ' done' : ''}`} aria-hidden>{step.done ? '✓' : ''}</span>
      <span className="grow">
        <strong style={{ display: 'block' }}>{t(`own_step_${step.key}`)}{step.optional && <span className="faint"> · {t('own_optional')}</span>}</strong>
        <span className="own-note">{ownerOnly ? t('own_owner_does_this') : t(`own_step_${step.key}_hint`)}</span>
      </span>
      {!step.done && !ownerOnly && <button type="button" className="btn ghost" onClick={onGo}>{t('own_go')}</button>}
    </div>
  );
}

/** "Next step · n of total" with Skip / All steps (floor and Club tab). */
export function SetupCard({ clubId, setup }: { clubId: string; setup: Setup }) {
  const t = useT();
  const navigate = useNavigate();
  const { context } = useSession();
  const [skip, setSkip] = useState(0);
  const { go, sheets } = useSetupGo(clubId);
  const next = setupNext(setup.steps, skip);
  if (!next) return null;
  return (
    <section className="card stack">
      <div className="row-between">
        <span className="eyebrow">{t('own_next_step', { n: next.index, total: next.total })}</span>
        <span className="faint">{t('own_setup_progress', { done: setup.done, total: setup.total })}</span>
      </div>
      <StepRow step={next.step} onGo={() => go(next.step.key)} isOwner={Boolean(context?.roles.includes('owner'))} />
      <div className="row-between">
        <button type="button" className="btn link" onClick={() => setSkip((s) => s + 1)}>{t('own_skip')}</button>
        <button type="button" className="btn link" onClick={() => navigate('/club/setup')}>{t('own_all_steps')}</button>
      </div>
      {sheets}
    </section>
  );
}
