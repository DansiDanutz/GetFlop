import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ChangeEvent } from 'react';
import { ConfirmSheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Segmented } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { api } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { AudiencePicker } from './AudiencePicker';
import { ACCEPTED_TYPES, compressPhoto } from './compressPhoto';
import {
  BODY_MAX, TITLE_MAX, browserTz, draftAction, emptyDraft, fromLocalInput, reachLines, toComposeBody, validateDraft,
  type Draft, type Problem,
} from './logic';
import { MessageView } from './MessageView';
import type { Audience, ComposeResult, Targets } from './types';

export interface ComposerProps {
  draft: Draft;
  onDraft: (update: (d: Draft) => Draft) => void;
  audiences: readonly Audience[] | undefined;
  targets: Targets | undefined;
  clubName: string;
}

function FieldProblems({ problems, field }: { problems: readonly Problem[]; field: Problem['field'] }) {
  const t = useT();
  return <>{problems.filter((p) => p.field === field).map((p) => <p key={p.key} className="field-error" role="alert">{t(p.key, p.params)}</p>)}</>;
}

function ButtonField({ draft, onDraft, targets }: Pick<ComposerProps, 'draft' | 'onDraft' | 'targets'>) {
  const t = useT();
  const none = !targets || (targets.tables.length === 0 && targets.tournaments.length === 0);
  return (
    <label>
      {t('msg_button')}
      <select value={draft.actionKey} onChange={(e) => onDraft((d) => ({ ...d, actionKey: e.target.value }))}>
        <option value="">{t('msg_button_none')}</option>
        {targets?.tables.map((x) => <option key={x.id} value={`table:${x.id}`}>{t('msg_button_table', { name: x.name })}</option>)}
        {targets?.tournaments.map((x) => <option key={x.id} value={`tournament:${x.id}`}>{t('msg_button_tournament', { name: x.name })}</option>)}
      </select>
      {none && <span className="faint">{t('msg_button_nothing')}</span>}
    </label>
  );
}

function PhotoField({ draft, onDraft }: Pick<ComposerProps, 'draft' | 'onDraft'>) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const photo = await compressPhoto(file);
      onDraft((d) => ({ ...d, photo: photo.dataUrl, photoBytes: photo.bytes }));
    } catch {
      toast.show(t('err_messages_photo_invalid'), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <span className="eyebrow">{t('msg_photo')}</span>
      {draft.photo ? (
        <div className="row-between">
          <span className="faint">{t('msg_photo_size', { kb: Math.ceil(draft.photoBytes / 1024) })}</span>
          <button type="button" className="btn ghost" onClick={() => onDraft((d) => ({ ...d, photo: null, photoBytes: 0 }))}>{t('msg_photo_remove')}</button>
        </div>
      ) : (
        <label className="btn ghost block msg-file">
          {busy ? t('msg_photo_working') : t('msg_photo_add')}
          <input type="file" accept={ACCEPTED_TYPES.join(',')} onChange={(e) => void pick(e)} disabled={busy} hidden />
        </label>
      )}
      <span className="faint">{t('msg_photo_hint')}</span>
    </div>
  );
}

