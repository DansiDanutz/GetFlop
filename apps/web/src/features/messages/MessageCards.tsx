import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { api } from '../../lib/api';
import { useSocketEvent } from '../../lib/socket';
import { useSession } from '../../state/session';
import { useMessagePhoto, useTapAction } from './hooks';
import { MessageView } from './MessageView';
import { QUERY_KEYS, type InboxMessage } from './types';
import './messages.css';

/** Screens where a full-screen club card must never appear. */
const NO_CARD_PREFIXES = ['/login', '/register', '/forgot-pin', '/tv', '/join', '/pc'];

function Card({ card, onDone }: { card: InboxMessage; onDone: () => void }) {
  const t = useT();
  const tap = useTapAction();
  const photo = useMessagePhoto(card.id);
  return createPortal(
    <div className="overlay msg-card-overlay" role="dialog" aria-modal="true" aria-label={card.title ?? card.clubName}>
      <div className="msg-card">
        <button type="button" className="icon-btn msg-card-close" aria-label={t('card_close')} onClick={onDone}>✕</button>
        {photo.isLoading ? <Spinner /> : (
          <MessageView clubName={card.clubName} clubPhotoUrl={card.clubPhotoUrl} title={card.title} body={card.body}
            action={card.action} photo={photo.data?.photo ?? null} when={card.deliveredAt} direct={card.direct}
            onAction={() => { onDone(); void tap(card.id); }} />
        )}
        <button type="button" className="btn ghost block" onClick={onDone}>{t('card_later')}</button>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Global overlay: club messages with a photo show once, full screen, in the club being used.
 * Mounted once in App.tsx.
 */
export function MessageCards() {
  const qc = useQueryClient();
  const { pathname } = useLocation();
  const { user } = useSession();
  const clubId = user?.activeClubId ?? null;
  const allowed = Boolean(user && clubId && !user.termsRequired) && !NO_CARD_PREFIXES.some((p) => pathname.startsWith(p));
  const cards = useQuery({
    queryKey: QUERY_KEYS.cards(clubId),
    queryFn: () => api.get<{ cards: InboxMessage[] }>('/messages/cards'),
    enabled: allowed,
    staleTime: 60_000,
  });
  useSocketEvent('message:new', (payload: { clubId?: string }) => {
    if (payload?.clubId === clubId) void qc.invalidateQueries({ queryKey: QUERY_KEYS.cards(clubId) });
  }, [qc, clubId]);

  const card = allowed ? cards.data?.cards[0] : undefined;
  if (!card) return null;

  function done(id: string) {
    qc.setQueryData<{ cards: InboxMessage[] }>(QUERY_KEYS.cards(clubId), (d) => (d ? { cards: d.cards.filter((c) => c.id !== id) } : d));
    void api.post(`/messages/${id}/card-shown`).catch(() => undefined)
      .finally(() => qc.invalidateQueries({ queryKey: QUERY_KEYS.inbox }));
  }
  return <Card key={card.id} card={card} onDone={() => done(card.id)} />;
}
