import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { Segmented } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { api, qs } from '../../lib/api';
import { useSocketEvent } from '../../lib/socket';
import { useSession } from '../../state/session';
import { StaffShell } from '../staff/StaffShell';
import { Composer } from './Composer';
import { browserTz, draftFromSuggestion, emptyDraft, type Draft } from './logic';
import { SentList } from './SentList';
import { Suggestions } from './Suggestions';
import { QUERY_KEYS, type Audience, type Suggestion, type Targets } from './types';
import './messages.css';

/** Free-messaging period end (08 §6): shown as a banner until then. */
const FREE_UNTIL = new Date('2026-11-30T22:00:00Z');

/** #/club/messages — owner and managers write; other staff see the read-only log. */
export function ClubMessages() {
  const t = useT();
  const qc = useQueryClient();
  const { context, can } = useSession();
  const clubId = context?.club.id ?? null;
  const canWrite = can('messages');
  const [tab, setTab] = useState<'new' | 'sent'>(canWrite ? 'new' : 'sent');
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(new Date()));
  const onDraft = useCallback((update: (d: Draft) => Draft) => setDraft((d) => update(d)), []);

  const audiences = useQuery({
    queryKey: QUERY_KEYS.audiences(clubId),
    queryFn: () => api.get<{ audiences: Audience[] }>(`/messages/audiences${qs({ tz: browserTz() })}`),
    enabled: canWrite,
  });
  const targets = useQuery({
    queryKey: QUERY_KEYS.targets(clubId),
    queryFn: () => api.get<Targets>('/messages/targets'),
    enabled: canWrite,
  });
  useSocketEvent('floor:changed', () => { void qc.invalidateQueries({ queryKey: QUERY_KEYS.targets(clubId) }); }, [qc, clubId]);

  function applySuggestion(s: Suggestion) {
    setDraft((d) => draftFromSuggestion(d, s, t));
    setTab('new');
    window.scrollTo?.({ top: 0, behavior: 'smooth' });
  }

  return (
    <StaffShell>
      <div className="stack-lg msg-page">
        <div className="stack">
          <h1>{t('msg_title')}</h1>
          <span className="faint">{t('msg_from_club')}</span>
          {new Date() < FREE_UNTIL && <div className="banner ok">{t('msg_free_until')}</div>}
        </div>
        {canWrite ? (
          <Segmented value={tab} onChange={setTab} options={[{ value: 'new', label: t('msg_tab_new') }, { value: 'sent', label: t('msg_tab_sent') }]} />
        ) : <div className="banner">{t('msg_read_only')}</div>}
        {tab === 'new' && canWrite && (
          <>
            <Suggestions clubId={clubId} onUse={applySuggestion} />
            <Composer draft={draft} onDraft={onDraft} audiences={audiences.data?.audiences} targets={targets.data} clubName={context?.club.name ?? ''} />
          </>
        )}
        {tab === 'sent' && <SentList clubId={clubId} />}
      </div>
    </StaffShell>
  );
}
