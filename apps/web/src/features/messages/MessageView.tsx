import { useState } from 'react';
import { Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { dateTime } from '../../lib/format';
import { useMessagePhoto } from './hooks';
import type { MessageAction } from './types';

export interface MessageViewProps {
  clubName: string;
  clubPhotoUrl?: string | null;
  title: string | null;
  body: string;
  action: MessageAction | null;
  /** A photo already in hand (composer preview, card overlay). */
  photo?: string | null;
  /** Otherwise: the message id, to fetch the photo on "See the photo". */
  photoMessageId?: string | null;
  when?: string | null;
  direct?: boolean;
  onAction?: () => void;
}

export function actionLabelKey(action: MessageAction): string {
  return action.type === 'table' ? 'msg_btn_join' : 'msg_btn_register';
}

function LazyPhoto({ messageId }: { messageId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const photo = useMessagePhoto(open ? messageId : null);
  if (!open) return <button type="button" className="btn ghost block" onClick={() => setOpen(true)}>{t('inbox_see_photo')}</button>;
  if (photo.isLoading) return <Spinner />;
  if (!photo.data?.photo) return <p className="faint">{t('inbox_photo_gone')}</p>;
  return <img className="msg-photo" src={photo.data.photo} alt="" />;
}

/** One message as a member sees it: club, title, text, photo and button. */
export function MessageView({ clubName, clubPhotoUrl, title, body, action, photo, photoMessageId, when, direct, onAction }: MessageViewProps) {
  const t = useT();
  return (
    <article className="msg-view">
      <header className="row">
        <span className="avatar msg-avatar">{clubPhotoUrl ? <img src={clubPhotoUrl} alt="" /> : clubName.slice(0, 1).toUpperCase()}</span>
        <span className="grow">
          <strong className="truncate" style={{ display: 'block' }}>{clubName}</strong>
          <span className="faint">{direct ? t('inbox_direct') : when ? dateTime(when) : ''}</span>
        </span>
      </header>
      {photo && <img className="msg-photo" src={photo} alt="" />}
      {!photo && photoMessageId && <LazyPhoto messageId={photoMessageId} />}
      {title && <h3 className="msg-title">{title}</h3>}
      <p className="msg-body">{body}</p>
      {action && (
        <button type="button" className="btn primary block" onClick={onAction} disabled={!onAction}>
          {t(actionLabelKey(action), { name: action.label })}
        </button>
      )}
    </article>
  );
}
