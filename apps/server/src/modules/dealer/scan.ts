import { cardToString, parseCard } from '@getflop/engine';
import type { AppContext } from '../../context.js';
import { AppError } from '../../http/errors.js';
import { getTable, liveHand } from '../game/tables.js';

export type ScanMediaType = 'image/jpeg' | 'image/png' | 'image/webp';
export const SCAN_MEDIA_TYPES: readonly ScanMediaType[] = ['image/jpeg', 'image/png', 'image/webp'];

export interface RecognizerInput {
  readonly image: Buffer;
  readonly mediaType: ScanMediaType;
}

export interface RecognizerOutput {
  /** Card codes as read; the server keeps only valid, distinct ones (at most 3). */
  readonly cards: readonly string[];
  readonly confidence: 'high' | 'low';
}

/**
 * Reads the three flop cards from a photo. Pluggable: a vision model or a card detector can be
 * installed with setFlopRecognizer(). The default never calls a paid service and answers scan.unavailable.
 */
export interface FlopRecognizer {
  recognize(input: RecognizerInput): Promise<RecognizerOutput>;
}

export const unavailableRecognizer: FlopRecognizer = {
  recognize: async () => { throw new AppError('scan.unavailable', 503); },
};

let recognizer: FlopRecognizer = unavailableRecognizer;

export function setFlopRecognizer(next: FlopRecognizer): void {
  recognizer = next;
}

export function resetFlopRecognizer(): void {
  recognizer = unavailableRecognizer;
}

const FLOP_SIZE = 3;

/** Keeps valid card codes, normalized ("10d" → "Td"), without duplicates, at most three. */
export function cleanCards(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const code of raw) {
    let normalized: string;
    try {
      normalized = cardToString(parseCard(String(code)));
    } catch {
      continue;
    }
    if (!out.includes(normalized)) out.push(normalized);
    if (out.length === FLOP_SIZE) break;
  }
  return out;
}

async function closedHandId(ctx: AppContext, tableId: string): Promise<string> {
  const hand = await liveHand(ctx.db, tableId);
  if (!hand) throw new AppError('hand.not_live', 409);
  if (hand.status !== 'betting_closed' || hand.card1) throw new AppError('dealer.table_changed', 409);
  return hand.id;
}

/** POST /dealer/table/:id/scan-flop. Returns cards for the dealer to confirm; never settles. */
export async function scanFlop(
  ctx: AppContext, clubId: string, tableId: string, dealerId: string, input: RecognizerInput,
): Promise<RecognizerOutput> {
  const table = await getTable(ctx.db, clubId, tableId);
  if (table.dealerId !== dealerId) throw new AppError('dealer.not_dealing', 403);
  const handId = await closedHandId(ctx, tableId);
  let result: RecognizerOutput;
  try {
    result = await recognizer.recognize(input);
  } catch (err) {
    if (err instanceof AppError) throw err;
    ctx.logger.error('Flop recognizer failed', err);
    throw new AppError('scan.unavailable', 503);
  }
  const after = await liveHand(ctx.db, tableId);
  if (!after || after.id !== handId || after.status !== 'betting_closed') throw new AppError('dealer.table_changed', 409);
  return { cards: cleanCards(result.cards), confidence: result.confidence === 'high' ? 'high' : 'low' };
}