/** The "New" tab: who, what, photo, button, when, preview and a confirm before it goes. */
export function Composer({ draft, onDraft, audiences, targets, clubName }: ComposerProps) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [attempted, setAttempted] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const problems = validateDraft(draft, audiences, new Date());
  const shown = attempted ? problems : problems.filter((p) => p.key === 'err_messages_too_long' || p.key === 'err_messages_photo_too_large');
  const action = draftAction(draft, targets);
  const audience = audiences?.find((a) => a.key === draft.audience);
  const sendAt = draft.when === 'later' ? fromLocalInput(draft.sendAtLocal) : null;

  const send = useMutation({
    mutationFn: () => api.post<ComposeResult>('/messages', toComposeBody(draft, browserTz())),
    onSuccess: (res) => {
      toast.show(res.scheduled ? t('msg_scheduled_ok', { when: dateTime(res.sendAt) }) : t('msg_sent_ok', { n: res.recipientCount }), 'success');
      setConfirming(false);
      setAttempted(false);
      onDraft(() => emptyDraft(new Date()));
      void qc.invalidateQueries({ queryKey: ['messages'] });
    },
    onError: (err) => { setConfirming(false); toast.error(err); },
  });

  function review() {
    setAttempted(true);
    if (problems.length === 0) setConfirming(true);
  }

  const confirmBody = [
    draft.audience === 'member'
      ? t('msg_confirm_one', { name: draft.recipient?.displayName ?? '' })
      : t('msg_confirm_now', { n: audience?.count ?? 0, audience: t(`msg_aud_${draft.audience}`) }),
    sendAt ? t('msg_confirm_later', { when: dateTime(sendAt) }) : '',
    action ? t('msg_confirm_button', { button: t(action.type === 'table' ? 'msg_btn_join' : 'msg_btn_register', { name: action.label }) }) : '',
  ].filter(Boolean);

  return (
    <div className="stack-lg">
      <AudiencePicker value={draft.audience} recipient={draft.recipient} audiences={audiences}
        onChange={(a, r) => onDraft((d) => ({ ...d, audience: a, recipient: r }))} />
      <div className="msg-reach" aria-live="polite">
        {reachLines(draft, audiences).map((l) => <span key={l.key}>{t(l.key, l.params)}</span>)}
      </div>
      <FieldProblems problems={shown} field="audience" />

      <label>
        <span className="row-between"><span>{t('msg_field_title')}</span><span className="faint">{t('msg_counter', { n: draft.title.trim().length, max: TITLE_MAX })}</span></span>
        <input value={draft.title} maxLength={TITLE_MAX + 20} onChange={(e) => onDraft((d) => ({ ...d, title: e.target.value }))} />
      </label>
      <FieldProblems problems={shown} field="title" />

      <label>
        <span className="row-between"><span>{t('msg_field_body')}</span><span className="faint">{t('msg_counter', { n: draft.body.trim().length, max: BODY_MAX })}</span></span>
        <textarea rows={6} value={draft.body} placeholder={t('msg_body_placeholder')} onChange={(e) => onDraft((d) => ({ ...d, body: e.target.value }))} />
      </label>
      <FieldProblems problems={shown} field="body" />

      <PhotoField draft={draft} onDraft={onDraft} />
      <FieldProblems problems={shown} field="photo" />

      <ButtonField draft={draft} onDraft={onDraft} targets={targets} />

      <div className="stack">
        <span className="eyebrow">{t('msg_when')}</span>
        <Segmented value={draft.when} onChange={(when) => onDraft((d) => ({ ...d, when }))}
          options={[{ value: 'now', label: t('msg_when_now') }, { value: 'later', label: t('msg_when_later') }]} />
        {draft.when === 'later' && (
          <>
            <input type="datetime-local" aria-label={t('msg_when_later')} value={draft.sendAtLocal}
              onChange={(e) => onDraft((d) => ({ ...d, sendAtLocal: e.target.value }))} />
            <span className="faint">{t('msg_when_hint')}</span>
          </>
        )}
        <FieldProblems problems={shown} field="when" />
      </div>

      <section className="stack">
        <span className="eyebrow">{t('msg_preview')}</span>
        <span className="faint">{t('msg_preview_hint')}</span>
        <div className="msg-phone">
          <MessageView clubName={clubName} title={draft.title.trim() || null} body={draft.body.trim() || t('msg_body_placeholder')}
            action={action} photo={draft.photo} direct={draft.audience === 'member'} when={new Date().toISOString()} />
        </div>
      </section>

      <button type="button" className="btn primary block lg" onClick={review}>{t('msg_review')}</button>
      <ConfirmSheet open={confirming} title={t('msg_confirm_title')} busy={send.isPending}
        body={<div className="stack">{confirmBody.map((line) => <p key={line}>{line}</p>)}</div>}
        confirmLabel={sendAt ? t('msg_schedule') : t('msg_send')} cancelLabel={t('cancel')}
        onConfirm={() => send.mutate()} onCancel={() => setConfirming(false)} />
    </div>
  );
}
