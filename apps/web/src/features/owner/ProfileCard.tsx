import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n/i18n';
import { ApiError } from '../../lib/api';
import { useSession } from '../../state/session';
import { ownerApi, type ClubSettings } from './api';
import { Avatar } from './parts';
import { PhotoCropSheet } from './PhotoCropSheet';

type SaveState = 'idle' | 'saving' | 'saved';
const AUTOSAVE_MS = 800;

/** Club photo, name and description with autosave (08 §4). */
export function ProfileCard({ clubId, settings }: { clubId: string; settings: ClubSettings }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { refresh } = useSession();
  const [name, setName] = useState(settings.name);
  const [description, setDescription] = useState(settings.description ?? '');
  const [state, setState] = useState<SaveState>('idle');
  const [file, setFile] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useCallback(async (body: { name?: string; description?: string | null; logo?: string | null }) => {
    setState('saving');
    try {
      const next = await ownerApi.saveProfile(clubId, body);
      qc.setQueryData(['owner', 'settings', clubId], next);
      setState('saved');
      await refresh();
      await qc.invalidateQueries({ queryKey: ['owner', 'setup'] });
    } catch (err) {
      setState('idle');
      if (!(err instanceof ApiError && err.code === 'club.nothing_to_change')) toast.error(err);
    }
  }, [clubId, qc, refresh, toast]);

  useEffect(() => {
    if (name === settings.name && description === (settings.description ?? '')) return;
    if (name.trim().length < 3) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save({ name, description: description.trim() || null }), AUTOSAVE_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [name, description, settings.name, settings.description, save]);

  return (
    <section id="profile" className="card stack">
      <div className="row-between">
        <h3>{t('own_profile')}</h3>
        <span className="own-note" aria-live="polite">{t(`own_save_${state}`)}</span>
      </div>
      <div className="row">
        <Avatar name={settings.name} photo={settings.photoUrl} large />
        <div className="stack grow">
          <button type="button" className="btn ghost" onClick={() => input.current?.click()}>
            {t(settings.photoUrl ? 'own_photo_change' : 'own_photo_add')}
          </button>
          {settings.photoUrl && <button type="button" className="btn link" onClick={() => void save({ logo: null })}>{t('own_photo_remove')}</button>}
        </div>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
      </div>
      <label>{t('clubs_name')}<input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
      {name.trim().length < 3 && <span className="field-error">{t('err_club_name_invalid')}</span>}
      <label>{t('clubs_description')}<textarea rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <PhotoCropSheet file={file} onCancel={() => setFile(null)}
        onError={(key) => { setFile(null); toast.show(t(key), 'error'); }}
        onDone={(logo) => { setFile(null); void save({ logo }); }} />
    </section>
  );
}
