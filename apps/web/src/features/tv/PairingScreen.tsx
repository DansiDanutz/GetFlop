import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useT, errorMessage } from '../../i18n/i18n';
import { ApiError } from '../../lib/api';
import { tvApi } from './api';
import { applyKey, CODE_LENGTH, isComplete, keyToAction } from './codeInput';
import { loadDisplay, saveDisplay } from './storage';
import { TvShell } from './TvShell';
import type { TvKind } from './types';

const KEYPAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/** TV: type the 6-digit code from the staff phone. A stored, unexpired token skips straight to the display. */
export function PairingScreen({ kind }: { kind: TvKind }) {
  const t = useT();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const stored = loadDisplay(kind);
    if (stored) navigate(`/tv/${kind}/${stored.token}`, { replace: true });
  }, [kind, navigate]);

  const submit = useCallback(async (value: string) => {
    if (!isComplete(value) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const claim = await tvApi.claim(kind, value);
      saveDisplay(kind, { token: claim.displayToken, expiresAt: claim.expiresAt });
      setConnected(true);
      navigate(`/tv/${kind}/${claim.displayToken}`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? errorMessage(err.code, err.params) : errorMessage('generic'));
      setCode('');
    } finally {
      setBusy(false);
    }
  }, [busy, kind, navigate]);

  const press = useCallback((key: string) => {
    const action = keyToAction(key);
    if (!action) return;
    if (action.type === 'submit') { void submit(code); return; }
    const next = applyKey(code, action);
    setCode(next);
    if (next !== code) setError(null);
    if (action.type === 'digit' && isComplete(next)) void submit(next);
  }, [code, submit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLButtonElement && e.key === 'Enter') return; // the focused key handles it
      if (keyToAction(e.key)) { e.preventDefault(); press(e.key); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press]);

  const slots = Array.from({ length: CODE_LENGTH }, (_, i) => code[i] ?? '');
  return (
    <TvShell className="tv-pair">
      <header className="tv-pair-head">
        <span className="eyebrow">{t('tv_title')}</span>
        <h1>{t(kind === 'cash' ? 'tv_pair_title_cash' : 'tv_pair_title_tournament')}</h1>
        <p className="muted">{t('tv_pair_prompt')}</p>
      </header>
      <div className="tv-pair-body">
        <div className="tv-code" role="group" aria-label={t('tv_pair_prompt')} aria-live="polite">
          {slots.map((digit, i) => (
            <span key={i} className={`tv-code-slot ${i === 2 ? 'gap' : ''} ${i === code.length ? 'cursor' : ''}`}>{digit}</span>
          ))}
        </div>
        {error && <p className="tv-error" role="alert">{error}</p>}
        {connected && <p className="tv-ok" role="status">{t('tv_pair_connected')}</p>}
        <div className="tv-keypad">
          {KEYPAD.map((d) => <button key={d} type="button" className="tv-key" disabled={busy} onClick={() => press(d)}>{d}</button>)}
          <button type="button" className="tv-key small" disabled={busy} onClick={() => press('Escape')}>{t('tv_pair_clear')}</button>
          <button type="button" className="tv-key" disabled={busy} onClick={() => press('0')} autoFocus>0</button>
          <button type="button" className="tv-key small" disabled={busy} onClick={() => press('Backspace')} aria-label={t('tv_pair_delete')}>⌫</button>
        </div>
        <button type="button" className="btn primary lg tv-connect" disabled={!isComplete(code) || busy} onClick={() => void submit(code)}>
          {t('tv_pair_connect')}
        </button>
      </div>
      <footer className="tv-pair-foot faint">
        <p>{t('tv_pair_hint')}</p>
        <p>{t('tv_pair_readonly')}</p>
      </footer>
    </TvShell>
  );
}
