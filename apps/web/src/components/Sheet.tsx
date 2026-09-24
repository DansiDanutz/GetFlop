import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** Prevents closing by tapping outside (for irreversible confirms). */
  modal?: boolean;
}

export function Sheet({ open, onClose, title, children, modal }: SheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !modal) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, modal, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="overlay" onClick={() => { if (!modal) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="grab" />
        {title !== undefined && (
          <div className="sheet-head">
            <h2>{title}</h2>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmProps {
  open: boolean;
  title: ReactNode;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmSheet({ open, title, body, confirmLabel, cancelLabel, danger, busy, onConfirm, onCancel }: ConfirmProps) {
  return (
    <Sheet open={open} onClose={onCancel} title={title} modal>
      {body && <div className="muted">{body}</div>}
      <div className="grid-2">
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
        <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy}>{confirmLabel}</button>
      </div>
    </Sheet>
  );
}
