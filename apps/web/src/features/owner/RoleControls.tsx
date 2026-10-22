import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ConfirmSheet, Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n/i18n';
import { amount } from '../../lib/format';
import { useSession } from '../../state/session';
import { ownerApi, type MemberCard } from './api';
import { ToggleRow, Switch } from './parts';
import {
  canRemove, canTransferOwnership, playModeToggle, roleToggle, TOGGLE_ROLES, type Party, type ToggleRole,
} from './permissions';

type Pending =
  | { kind: 'role'; role: ToggleRole; grant: boolean }
  | { kind: 'mode'; mode: 'play' | 'watch' }
  | { kind: 'transfer' };

interface Props {
  clubId: string;
  actor: Party;
  member: MemberCard['member'];
  membersPath: string;
  onChanged: () => void;
}

/** Roles, playing mode, removal and ownership transfer on the member card (08 §2.1). */
export function RoleControls({ clubId, actor, member, membersPath, onChanged }: Props) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [pending, setPending] = useState<Pending | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const target: Party = { userId: member.userId, roles: member.roles };
  const isSelf = actor.userId === member.userId;
  const name = member.displayName;

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      toast.show(success, 'success');
      setPending(null);
      onChanged();
      if (isSelf) await refresh();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  function confirm() {
    if (!pending) return;
    if (pending.kind === 'role') {
      const call = pending.grant ? ownerApi.grantRole : ownerApi.revokeRole;
      void run(() => call(clubId, member.userId, pending.role), t(pending.grant ? 'own_role_granted' : 'own_role_revoked', { role: t(`role_${pending.role}`), name }));
    } else if (pending.kind === 'mode') {
      void run(() => ownerApi.playMode(clubId, member.userId, pending.mode), t(`own_mode_set_${pending.mode}`, { name }));
    } else {
      void run(async () => { await ownerApi.transfer(clubId, member.userId); await refresh(); }, t('own_transfer_done', { name }));
    }
  }

  const mode = playModeToggle(actor, target);
  return (
    <section className="stack">
      <h3>{t('own_roles_title')}</h3>
      <div className="card">
        {TOGGLE_ROLES.map((role) => {
          const toggle = roleToggle(actor, target, role);
          const has = member.roles.includes(role);
          return (
            <ToggleRow key={role} title={t(`role_${role}`)} note={toggle.allowed ? t(`own_role_about_${role}`) : t(`own_reason_${toggle.reason}`)}>
              <Switch checked={has} label={t(`role_${role}`)} disabled={!toggle.allowed || busy}
                onChange={(grant) => setPending({ kind: 'role', role, grant })} />
            </ToggleRow>
          );
        })}
        <ToggleRow title={t('own_playing')} note={mode.allowed ? t(member.playMode === 'watch' ? 'own_mode_watch_note' : 'own_mode_play_note') : t(`own_reason_${mode.reason}`)}>
          <Switch checked={member.playMode === 'play'} label={t('own_playing')} disabled={!mode.allowed || busy}
            onChange={(on) => setPending({ kind: 'mode', mode: on ? 'play' : 'watch' })} />
        </ToggleRow>
      </div>
      {(canRemove(actor, target) || canTransferOwnership(actor, target)) && (
        <div className="stack">
          {canTransferOwnership(actor, target) && member.status === 'active' && (
            <button type="button" className="btn outline-gold block" onClick={() => setPending({ kind: 'transfer' })}>{t('own_transfer')}</button>
          )}
          {canRemove(actor, target) && (
            <button type="button" className="btn ghost block own-danger" onClick={() => setRemoveOpen(true)}>{t('own_remove')}</button>
          )}
        </div>
      )}
      <ConfirmSheet open={pending !== null} busy={busy} onCancel={() => setPending(null)} onConfirm={confirm}
        danger={pending?.kind === 'transfer'} cancelLabel={t('cancel')}
        title={pendingTitle(pending, name, t)} body={pendingBody(pending, name, t)}
        confirmLabel={pending?.kind === 'transfer' ? t('own_transfer_cta') : t('confirm')} />
      <RemoveSheet open={removeOpen} clubId={clubId} member={member} onClose={() => setRemoveOpen(false)}
        onRemoved={(returned) => { toast.show(t('own_removed', { name, amount: amount(returned) }), 'success'); navigate(membersPath); }} />
    </section>
  );
}

function pendingTitle(p: Pending | null, name: string, t: ReturnType<typeof useT>): string {
  if (!p) return '';
  if (p.kind === 'role') return t(p.grant ? 'own_confirm_grant' : 'own_confirm_revoke', { role: t(`role_${p.role}`), name });
  if (p.kind === 'mode') return t(`own_confirm_mode_${p.mode}`, { name });
  return t('own_transfer_title', { name });
}

function pendingBody(p: Pending | null, name: string, t: ReturnType<typeof useT>): string {
  if (!p) return '';
  if (p.kind === 'role') return t(p.grant ? `own_grant_body_${p.role}` : 'own_revoke_body', { name, role: t(`role_${p.role}`) });
  if (p.kind === 'mode') return t(`own_mode_body_${p.mode}`, { name });
  return t('own_transfer_body', { name });
}

function RemoveSheet({ open, clubId, member, onClose, onRemoved }: {
  open: boolean; clubId: string; member: MemberCard['member']; onClose: () => void; onRemoved: (returnedCents: number) => void;
}) {
  const t = useT();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  async function remove() {
    setBusy(true);
    try {
      const { returnedCents } = await ownerApi.remove(clubId, member.userId, reason.trim() || undefined);
      onClose();
      onRemoved(returnedCents);
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }
  return (
    <Sheet open={open} onClose={onClose} title={t('own_remove_title', { name: member.displayName })} modal>
      <p className="muted">{t('own_remove_body', { amount: amount(member.balanceCents) })}</p>
      <label>{t('own_reason_optional')}<input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></label>
      <div className="grid-2">
        <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>{t('cancel')}</button>
        <button type="button" className="btn danger" onClick={() => void remove()} disabled={busy}>{t('own_remove_cta')}</button>
      </div>
    </Sheet>
  );
}
