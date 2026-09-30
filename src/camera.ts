// The camera over each table. A host device at the table (host.html: a phone, tablet or small PC
// with a camera) sends a picture of the table every second. Players and the TV watch those
// pictures as the table's live feed. Once betting has closed, the host also asks for the flop to
// be read: the picture goes to the vision model (vision.ts), which names the three flop cards.
//
// A reading is trusted only when it is sure (confidence >= MIN_CONFIDENCE, three different valid
// cards) AND the next reading of a later picture names the same three cards. Then, by the table's
// camera mode:
//   off     no reading; the dealer enters the flop by hand
//   assist  the dealer console shows the reading; the dealer confirms it with one tap (default)
//   auto    the reading is entered as the flop by "ai:camera". With dual confirmation on, it is
//           the first of the two entries and a person must confirm; with it off, it settles.
// Every reading is stored; the picture behind a trusted reading is kept as evidence.

import type { Db, Row } from './db.ts';
import type { Audit } from './audit.ts';
import type { Events } from './events.ts';
import type { Game } from './game.ts';
import { VISION_MODEL, type FlopReading, type VisionFn } from './vision.ts';
import { AppError, fail, newId, sha256 } from './util.ts';
import { parseFlop, formatCard } from './cards.ts';

export const CAMERA_MODES = ['off', 'assist', 'auto'] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];
export const CAMERA_ACTOR = 'ai:camera';
const MIN_CONFIDENCE = 0.9;
const LIVE_MS = 10_000; // a host that sent nothing for this long is offline
const MAX_FRAME_CHARS = 900_000; // base64 JPEG, about 650 KB
const CAMERA_LOCK = 71_004;

export class Camera {
  private db: Db;
  private audit: Audit;
  private events: Events;
  private game: Game;
  private now: () => number;
  private vision: VisionFn | null;
  private reading = new Set<string>(); // rounds with a vision request in flight on this server

  constructor(db: Db, audit: Audit, events: Events, game: Game, now: () => number, vision: VisionFn | null) {
    this.db = db;
    this.audit = audit;
    this.events = events;
    this.game = game;
    this.now = now;
    this.vision = vision;
  }

  get visionReady() {
    return this.vision !== null;
  }

  async status(tableId: string) {
    const c = await this.db.get('SELECT mode, frame_at, host_seen_at FROM table_cameras WHERE table_id = ?', tableId);
    const seen = c?.host_seen_at === null || c?.host_seen_at === undefined ? null : Number(c.host_seen_at);
    return {
      mode: (c?.mode ?? 'assist') as CameraMode,
      live: seen !== null && this.now() - seen < LIVE_MS,
      frameAt: c?.frame_at === null || c?.frame_at === undefined ? null : Number(c.frame_at),
      visionReady: this.visionReady,
    };
  }

