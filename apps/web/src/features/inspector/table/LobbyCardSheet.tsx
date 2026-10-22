import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ChangeEvent } from 'react';
import { Sheet } from '../../../components/Sheet';
import { useToast } from '../../../components/Toast';
import { useT } from '../../../i18n/i18n';
import { api } from '../../../lib/api';
import { INSP } from '../api';
import { compressPhoto } from '../model/image';

export const GAMES = ['nlh', 'plo', 'other'] as const;

interface Props {
  open: boolean;
  onClose: () => void;
  table: { id: string; name: string; game: string; featured: boolean; photoUrl?: string | null };
}

/** Card in the lobby: game on the felt, featured, photo (07 §2.5). */
export function LobbyCardSheet({ open, onClose, table }: Props) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [game, setGame] = useState(table.game);
  const [featured, setFeatured] = useState(table.featured);
  const [photo, setPhoto] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setGame(table.game);
    setFeatured(table.featured);
    setPhoto(undefined);
  }, [open, table.game, table.featured]);
  const shown = photo === undefined ? table.photoUrl ?? null : photo;

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setPhoto(await compressPhoto(file));
    } catch {
      toast.show(t('err_table_card_photo_invalid'), 'error');
    }
  }

  async function save() {
    setBusy(true);
    try {
      await api.put(`/inspector/table/${table.id}/lobby-card`, { game, featured, ...(photo === undefined ? {} : { photo }) });
      toast.show(t('insp_saved'), 'success');
      await qc.invalidateQueries({ queryKey: [INSP] });
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('insp_card_title')}>
      <div className={`insp-card-preview${shown ? '' : ' felt'}`} style={shown ? { backgroundImage: `url(${shown})` } : undefined}>
        <strong>{table.name}</strong>
        <span className="pill">{t(`insp_game_${game}`)}</span>
      </div>
      <span className="eyebrow">{t('insp_game')}</span>
      <div className="chips">
        {GAMES.map((g) => (
          <button key={g} type="button" className={`chip${g === game ? ' on' : ''}`} onClick={() => setGame(g)}>{t(`insp_game_${g}`)}</button>
        ))}
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={featured} onChange={(e) => setFeatured(e.target.checked)} />
        <span>{t('insp_featured')}<br /><span className="faint">{t('insp_featured_hint')}</span></span>
      </label>
      <div className="grid-2">
        <label className="btn ghost">
          {t(shown ? 'insp_photo_change' : 'insp_photo_add')}
          <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => void pick(e)} />
        </label>
        <button type="button" className="btn ghost" disabled={!shown} onClick={() => setPhoto(null)}>{t('insp_photo_remove')}</button>
      </div>
      <button type="button" className="btn primary block" disabled={busy} onClick={() => void save()}>{t('insp_save')}</button>
    </Sheet>
  );
}
