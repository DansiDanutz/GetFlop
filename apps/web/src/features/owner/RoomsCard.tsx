import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmSheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n/i18n';
import { ownerApi, type Room } from './api';

/** Rooms (03 §9): one per club; rename; delete only extra, empty rooms. */
export function RoomsCard({ clubId, rooms }: { clubId: string; rooms: Room[] }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Room | null>(null);
  const regular = rooms.filter((r) => !r.reserved);
  const reload = () => qc.invalidateQueries({ queryKey: ['owner', 'settings', clubId] });

  async function run(action: () => Promise<unknown>) {
    try { await action(); await reload(); setEditing(null); setAdding(false); setRemoving(null); } catch (err) { toast.error(err); }
  }

  return (
    <section className="card stack">
      <h3>{t('own_rooms')}</h3>
      <p className="own-note">{t('own_rooms_hint')}</p>
      {rooms.map((r) => (
        <div key={r.id} className="own-toggle">
          {editing === r.id ? (
            <form className="row grow" onSubmit={(e) => { e.preventDefault(); void run(() => ownerApi.renameRoom(clubId, r.id, name)); }}>
              <input className="grow" value={name} maxLength={40} autoFocus onChange={(e) => setName(e.target.value)} aria-label={t('own_room_name')} />
              <button className="btn primary">{t('save')}</button>
            </form>
          ) : (
            <>
              <span className="grow">
                <strong>{r.name}</strong>
                <span className="own-note" style={{ display: 'block' }}>{r.reserved ? t('own_room_reserved') : t('own_room_tables', { n: r.tables })}</span>
              </span>
              {!r.reserved && <button type="button" className="btn link" onClick={() => { setEditing(r.id); setName(r.name); }}>{t('edit')}</button>}
              {!r.reserved && regular.length > 1 && r.tables === 0 && (
                <button type="button" className="btn link" onClick={() => setRemoving(r)}>{t('delete')}</button>
              )}
            </>
          )}
        </div>
      ))}
      {adding ? (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => ownerApi.addRoom(clubId, name)); }}>
          <input className="grow" value={name} maxLength={40} autoFocus onChange={(e) => setName(e.target.value)} aria-label={t('own_room_name')} />
          <button className="btn primary">{t('save')}</button>
        </form>
      ) : (
        <button type="button" className="btn ghost" disabled={regular.length >= 1} onClick={() => { setAdding(true); setName(''); }}>{t('own_room_add')}</button>
      )}
      <ConfirmSheet open={removing !== null} title={t('own_room_delete_title', { name: removing?.name ?? '' })} body={t('own_room_delete_body')}
        confirmLabel={t('delete')} cancelLabel={t('cancel')} danger onCancel={() => setRemoving(null)}
        onConfirm={() => removing && void run(() => ownerApi.deleteRoom(clubId, removing.id))} />
    </section>
  );
}
