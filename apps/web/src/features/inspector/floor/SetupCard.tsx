import { useNavigate } from 'react-router-dom';
import { useT } from '../../../i18n/i18n';
import { useSession } from '../../../state/session';
import { useSetup } from '../api';

const GO: Record<string, string> = {
  photo: '/club/settings',
  table: '/club/tables',
  dealer: '/club/members',
  players: '/club/settings',
  points: '/club/members?filter=players',
  level: '/club/account',
};

/** "Next step" of the club setup (owner, manager). Hidden on error or when setup is complete. */
export function SetupCard() {
  const t = useT();
  const navigate = useNavigate();
  const { context, can } = useSession();
  const setup = useSetup(context?.club.id, can('settings'));
  if (!setup.data || setup.isError) return null;
  const next = setup.data.steps.find((s) => !s.done && !s.optional);
  if (!next) return null;
  const done = setup.data.steps.filter((s) => s.done && !s.optional).length;
  const required = setup.data.steps.filter((s) => !s.optional).length;
  return (
    <div className="card insp-setup">
      <span className="eyebrow">{t('insp_setup_next', { k: done, n: required })}</span>
      <strong>{t(`insp_setup_${next.key}`)}</strong>
      <button type="button" className="btn primary" onClick={() => navigate(GO[next.key] ?? '/club/settings')}>{t('insp_setup_go')}</button>
    </div>
  );
}
