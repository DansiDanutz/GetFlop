import { useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { Flop, PlayingCard, rankLabel } from '../../components/PlayingCard';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n/i18n';
import { dealerApi } from './api';
import {
  activeSlot, EMPTY_PICKER, filledCount, flopOf, PICKER_RANKS, PICKER_SUITS, pickerStep, type PickerAction, type PickerState,
} from './pickerState';
import { layoutLabelKey, nextMode, useLayoutMode } from './layout';
import { photoToScanBase64, scanMessage } from './scanImage';

const SUIT_GLYPH: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RED = new Set(['h', 'd']);

interface FlopPickerProps {
  tableId: string;
  handId: string;
  /** Latest live hand id, to discard a scan when the hand changed meanwhile. */
  currentHandId: () => string | null;
  onClose: () => void;
  onSettled: () => void;
}

export function FlopPicker({ tableId, handId, currentHandId, onClose, onSettled }: FlopPickerProps) {
  const t = useT();
  const toast = useToast();
  const { mode, layout, screen, setMode } = useLayoutMode();
  const [state, setState] = useState<PickerState>(EMPTY_PICKER);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const flop = flopOf(state);

  function act(action: PickerAction): void {
    const res = pickerStep(state, action);
    if (res.error === 'duplicate') toast.show(t('dealer_picker_duplicate'), 'error');
    if (res.error === 'full') toast.show(t('dealer_picker_full'));
    setState(res.state);
  }

  async function onPhoto(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setScanning(true);
    try {
      const image = await photoToScanBase64(file);
      const result = await dealerApi.scanFlop(tableId, image);
      if (currentHandId() !== handId) return;
      setState(pickerStep(EMPTY_PICKER, { type: 'prefill', cards: result.cards }).state);
      const msg = scanMessage(result);
      toast.show(t(msg.key, msg.params), result.cards.length === 3 && result.confidence === 'high' ? 'success' : 'info');
    } catch (err) {
      toast.error(err);
    } finally {
      setScanning(false);
    }
  }

  async function settle(): Promise<void> {
    if (!flop) return;
    setBusy(true);
    try {
      await dealerApi.enterFlop(tableId, flop);
      toast.show(t('dealer_settled_toast'), 'success');
      onSettled();
    } catch (err) {
      toast.error(err);
      setReviewing(false);
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fullscreen dealer-picker" role="dialog" aria-modal="true" aria-label={t('dealer_picker_title', { n: filledCount(state) })}>
      <header className="picker-head">
        <h2 className="grow">{t('dealer_picker_title', { n: filledCount(state) })}</h2>
        <button type="button" className="chip" onClick={() => setMode(nextMode(mode, screen))}>{t(layoutLabelKey(mode, screen))}</button>
        <button type="button" className="chip" disabled={scanning} onClick={() => fileRef.current?.click()}>
          {scanning ? t('dealer_scan_reading') : t('dealer_scan')}
        </button>
        <button type="button" className="icon-btn" aria-label={t('close')} onClick={onClose}>✕</button>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden data-testid="scan-input" onChange={(e) => void onPhoto(e)} />
      </header>
      <SlotRow state={state} onTap={(slot) => act({ type: 'edit', slot })} />
      {layout === 'compact'
        ? <CompactPad state={state} act={act} onConfirm={() => setReviewing(true)} />
        : <FullGrid state={state} act={act} onConfirm={() => setReviewing(true)} />}
      <Sheet open={reviewing && flop !== null} onClose={() => setReviewing(false)} title={t('dealer_review_title')} modal>
        <Flop cards={flop} />
        <p className="muted">{t('dealer_review_body')}</p>
        <div className="grid-2">
          <button type="button" className="btn ghost" disabled={busy} onClick={() => setReviewing(false)}>{t('dealer_review_back')}</button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => void settle()}>{t('dealer_review_confirm')}</button>
        </div>
      </Sheet>
    </div>,
    document.body,
  );
}

function SlotRow({ state, onTap }: { state: PickerState; onTap: (slot: number) => void }) {
  const t = useT();
  const active = activeSlot(state);
  return (
    <div className="picker-slots">
      {state.slots.map((card, i) => (
        <button key={i} type="button" className={`picker-slot ${i === active ? 'active' : ''}`} onClick={() => onTap(i)}
          aria-label={card ? t('dealer_picker_slot_card', { n: i + 1, card: `${rankLabel(card[0]!)}${SUIT_GLYPH[card[1]!]}` }) : t('dealer_picker_slot_empty', { n: i + 1 })}>
          {card ? <PlayingCard code={card} size="md" />
            : <span className="pcard md empty">{i === active && state.pendingRank ? `${rankLabel(state.pendingRank)}?` : '?'}</span>}
        </button>
      ))}
    </div>
  );
}

interface PadProps {
  state: PickerState;
  act: (a: PickerAction) => void;
  onConfirm: () => void;
}

function compactPrompt(state: PickerState, t: ReturnType<typeof useT>): string {
  const slot = activeSlot(state);
  if (slot === null) return t('dealer_picker_check');
  const n = slot + 1;
  if (state.pendingRank) return t('dealer_picker_choose_suit', { n, rank: rankLabel(state.pendingRank) });
  if (state.editing !== null) {
    const card = state.slots[state.editing]!;
    return t('dealer_picker_change', { n, card: `${rankLabel(card[0]!)}${SUIT_GLYPH[card[1]!]}` });
  }
  return t('dealer_picker_choose_rank', { n });
}

function CompactPad({ state, act, onConfirm }: PadProps) {
  const t = useT();
  const complete = activeSlot(state) === null;
  return (
    <div className="picker-body">
      <p className="picker-prompt">{compactPrompt(state, t)}</p>
      {!complete && !state.pendingRank && (
        <div className="pick-grid ranks">
          {PICKER_RANKS.map((r) => (
            <button key={r} type="button" className="pick-key" onClick={() => act({ type: 'rank', rank: r })}>{rankLabel(r)}</button>
          ))}
        </div>
      )}
      {!complete && state.pendingRank && (
        <div className="pick-grid suits">
          {PICKER_SUITS.map((s) => (
            <button key={s} type="button" className={`pick-key suit ${RED.has(s) ? 'red' : ''}`} onClick={() => act({ type: 'suit', suit: s })}>
              <span aria-hidden>{SUIT_GLYPH[s]}</span>
              <small>{t(`dealer_suit_${s}`)}</small>
            </button>
          ))}
        </div>
      )}
      {complete && <button type="button" className="btn danger lg block" onClick={onConfirm}>{t('dealer_picker_confirm')}</button>}
      <div className="grid-2">
        <button type="button" className="btn ghost" onClick={() => act({ type: 'back' })}>{t('back')}</button>
        <button type="button" className="btn ghost" onClick={() => act({ type: 'clear' })}>{t('dealer_picker_clear')}</button>
      </div>
    </div>
  );
}

function FullGrid({ state, act, onConfirm }: PadProps) {
  const t = useT();
  const missing = 3 - filledCount(state);
  return (
    <div className="picker-body">
      {missing === 0
        ? <button type="button" className="btn danger lg block" onClick={onConfirm}>{t('dealer_picker_confirm')}</button>
        : <p className="picker-prompt">{t('dealer_picker_tap_more', { n: missing })}</p>}
      <div className="picker-deck">
        {PICKER_SUITS.map((s) => (
          <div key={s} className="picker-deck-row">
            {PICKER_RANKS.map((r) => {
              const code = `${r}${s}`;
              const on = state.slots.includes(code);
              return (
                <button key={code} type="button" aria-pressed={on} aria-label={`${rankLabel(r)} ${t(`dealer_suit_${s}`)}`} className={`deck-key ${RED.has(s) ? 'red' : ''} ${on ? 'on' : ''}`}
                  onClick={() => act({ type: 'toggle', card: code })}>
                  <span>{rankLabel(r)}</span><span aria-hidden>{SUIT_GLYPH[s]}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <button type="button" className="btn ghost block" onClick={() => act({ type: 'clear' })}>{t('dealer_picker_clear')}</button>
    </div>
  );
}
