// Reads the flop from a camera picture of the table with Claude's vision.
// Called straight over HTTPS (no SDK) to keep GetFlop free of dependencies; the request is the
// documented Messages API shape: one image block + instructions, and structured JSON output so
// the answer always parses.

import { CARD_CODES } from './cards.ts';

export type FlopReading = { visible: boolean; cards: string[]; confidence: number; note: string };
export type VisionFn = (jpegBase64: string) => Promise<FlopReading>;
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export const VISION_MODEL = 'claude-opus-5-5';

const INSTRUCTIONS = `This is a photo from a camera above a live poker table. The dealer has just dealt the flop: three community cards, face up, in the middle of the table.

Identify exactly those three flop cards. Ignore the players' hole cards, the deck, burn cards, chips and anything outside the middle of the table.

Card codes are the rank (2-9, T for ten, J, Q, K, A) followed by the suit (s spades, h hearts, d diamonds, c clubs), for example "Th" is the ten of hearts.

If fewer than three flop cards are face up, a card is covered, blurred or cut off, or you are unsure of any rank or suit, set visible to false and cards to an empty list. Money is settled on your answer, so never guess.

confidence is your probability, from 0 to 1, that all three cards are exactly right. note is one short sentence on what you see.`;

const SCHEMA = {
  type: 'object',
  properties: {
    visible: { type: 'boolean' },
    cards: { type: 'array', items: { type: 'string', enum: CARD_CODES } },
    confidence: { type: 'number' },
    note: { type: 'string' },
  },
  required: ['visible', 'cards', 'confidence', 'note'],
  additionalProperties: false,
};

export function claudeVision(apiKey: string, fetchFn: Fetch = fetch as unknown as Fetch, baseUrl = 'https://api.anthropic.com'): VisionFn {
  return async (jpegBase64) => {
    const res = await fetchFn(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // On a policy decline the API re-runs the request on its recommended fallback model.
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 1024,
        fallbacks: 'default',
        // Reading three cards is a perception task: low effort keeps each read quick and cheap.
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegBase64 } },
            { type: 'text', text: INSTRUCTIONS },
          ],
        }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`vision request failed (${res.status}): ${text.slice(0, 200)}`);
    const msg = JSON.parse(text);
    if (msg.stop_reason === 'refusal') return { visible: false, cards: [], confidence: 0, note: 'The model declined to read this image.' };
    const block = (msg.content ?? []).find((b: { type: string }) => b.type === 'text');
    if (!block) throw new Error('vision response had no text block');
    const out = JSON.parse(block.text);
    return {
      visible: !!out.visible,
      cards: Array.isArray(out.cards) ? out.cards.map(String) : [],
      confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0)),
      note: String(out.note ?? '').slice(0, 300),
    };
  };
}
