import { useT } from '../../i18n/i18n';
import { useSession } from '../../state/session';
import { StaffShell } from '../staff/StaffShell';
import { InviteBody } from './InviteSheet';
import './owner.css';

/** Invite players (#/club/invite): Club ID, QR, share and copy (03 §7). */
export function InvitePage() {
  const t = useT();
  const { context } = useSession();
  return (
    <StaffShell>
      <h1>{t('own_invite_title')}</h1>
      {context && <div className="card"><InviteBody clubId={context.club.id} /></div>}
    </StaffShell>
  );
}
