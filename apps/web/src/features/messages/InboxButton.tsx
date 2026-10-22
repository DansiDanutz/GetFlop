import { useNavigate } from 'react-router-dom';
import { useT } from '../../i18n/i18n';
import { useInboxUnread } from './hooks';
import './messages.css';

/** Envelope button with the unread count; other features can put it in their top bar. */
export function InboxButton() {
  const t = useT();
  const navigate = useNavigate();
  const unread = useInboxUnread();
  return (
    <button type="button" className="icon-btn msg-inbox-btn" aria-label={t('inbox_open')} onClick={() => navigate('/me/inbox')}>
      ✉{unread > 0 && <span className="msg-badge">{unread > 99 ? '99+' : unread}</span>}
    </button>
  );
}