  async setMode(tableId: string, mode: unknown, actor: string) {
    if (!CAMERA_MODES.includes(mode as CameraMode)) fail(400, 'BAD_INPUT', `cameraMode must be one of ${CAMERA_MODES.join(', ')}`);
    await this.game.table(tableId);
    await this.db.tx(async () => {
      await this.db.run(
        `INSERT INTO table_cameras (table_id, mode, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (table_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
        tableId, mode, this.now(),
      );
      await this.audit.log(actor, 'camera.mode', { tableId, mode });
    });
    this.events.publish(`table:${tableId}`, 'table.changed', {});
    return this.status(tableId);
  }

  // The host device's latest picture of the table (also its heartbeat).
  async putFrame(tableId: string, jpeg: unknown) {
    const data = checkJpeg(jpeg);
    const t = await this.game.table(tableId);
    if (t.status !== 'active') fail(409, 'TABLE_INACTIVE');
    const at = this.now();
    await this.db.run(
      `INSERT INTO table_cameras (table_id, frame, frame_at, host_seen_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (table_id) DO UPDATE SET frame = excluded.frame, frame_at = excluded.frame_at, host_seen_at = excluded.host_seen_at, updated_at = excluded.updated_at`,
      tableId, data, at, at, at,
    );
    this.events.publish(`table:${tableId}`, 'camera.frame', { at });
    return { at };
  }

  async frame(tableId: string) {
    const c = await this.db.get('SELECT frame, frame_at FROM table_cameras WHERE table_id = ?', tableId);
    if (!c?.frame) fail(404, 'NO_PICTURE', 'This table has no camera picture yet');
    return { jpeg: Buffer.from(c!.frame, 'base64'), at: Number(c!.frame_at) };
  }

  // Reads the flop from a picture taken after betting closed. Returns what the host should show.
  async scan(roundId: string, jpeg: unknown, by: string) {
    const data = checkJpeg(jpeg);
    if (!this.vision) fail(503, 'VISION_NOT_CONFIGURED', 'AI card reading is off: set ANTHROPIC_API_KEY on the server');
    const r = await this.game.round(roundId);
    const { mode } = await this.status(r.table_id);
    if (mode === 'off') fail(409, 'CAMERA_OFF', 'The camera is switched off for this table');
    if (r.status === 'open') fail(409, 'ROUND_STILL_OPEN', 'Betting is still open');
    if (r.status !== 'closed') return { state: 'done' as const };
    if (this.reading.has(roundId)) return { state: 'busy' as const };

    this.reading.add(roundId);
    let reading: FlopReading;
    try {
      reading = await this.vision!(data);
    } catch (e) {
      await this.record(r, null, 'error', String((e as Error).message ?? e).slice(0, 300), null, by);
      return { state: 'error' as const, message: 'The card reader did not answer. Retrying.' };
    } finally {
      this.reading.delete(roundId);
    }

    const cards = trusted(reading);
    const picture = sha256(data);
    const decided = await this.db.tx(async () => {
      await this.db.exclusive(CAMERA_LOCK);
      const now = await this.game.round(roundId);
      if (now.status !== 'closed') return { outcome: 'late' as const, now, mode };
      // The mode as it is now: an admin may have changed it while the picture was being read.
      const modeNow = (await this.status(r.table_id)).mode;
      if (modeNow === 'off') return { outcome: 'off' as const, now, mode: modeNow };
      // A picture already used for an earlier hand at this table is never trusted.
      const replayed = await this.db.get('SELECT 1 FROM flop_readings WHERE table_id = ? AND image_hash = ? AND round_id != ? LIMIT 1', r.table_id, picture, roundId);
      const prev = await this.db.get(
        "SELECT cards, outcome, image_hash FROM flop_readings WHERE round_id = ? AND outcome IN ('read', 'agreed', 'unsure', 'no_flop') ORDER BY seq DESC LIMIT 1", roundId);
      // Agreement needs two different pictures naming the same three cards.
      const agreed = !!cards && !replayed && !!prev?.cards && ['read', 'agreed'].includes(prev.outcome)
        && prev.image_hash !== picture && sameCards(JSON.parse(prev.cards), cards);
      const outcome = replayed ? 'replayed' : !cards ? (reading.visible ? 'unsure' : 'no_flop') : agreed ? 'agreed' : 'read';
      const id = await this.record(r, cards ?? (reading.cards.length ? reading.cards : null), outcome, reading.note, agreed ? data : null, by, reading.confidence, picture);
      if (agreed) await this.audit.log(CAMERA_ACTOR, 'camera.flop_read', { roundId, tableId: r.table_id, cards, confidence: reading.confidence, readingId: id });
      return { outcome, now, mode: modeNow };
    });

    const base = { cards: reading.cards, confidence: reading.confidence, note: reading.note };
    if (decided.outcome === 'late') return { state: 'done' as const };
    if (decided.outcome === 'off') return { state: 'off' as const };
    if (decided.outcome !== 'agreed') {
      if (decided.outcome === 'read') this.events.publish(`table:${r.table_id}`, 'camera.read', { roundId, ...base, agreed: false });
      return { state: decided.outcome === 'read' ? ('checking' as const) : ('waiting' as const), ...base };
    }
    this.events.publish(`table:${r.table_id}`, 'camera.read', { roundId, ...base, agreed: true });
    if (decided.mode === 'assist') return { state: 'read' as const, ...base };

    // Auto: enter the flop. With dual confirmation the camera may only be the first entry; the
    // check runs inside the flop entry's own transaction, so a person entering at the same moment
    // is never confirmed by the camera.
    try {
      const res = await this.game.submitFlop(roundId, cards!, CAMERA_ACTOR, { firstEntryOnly: true });
      return { state: res.settled ? ('settled' as const) : ('awaiting_confirmation' as const), ...base };
    } catch (e) {
      if (e instanceof AppError && e.code === 'NEEDS_SECOND_PERSON') return { state: 'awaiting_confirmation' as const, ...base };
      if (e instanceof AppError && e.code === 'FLOP_MISMATCH') return { state: 'mismatch' as const, ...base };
      if (e instanceof AppError && e.code === 'ROUND_FINISHED') return { state: 'done' as const };
      throw e;
    }
  }

  // The latest reading of a round, for the dealer console.
  async latest(roundId: string) {
    const r = await this.game.round(roundId);
    // A trusted reading stays on the console even if a later picture was unclear.
    const x = await this.db.get(
      `SELECT id, cards, confidence, outcome, note, at FROM flop_readings WHERE round_id = ? AND outcome != 'error'
       ORDER BY CASE WHEN outcome = 'agreed' THEN 1 ELSE 0 END DESC, seq DESC LIMIT 1`, roundId);
    return {
      ...(await this.status(r.table_id)),
      reading: x ? { id: x.id, cards: x.cards ? JSON.parse(x.cards) : null, confidence: Number(x.confidence) / 100, outcome: x.outcome, note: x.note, at: Number(x.at) } : null,
    };
  }

  async readings(roundId: string) {
    return (await this.db.all(
      'SELECT id, cards, confidence, outcome, note, model, at, by_actor, image IS NOT NULL AS has_image FROM flop_readings WHERE round_id = ? ORDER BY seq', roundId,
    )).map((x) => ({
      id: x.id, cards: x.cards ? JSON.parse(x.cards) : null, confidence: Number(x.confidence) / 100, outcome: x.outcome, note: x.note,
      model: x.model, at: Number(x.at), by: x.by_actor, evidence: !!Number(x.has_image) || x.has_image === true,
    }));
  }

  async evidence(readingId: string) {
    const x = await this.db.get('SELECT image FROM flop_readings WHERE id = ?', readingId);
    if (!x?.image) fail(404, 'NO_PICTURE');
    return Buffer.from(x!.image, 'base64');
  }

  private async record(r: Row, cards: string[] | null, outcome: string, note: string | null, image: string | null, by: string, confidence = 0, imageHash: string | null = null) {
    const id = newId('read');
    await this.db.run(
      `INSERT INTO flop_readings (id, round_id, table_id, at, cards, confidence, outcome, note, model, image, image_hash, by_actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, r.id, r.table_id, this.now(), cards ? JSON.stringify(cards) : null, Math.round(confidence * 100), outcome, note, VISION_MODEL, image, imageHash, by,
    );
    return id;
  }
}

// Three different, valid cards read with enough confidence, in canonical form; otherwise null.
function trusted(reading: FlopReading): string[] | null {
  if (!reading.visible || reading.confidence < MIN_CONFIDENCE || reading.cards.length !== 3) return null;
  try {
    return parseFlop(reading.cards).map(formatCard);
  } catch {
    return null;
  }
}

function sameCards(a: string[], b: string[]) {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

function checkJpeg(jpeg: unknown): string {
  if (typeof jpeg !== 'string' || !jpeg.length) fail(400, 'BAD_INPUT', 'jpeg (base64) is required');
  const data = (jpeg as string).replace(/^data:image\/jpeg;base64,/, '');
  if (data.length > MAX_FRAME_CHARS) fail(413, 'PICTURE_TOO_LARGE', 'Send a smaller picture (under about 650 KB)');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) fail(400, 'BAD_INPUT', 'jpeg must be base64');
  if (!data.startsWith('/9j/')) fail(400, 'BAD_INPUT', 'The picture must be a JPEG');
  return data;
}
