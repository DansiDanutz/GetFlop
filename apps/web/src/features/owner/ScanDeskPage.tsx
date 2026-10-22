import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../../components/Toast';
import { TopBar } from '../../components/TopBar';
import { Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { ApiError } from '../../lib/api';
import { date } from '../../lib/format';
import { useSession } from '../../state/session';
import { ownerApi, type ScanResult } from './api';
import { classifyScan, type ScanTarget } from './scanParse';
import { cameraScanSupported, useQrCamera } from './useQrCamera';
import './owner.css';

const STAFF_ROLES = ['owner', 'manager', 'inspector'];

type Outcome =
  | { kind: 'result'; code: string; result: ScanResult }
  | { kind: 'sent'; name: string }
  | { kind: 'message'; key: string; params?: Record<string, string> };

/** Desk "Scan QR" (#/club/scan, #/pc/:code): camera or pasted code → member state and actions (03 §6). */
export function ScanDeskPage() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const { code: fromLink } = useParams();
  const { context, selectClub } = useSession();
  const mine = useQuery({ queryKey: ['owner', 'my-clubs'], queryFn: () => ownerApi.myClubs() });
  const staffClubs = (mine.data?.clubs ?? []).filter((c) => c.membershipStatus === 'active' && c.roles.some((r) => STAFF_ROLES.includes(r)));
  const [clubId, setClubId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    if (clubId || staffClubs.length === 0) return;
    if (staffClubs.length === 1) setClubId(staffClubs[0]!.id);
  }, [clubId, staffClubs]);

  const handle = useCallback(async (raw: string) => {
    if (!clubId) return;
    const target: ScanTarget = classifyScan(raw, window.location.origin);
    setCamera(false);
    if (target.kind === 'table') { navigate(`/join/${target.joinCode}`); return; }
    if (target.kind === 'invite') { setOutcome({ kind: 'message', key: 'own_scan_invite', params: { id: target.publicId } }); return; }
    if (target.kind !== 'player') { setOutcome({ kind: 'message', key: `own_scan_${target.kind}` }); return; }
    setBusy(true);
    try {
      setOutcome({ kind: 'result', code: target.code, result: await ownerApi.scan(clubId, target.code) });
    } catch (err) {
      setOutcome({ kind: 'message', key: err instanceof ApiError ? `err_${err.code.replace(/\./g, '_')}` : 'err_club_scan_failed' });
    } finally { setBusy(false); }
  }, [clubId, navigate]);

  useEffect(() => { if (fromLink && clubId) void handle(fromLink); }, [fromLink, clubId, handle]);
  const onCameraCode = useCallback((value: string) => void handle(value), [handle]);
  const cam = useQrCamera(camera, onCameraCode);

  async function request(code: string, confirmReturn: boolean, name: string) {
    if (!clubId) return;
    setBusy(true);
    try {
      await ownerApi.scanRequest(clubId, code, confirmReturn);
      setOutcome({ kind: 'sent', name });
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  async function openCard(userId: string) {
    if (clubId && clubId !== context?.club.id) await selectClub(clubId);
    navigate(`/club/card/${userId}`);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void handle(text);
  }

  const clubName = staffClubs.find((c) => c.id === clubId)?.name ?? '';
  return (
    <div className="screen">
      <TopBar />
      <div className="screen-body">
        <button type="button" className="btn link" style={{ justifySelf: 'start' }} onClick={() => navigate(-1)}>← {t('back')}</button>
        <h1>{t('own_scan_title')}</h1>
        {mine.isLoading && <Spinner />}
        {mine.data && staffClubs.length === 0 && <div className="banner danger">{t('err_club_scan_denied')}</div>}
        {!clubId && staffClubs.length > 1 && (
          <section className="stack">
            <h3>{t('own_scan_which_club')}</h3>
            {staffClubs.map((c) => <button key={c.id} type="button" className="btn ghost block" onClick={() => setClubId(c.id)}>{c.name}</button>)}
          </section>
        )}
        {clubId && (
          <>
            <div className="row-between">
              <span className="muted">{t('own_scan_for_club', { club: clubName })}</span>
              {staffClubs.length > 1 && <button type="button" className="btn link" onClick={() => { setClubId(null); setOutcome(null); }}>{t('own_change')}</button>}
            </div>
            {cameraScanSupported() && (
              camera
                ? <video ref={cam.video} className="own-video" playsInline muted />
                : <button type="button" className="btn primary block" onClick={() => { cam.reset(); setOutcome(null); setCamera(true); }}>{t('own_scan_camera')}</button>
            )}
            {cam.error && <div className="banner danger">{t(cam.error)}</div>}
            <form className="stack" onSubmit={submit}>
              <label>{t('own_scan_paste')}<input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('own_scan_paste_placeholder')} /></label>
              <button className="btn ghost block" disabled={busy || !text.trim()}>{t('own_scan_check')}</button>
            </form>
            {busy && <Spinner />}
            {outcome && <OutcomeCard outcome={outcome} busy={busy} onRequest={request} onOpen={(id) => void openCard(id)} onRequests={() => navigate('/club/requests')} />}
          </>
        )}
      </div>
    </div>
  );
}

interface OutcomeProps {
  outcome: Outcome; busy: boolean;
  onRequest: (code: string, confirmReturn: boolean, name: string) => void;
  onOpen: (userId: string) => void;
  onRequests: () => void;
}

function OutcomeCard({ outcome, busy, onRequest, onOpen, onRequests }: OutcomeProps) {
  const t = useT();
  if (outcome.kind === 'message') return <div className="banner">{t(outcome.key, outcome.params)}</div>;
  if (outcome.kind === 'sent') return <div className="banner ok">{t('own_scan_request_sent', { name: outcome.name })}</div>;
  const { result, code } = outcome;
  const name = result.player.displayName;
  return (
    <section className="card stack">
      <strong style={{ fontSize: 18 }}>{name} <span className="faint">@{result.player.username}</span></strong>
      <span className="muted">{t(`own_scan_state_${result.state}`, { date: date(result.endedAt) })}</span>
      {result.state === 'active' && <button type="button" className="btn primary block" onClick={() => onOpen(result.player.id)}>{t('own_scan_open_card')}</button>}
      {result.state === 'pending' && <button type="button" className="btn ghost block" onClick={onRequests}>{t('own_scan_to_requests')}</button>}
      {(result.state === 'left' || result.state === 'removed') && (
        <button type="button" className="btn primary block" disabled={busy} onClick={() => onRequest(code, true, name)}>{t('own_scan_new_request')}</button>
      )}
      {result.state === 'none' && (
        <button type="button" className="btn primary block" disabled={busy} onClick={() => onRequest(code, false, name)}>{t('own_scan_send_request')}</button>
      )}
    </section>
  );
}
