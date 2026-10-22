import { useQuery } from '@tanstack/react-query';
import { Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { useSession } from '../../state/session';
import { StaffShell } from '../staff/StaffShell';
import { ownerApi } from './api';
import { StepRow, useSetupGo } from './SetupCard';
import './owner.css';

/** Every first step with its "Go" (#/club/setup, 03 §3). */
export function SetupPage() {
  const t = useT();
  const { context } = useSession();
  const clubId = context?.club.id ?? '';
  const setup = useQuery({ queryKey: ['owner', 'setup', clubId], queryFn: () => ownerApi.setup(clubId), enabled: Boolean(clubId) });
  const { go, sheets } = useSetupGo(clubId);
  const data = setup.data?.setup;
  return (
    <StaffShell dots={{ club: data ? !data.complete : false }}>
      <h1>{t('own_setup_title')}</h1>
      {setup.isLoading && <Spinner />}
      {data && (
        <>
          <p className="muted">{data.complete ? t('own_setup_complete') : t('own_setup_progress', { done: data.done, total: data.total })}</p>
          <div className="card">
            {data.steps.map((s) => <StepRow key={s.key} step={s} onGo={() => go(s.key)} isOwner={Boolean(context?.roles.includes('owner'))} />)}
          </div>
        </>
      )}
      {sheets}
    </StaffShell>
  );
}
