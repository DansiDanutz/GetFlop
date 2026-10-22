import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { QrCode, Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { dateTime } from '../../lib/format';
import { useSocketEvent } from '../../lib/socket';
import { tvApi } from './api';
import { mmss, secondsUntil } from './clock';
import { formatCode } from './codeInput';
import { copyText } from './copyText';
import { sessionsKey, TvSessionsList } from './TvSessionsList';
import type { DirectLinkResponse, PairingResponse, TvKind } from './types';
import './tv.css';

const TICK_MS = 1_000;

export interface TvLaunchSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly kind: TvKind;
  /** Table id (cash) or tournament id. */
  readonly targetId: string;
  readonly targetName: string;
}

function useSecondsLeft(expiresAt: string | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!expiresAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [expiresAt]);
  return expiresAt ? secondsUntil(new Date(expiresAt), now) : 0;
}

function DirectLink({ kind, targetId }: { kind: TvKind; targetId: string }) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [link, setLink] = useState<DirectLinkResponse | null>(null);
  const create = useMutation({
    mutationFn: () => tvApi.createLink(kind, targetId),
    onSuccess: (data) => { setLink(data); void queryClient.invalidateQueries({ queryKey: sessionsKey(kind, targetId) }); },
    onError: (err) => toast.error(err),
  });
  const copy = async (text: string) => toast.show(t((await copyText(text)) ? 'tv_launch_link_copied' : 'tv_copy_failed'));
  return (
    <section className="stack tv-direct">
      <p className="faint">{t('tv_launch_direct_note')}</p>
      {link && (
        <div className="stack center">
          <div className="tv-launch-qr"><QrCode text={link.tvUrl} size={200} /></div>
          <code className="tv-url">{link.tvUrl}</code>
          <p className="faint">{t('tv_launch_valid_until', { time: dateTime(link.expiresAt) })}</p>
          <div className="grid-2">
            <button type="button" className="btn ghost" onClick={() => void copy(link.tvUrl)}>{t('tv_launch_copy_link')}</button>
            <a className="btn ghost" href={link.tvUrl} target="_blank" rel="noopener noreferrer">{t('tv_launch_open')}</a>
          </div>
        </div>
      )}
      <button type="button" className="btn outline-gold block" disabled={create.isPending} onClick={() => create.mutate()}>
        {t('tv_launch_direct_create')}
      </button>
    </section>
  );
}

/**
 * Staff phone: "Show on TV". Creates a 6-digit code (refreshed automatically when it runs out),
 * shows the TV address, confirms when the TV connects, offers a direct link and lists connected TVs.
 */
export function TvLaunchSheet({ open, onClose, kind, targetId, targetName }: TvLaunchSheetProps) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [pairing, setPairing] = useState<PairingResponse | null>(null);
  const [connectedName, setConnectedName] = useState<string | null>(null);
  const [showDirect, setShowDirect] = useState(false);
  const create = useMutation({
    mutationFn: () => tvApi.createPairing(kind, targetId),
    onSuccess: (data) => setPairing(data),
    onError: (err) => toast.error(err),
  });
  const { mutate: createCode, isPending, isError } = create;
  const secondsLeft = useSecondsLeft(pairing?.expiresAt ?? null);

  const newCode = useCallback(() => { setConnectedName(null); createCode(); }, [createCode]);

  useEffect(() => {
    if (!open) { setPairing(null); setConnectedName(null); setShowDirect(false); return; }
    newCode();
  }, [open, newCode]);

  // "This code refreshes automatically": a new one as soon as the current code runs out.
  useEffect(() => {
    if (open && pairing && !connectedName && secondsLeft === 0 && !isPending && !isError) createCode();
  }, [open, pairing, connectedName, secondsLeft, isPending, isError, createCode]);

  useSocketEvent<{ pairingId: string; targetId: string; kind: TvKind; name: string }>('tv:connected', (p) => {
    if (!open || p.kind !== kind || p.targetId !== targetId) return;
    toast.show(t('tv_launch_connected_toast'), 'success');
    setConnectedName(p.name);
    void queryClient.invalidateQueries({ queryKey: sessionsKey(kind, targetId) });
  }, [open, kind, targetId]);

  const copyAddress = async () => {
    if (!pairing) return;
    toast.show(t((await copyText(pairing.tvUrl)) ? 'tv_launch_address_copied' : 'tv_copy_failed'));
  };

  return (
    <Sheet open={open} onClose={onClose} title={`${t(kind === 'cash' ? 'tv_launch_cash' : 'tv_launch_tournament')} · ${targetName}`}>
      <div className="stack-lg tv-launch">
        {connectedName ? (
          <div className="stack center">
            <p className="tv-ok">{t('tv_launch_connected', { name: connectedName })}</p>
            <button type="button" className="btn outline-gold block" onClick={newCode}>{t('tv_launch_pair_another')}</button>
          </div>
        ) : (
          <>
            <section className="stack">
              <span className="eyebrow">{t('tv_launch_step_open')}</span>
              {pairing ? (
                <div className="row-between">
                  <code className="tv-url grow truncate">{pairing.tvUrl}</code>
                  <button type="button" className="btn ghost" onClick={() => void copyAddress()}>{t('tv_launch_copy_address')}</button>
                </div>
              ) : <Spinner />}
            </section>
            <section className="stack center">
              <span className="eyebrow">{t('tv_launch_step_code')}</span>
              {pairing && !isPending ? (
                <>
                  <p className="tv-launch-code num" aria-live="polite">{formatCode(pairing.pairingCode)}</p>
                  <p className="muted num">{t('tv_launch_expires_in', { time: mmss(secondsLeft) })}</p>
                  <p className="faint">{t('tv_launch_refresh_note', { n: pairing.expiresInMinutes })}</p>
                </>
              ) : <p className="muted">{t('tv_launch_creating')}</p>}
            </section>
          </>
        )}
        <p className="faint">{t('tv_launch_readonly')}</p>
        {showDirect
          ? <DirectLink kind={kind} targetId={targetId} />
          : <button type="button" className="btn link" onClick={() => setShowDirect(true)}>{t('tv_launch_direct')}</button>}
        {open && <TvSessionsList kind={kind} targetId={targetId} />}
      </div>
    </Sheet>
  );
}
