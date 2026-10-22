import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { TopBar } from '../../components/TopBar';
import { Empty, Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { api } from '../../lib/api';
import { ago } from '../../lib/format';
import { useSession } from '../../state/session';
import { useInbox, useTapAction } from './hooks';
import { MessageView } from './MessageView';
import { QUERY_KEYS, type InboxMessage, type Prefs } from './types';
import './messages.css';

/** "Messages from <club>" switch for the active club (announcements only). */
function MuteSwitch({ clubId }: { clubId: string }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const prefs = useQuery({ queryKey: QUERY_KEYS.prefs(clubId), queryFn: () => api.get<Prefs>('/messages/prefs') });
  const save = useMutation({
    mutationFn: (promoMuted: boolean) => api.put<Prefs>('/messages/prefs', { promoMuted }),
    onSuccess: (data) => qc.setQueryData(QUERY_KEYS.prefs(clubId), data),
    onError: (err) => toast.error(err),
  });
  if (!prefs.data) return null;
  const on = !prefs.data.promoMuted;
  return (
    <div className="card tight stack">
      <div className="row-between">
        <strong>{t('inbox_mute_label', { club: prefs.data.clubName })}</strong>
        <button type="button" role="switch" aria-checked={on} className={`msg-switch ${on ? 'on' : ''}`}
          disabled={save.isPending} onClick={() => save.mutate(on)}>
          {on ? t('inbox_mute_on') : t('inbox_mute_off')}
        </button>
      </div>
      <span className="faint">{t('inbox_mute_hint')}</span>
    </div>
  );
}

/** #/me/inbox — my messages from every club, newest first, with unread dots. */
export function Inbox() {
  const t = useT();
  const qc = useQueryClient();
  const { user } = useSession();
  const inbox = useInbox();
  const tap = useTapAction();
  const [open, setOpen] = useState<InboxMessage | null>(null);
  // Unread dots stay for this visit; the server marks everything read once the list is shown.
  const unreadAtOpen = useRef<Set<string> | null>(null);
  const messages = inbox.data?.messages;

  useEffect(() => {
    if (!messages || unreadAtOpen.current) return;
    unreadAtOpen.current = new Set(messages.filter((m) => !m.read).map((m) => m.id));
    if (unreadAtOpen.current.size > 0) {
      void api.post('/messages/read-all').then(() => qc.invalidateQueries({ queryKey: QUERY_KEYS.inbox })).catch(() => undefined);
    }
  }, [messages, qc]);

  const isNew = (m: InboxMessage) => !m.read || Boolean(unreadAtOpen.current?.has(m.id));
  const newCount = messages?.filter(isNew).length ?? 0;

  return (
    <div className="screen">
      <TopBar />
      <div className="screen-body stack-lg msg-page">
        <div className="row-between">
          <h1>{t('inbox_title')}</h1>
          {newCount > 0 && <span className="badge open">{t('inbox_unread', { n: newCount })}</span>}
        </div>
        {user?.activeClubId && <MuteSwitch clubId={user.activeClubId} />}
        {inbox.isLoading && <Spinner />}
        {messages?.length === 0 && <Empty icon="✉" title={t('inbox_empty')}>{t('inbox_empty_sub')}</Empty>}
        <ul className="list msg-list">
          {messages?.map((m) => (
            <li key={m.id}>
              <button type="button" className="list-row msg-row" onClick={() => setOpen(m)}>
                <span className="avatar msg-avatar">{m.clubPhotoUrl ? <img src={m.clubPhotoUrl} alt="" /> : m.clubName.slice(0, 1).toUpperCase()}</span>
                <span className="grow msg-row-text">
                  <span className="row-between">
                    <strong className="truncate">{m.title ?? m.clubName}</strong>
                    <span className="faint">{ago(m.deliveredAt)}</span>
                  </span>
                  <span className="faint truncate" style={{ display: 'block' }}>
                    {m.title ? `${m.clubName} · ` : ''}{m.direct ? `${t('inbox_direct')} · ` : ''}{m.body}
                  </span>
                </span>
                {isNew(m) && <span className="msg-dot" aria-label={t('inbox_unread', { n: 1 })} />}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <Sheet open={Boolean(open)} onClose={() => setOpen(null)} title={open ? t('inbox_from', { club: open.clubName }) : ''}>
        {open && (
          <MessageView clubName={open.clubName} clubPhotoUrl={open.clubPhotoUrl} title={open.title} body={open.body}
            action={open.action} photoMessageId={open.hasPhoto ? open.id : null} when={open.deliveredAt} direct={open.direct}
            onAction={() => { const id = open.id; setOpen(null); void tap(id); }} />
        )}
      </Sheet>
    </div>
  );
}
