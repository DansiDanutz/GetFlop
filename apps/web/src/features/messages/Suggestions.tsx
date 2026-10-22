import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n/i18n';
import { api, qs } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { browserTz } from './logic';
import { QUERY_KEYS, type Suggestion } from './types';

function headline(s: Suggestion, t: (k: string, p?: Record<string, string | number | null>) => string): string {
  if (s.kind === 'tournament') {
    return s.params.startsAt
      ? t('msg_suggest_tournament', { ...s.params, when: dateTime(String(s.params.startsAt)) })
      : t('msg_suggest_tournament_nodate', s.params);
  }
  return t(`msg_suggest_${s.kind}`, s.params);
}

/** "GetFlop suggests": ready-made messages with "Use it" and "Not now". */
export function Suggestions({ clubId, onUse }: { clubId: string | null; onUse: (s: Suggestion) => void }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const tz = browserTz();
  const list = useQuery({
    queryKey: QUERY_KEYS.suggestions(clubId),
    queryFn: () => api.get<{ suggestions: Suggestion[] }>(`/messages/suggestions${qs({ tz })}`),
  });
  const dismiss = useMutation({
    mutationFn: (key: string) => api.post(`/messages/suggestions/${encodeURIComponent(key)}/dismiss`, { tz }),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.suggestions(clubId) }),
    onError: (err) => toast.error(err),
  });
  const items = list.data?.suggestions ?? [];
  if (items.length === 0) return null;
  return (
    <section className="stack" aria-label={t('msg_suggest_title')}>
      <div className="row-between">
        <span className="eyebrow">{t('msg_suggest_title')}</span>
        <span className="faint">{t('msg_suggest_count', { n: items.length })}</span>
      </div>
      <div className="scroll-x msg-suggestions">
        {items.map((s) => (
          <article key={s.key} className="card tight stack msg-suggestion">
            <strong>{headline(s, t)}</strong>
            <span className="faint">{t(`msg_aud_${s.audience}`)}</span>
            <div className="grid-2">
              <button type="button" className="btn ghost" onClick={() => dismiss.mutate(s.key)} disabled={dismiss.isPending}>{t('msg_suggest_dismiss')}</button>
              <button type="button" className="btn primary" onClick={() => onUse(s)}>{t('msg_suggest_write')}</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
