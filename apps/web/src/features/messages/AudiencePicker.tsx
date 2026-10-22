import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { api, qs } from '../../lib/api';
import { AUDIENCE_KEYS, type Audience, type AudienceChoice, type PlayerOption } from './types';

const SEARCH_DEBOUNCE_MS = 250;

interface AudiencePickerProps {
  value: AudienceChoice;
  recipient: PlayerOption | null;
  audiences: readonly Audience[] | undefined;
  onChange: (audience: AudienceChoice, recipient: PlayerOption | null) => void;
}

function MemberSearch({ onPick }: { onPick: (p: PlayerOption) => void }) {
  const t = useT();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const players = useQuery({
    queryKey: ['messages', 'players', q],
    queryFn: () => api.get<{ players: PlayerOption[] }>(`/messages/players${qs({ q })}`),
  });
  return (
    <div className="stack">
      <input aria-label={t('msg_search_member')} placeholder={t('msg_search_member')} value={text} onChange={(e) => setText(e.target.value)} />
      {players.isLoading && <Spinner />}
      {players.data?.players.length === 0 && <p className="faint">{t('msg_no_members_found')}</p>}
      <div className="list msg-member-list">
        {players.data?.players.map((p) => (
          <button key={p.userId} type="button" className="list-row msg-member" onClick={() => onPick(p)}>
            <span className="avatar msg-avatar">{p.displayName.slice(0, 1).toUpperCase()}</span>
            <span className="grow" style={{ textAlign: 'left' }}>
              <strong style={{ display: 'block' }}>{p.displayName}</strong>
              <span className="faint">@{p.username}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** "To": every audience with its live count; empty groups are disabled. */
export function AudiencePicker({ value, recipient, audiences, onChange }: AudiencePickerProps) {
  const t = useT();
  const count = (key: AudienceChoice) => audiences?.find((a) => a.key === key);
  const options: AudienceChoice[] = [...AUDIENCE_KEYS, 'member'];
  return (
    <fieldset className="stack msg-fieldset">
      <legend className="eyebrow">{t('msg_to')}</legend>
      <div className="msg-audiences" role="radiogroup" aria-label={t('msg_to')}>
        {options.map((key) => {
          const a = count(key);
          const empty = key !== 'member' && a !== undefined && a.total === 0;
          return (
            <button key={key} type="button" role="radio" aria-checked={value === key} disabled={empty}
              className={`msg-audience ${value === key ? 'on' : ''}`} onClick={() => onChange(key, null)}>
              <span className="grow" style={{ textAlign: 'left' }}>
                <strong style={{ display: 'block' }}>{t(`msg_aud_${key}`)}</strong>
                <span className="faint">{empty ? t('msg_aud_empty') : t(`msg_aud_hint_${key}`)}</span>
              </span>
              {a && key !== 'member' && <span className="pill">{t('msg_aud_count', { n: a.total })}</span>}
            </button>
          );
        })}
      </div>
      {value === 'member' && (recipient ? (
        <div className="row-between card tight">
          <span><strong>{recipient.displayName}</strong> <span className="faint">@{recipient.username}</span></span>
          <button type="button" className="btn link" onClick={() => onChange('member', null)}>{t('msg_change_member')}</button>
        </div>
      ) : <MemberSearch onPick={(p) => onChange('member', p)} />)}
    </fieldset>
  );
}
