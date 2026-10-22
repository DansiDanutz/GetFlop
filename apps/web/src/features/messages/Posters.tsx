import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useToast } from '../../components/Toast';
import { Empty, Segmented, Spinner } from '../../components/ui';
import { getLanguage, useT } from '../../i18n/i18n';
import { api } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { useSession } from '../../state/session';
import { StaffShell } from '../staff/StaffShell';
import { posterFromFields, posterIsComplete, type PosterFields } from './posterFields';
import { QUERY_KEYS, type PosterFile, type Targets } from './types';
import './messages.css';

const PREVIEW_DEBOUNCE_MS = 400;

function download(file: PosterFile): void {
  const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function usePreview(fields: PosterFields) {
  const [debounced, setDebounced] = useState(fields);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(fields), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [fields]);
  const lang = getLanguage();
  return useQuery({
    queryKey: ['posters', 'preview', debounced, lang],
    queryFn: () => api.post<{ svg: string }>('/posters/preview', { poster: posterFromFields(debounced), lang }),
    enabled: posterIsComplete(debounced),
    staleTime: Infinity,
  });
}

function TextField({ label, value, max, placeholder, onChange }: { label: string; value: string; max: number; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <label>
      {label}
      <input value={value} maxLength={max} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** #/club/posters — the owner's print-ready posters with the club QR. */
export function Posters() {
  const t = useT();
  const toast = useToast();
  const { context, user } = useSession();
  const isOwner = Boolean(context?.roles.includes('owner'));
  const [fields, setFields] = useState<PosterFields>(() => ({
    kind: 'welcome', firstLine: t('poster_default_welcome'), message: t('poster_default_message'), extraLine: '',
    tournamentId: '', name: '', when: '', secondLine: '',
  }));
  const set = (patch: Partial<PosterFields>) => setFields((f) => ({ ...f, ...patch }));
  const targets = useQuery({
    queryKey: QUERY_KEYS.targets(context?.club.id ?? null),
    queryFn: () => api.get<Targets>('/messages/targets'),
    enabled: isOwner,
  });
  const preview = usePreview(fields);
  const body = () => ({ poster: posterFromFields(fields), lang: getLanguage() });
  const render = useMutation({
    mutationFn: (format: 'pdf' | 'png') => api.post<PosterFile>('/posters/render', { ...body(), format }),
    onSuccess: download,
    onError: (err) => toast.error(err),
  });
  const email = useMutation({
    mutationFn: () => api.post<{ sentTo: string }>('/posters/email', body()),
    onSuccess: (res) => toast.show(t('poster_emailed', { email: res.sentTo }), 'success'),
    onError: (err) => toast.error(err),
  });

  if (!isOwner) return <StaffShell><Empty icon="▣" title={t('poster_owner_only')} /></StaffShell>;
  const busy = render.isPending || email.isPending;
  const ready = posterIsComplete(fields);

  function pickTournament(id: string) {
    const tr = targets.data?.tournaments.find((x) => x.id === id);
    set(tr ? { tournamentId: id, name: tr.name, when: tr.startsAt ? dateTime(tr.startsAt) : '' } : { tournamentId: '' });
  }

  return (
    <StaffShell>
      <div className="stack-lg msg-page">
        <div className="stack">
          <h1>{t('poster_title')}</h1>
          <span className="faint">{t('poster_intro')}</span>
        </div>
        <Segmented value={fields.kind} onChange={(kind) => set({ kind })}
          options={[{ value: 'welcome', label: t('poster_kind_welcome') }, { value: 'tournament', label: t('poster_kind_tournament') }]} />
        {fields.kind === 'welcome' ? (
          <div className="stack">
            <TextField label={t('poster_first_line')} value={fields.firstLine} max={60} onChange={(v) => set({ firstLine: v })} />
            <label>
              {t('poster_message')}
              <textarea rows={3} maxLength={300} value={fields.message} onChange={(e) => set({ message: e.target.value })} />
            </label>
            <TextField label={t('poster_extra_line')} value={fields.extraLine} max={80} placeholder={t('poster_extra_placeholder')} onChange={(v) => set({ extraLine: v })} />
          </div>
        ) : (
          <div className="stack">
            <label>
              {t('poster_pick_tournament')}
              <select value={fields.tournamentId} onChange={(e) => pickTournament(e.target.value)}>
                <option value="">{t('poster_tournament_none')}</option>
                {targets.data?.tournaments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
            <TextField label={t('poster_tournament_name')} value={fields.name} max={60} onChange={(v) => set({ name: v })} />
            <TextField label={t('poster_when')} value={fields.when} max={60} onChange={(v) => set({ when: v })} />
            <TextField label={t('poster_second_line')} value={fields.secondLine} max={80} onChange={(v) => set({ secondLine: v })} />
          </div>
        )}
        <section className="stack">
          <span className="eyebrow">{t('poster_preview')}</span>
          <div className="msg-poster-preview">
            {!ready && <span className="faint">{t('poster_preview_hint')}</span>}
            {ready && preview.isLoading && <Spinner />}
            {ready && preview.data && (
              <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.data.svg)}`} alt={t('poster_preview')} width={248} height={351} />
            )}
          </div>
        </section>
        {busy && <p className="faint">{t('poster_working')}</p>}
        <div className="grid-2">
          <button type="button" className="btn primary" disabled={!ready || busy} onClick={() => render.mutate('pdf')}>{t('poster_pdf')}</button>
          <button type="button" className="btn ghost" disabled={!ready || busy} onClick={() => render.mutate('png')}>{t('poster_png')}</button>
        </div>
        <button type="button" className="btn ghost block" disabled={!ready || busy || !user} onClick={() => email.mutate()}>{t('poster_email')}</button>
      </div>
    </StaffShell>
  );
}
