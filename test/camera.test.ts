import { test } from 'node:test';
import assert from 'node:assert/strict';
import { http, setup } from './helpers.ts';
import { claudeVision, type FlopReading } from '../src/vision.ts';

const JPEG = '/9j/' + 'A'.repeat(400); // shaped like a JPEG; the fake reader never looks inside
let shots = 0;
const pic = () => '/9j/' + 'A'.repeat(396) + (shots++).toString(36).padStart(4, 'A'); // a new picture each time
const sure = (cards: string[], confidence = 0.97): FlopReading => ({ visible: true, cards, confidence, note: 'three cards in the middle' });

// A card reader that answers from a script, one reading per picture.
function scripted(...answers: FlopReading[]) {
  const seen: string[] = [];
  const fn = async (jpeg: string) => { seen.push(jpeg); return answers.shift() ?? { visible: false, cards: [], confidence: 0, note: 'nothing' }; };
  return Object.assign(fn, { seen });
}

async function closedRound(s: Awaited<ReturnType<typeof setup>>) {
  const p = await s.player('alex');
  const r = await s.app.game.openRound(s.table.id, 'staff:dealer');
  await s.app.game.placeBet(p, { roundId: r.id, marketId: 'HAS_FACE', stake: 1000 });
  await s.app.game.closeRound(r.id, 'staff:dealer');
  return { r, p };
}

test('auto mode: two agreeing sure readings enter the flop and settle every bet', async () => {
  const vision = scripted(
    { visible: false, cards: [], confidence: 0.2, note: 'dealer still dealing' },
    sure(['Qh', '4h', '9d']),
    sure(['9d', 'Qh', '4h']), // same cards, any order
  );
  const s = await setup({ vision });
  await s.app.camera.setMode(s.table.id, 'auto', s.admin);
  const { r, p } = await closedRound(s);

  assert.equal((await s.app.camera.scan(r.id, pic(), 'staff:host')).state, 'waiting');
  assert.equal((await s.app.camera.scan(r.id, pic(), 'staff:host')).state, 'checking');
  const done = await s.app.camera.scan(r.id, pic(), 'staff:host');
  assert.equal(done.state, 'settled');
  assert.equal((await s.app.game.round(r.id)).status, 'settled');
  assert.equal(await s.balance(p.id), 100_000 - 1000 + 1710);
  const readings = await s.app.camera.readings(r.id);
  assert.deepEqual(readings.map((x) => x.outcome), ['no_flop', 'read', 'agreed']);
  assert.equal(readings[2].evidence, true); // the picture behind the decision is kept
  assert.equal(readings[1].evidence, false);
  assert.equal((await s.app.audit.list(10, 'camera.flop_read')).length, 1);
  assert.equal((await s.app.camera.scan(r.id, pic(), 'staff:host')).state, 'done');
});

test('a reading is never trusted when unsure, when readings disagree, or with repeated cards', async () => {
  const vision = scripted(
    sure(['Qh', '4h', '9d'], 0.6), // not sure enough
    sure(['Qh', '4h', '9d']),
    sure(['Qh', '4h', '8d']), // disagrees with the previous one
    sure(['Qh', 'Qh', '8d']), // not three different cards
    sure(['Qh', '4h', '8d']),
  );
  const s = await setup({ vision });
  await s.app.camera.setMode(s.table.id, 'auto', s.admin);
  const { r } = await closedRound(s);
  const states = [];
  for (let i = 0; i < 5; i++) states.push((await s.app.camera.scan(r.id, pic(), 'staff:host')).state);
  assert.deepEqual(states, ['waiting', 'checking', 'checking', 'waiting', 'checking']);
  assert.equal((await s.app.game.round(r.id)).status, 'closed');
});

test('assist mode shows the reading to the dealer; auto with dual confirmation still needs a person', async () => {
  const vision = scripted(sure(['Ah', '7c', '2d']), sure(['Ah', '7c', '2d']), sure(['Ah', '7c', '2d']), sure(['Ah', '7c', '2d']), sure(['Ah', '7c', '2d']));
  const s = await setup({ vision });
  // assist (the default)
  const { r } = await closedRound(s);
  await s.app.camera.scan(r.id, pic(), 'staff:host');
  assert.equal((await s.app.camera.scan(r.id, pic(), 'staff:host')).state, 'read');
  assert.equal((await s.app.game.round(r.id)).status, 'closed');
  assert.deepEqual((await s.app.camera.latest(r.id)).reading?.cards, ['Ah', '7c', '2d']);
  await s.app.game.submitFlop(r.id, ['Ah', '7c', '2d'], 'staff:dealer');

  // auto + dual confirmation: the camera is the first entry, the dealer the second
  await s.app.game.updateTable(s.table.id, { dualConfirm: true }, s.admin);
  await s.app.camera.setMode(s.table.id, 'auto', s.admin);
  const r2 = await s.app.game.openRound(s.table.id, 'staff:dealer');
  await s.app.game.closeRound(r2.id, 'staff:dealer');
  await s.app.camera.scan(r2.id, pic(), 'staff:host');
  assert.equal((await s.app.camera.scan(r2.id, pic(), 'staff:host')).state, 'awaiting_confirmation');
  assert.equal((await s.app.camera.scan(r2.id, pic(), 'staff:host')).state, 'awaiting_confirmation'); // never confirms itself
  assert.equal((await s.app.game.submitFlop(r2.id, ['2d', 'Ah', '7c'], 'staff:dealer')).settled, true);
});

test('the host sends pictures; players see them; the camera can be switched off; no reader, no reading', async (t) => {
  const s = await setup({ vision: null });
  t.after(() => s.app.stop());
  await s.app.accounts.createStaff('host1', 'host-password-1', 'dealer', 'system');
  const host = { authorization: `Bearer ${(await http(s.app, 'POST', '/v1/staff/login', { username: 'host1', password: 'host-password-1' })).body.token}` };

  assert.equal((await http(s.app, 'POST', `/v1/host/tables/${s.table.id}/frame`, { jpeg: JPEG })).status, 401);
  assert.equal((await http(s.app, 'POST', `/v1/host/tables/${s.table.id}/frame`, { jpeg: 'not a picture' }, host)).body.error, 'BAD_INPUT');
  assert.equal((await http(s.app, 'POST', `/v1/host/tables/${s.table.id}/frame`, { jpeg: JPEG }, host)).status, 200);
  const view = (await http(s.app, 'GET', `/v1/tables/${s.table.id}`)).body;
  assert.deepEqual(view.camera, { mode: 'assist', live: true, frameAt: s.clock.t, visionReady: false });
  const { port } = s.app.server.address() as { port: number };
  const pic = await fetch(`http://127.0.0.1:${port}/v1/tables/${s.table.id}/camera.jpg`);
  assert.equal(pic.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await pic.arrayBuffer()), Buffer.from(JPEG, 'base64'));
  s.advance(11_000);
  assert.equal((await http(s.app, 'GET', '/v1/tables')).body[0].camera.live, false); // host went quiet

  const r = await s.app.game.openRound(s.table.id, 'staff:dealer');
  assert.equal((await http(s.app, 'POST', `/v1/host/rounds/${r.id}/scan`, { jpeg: JPEG }, host)).body.error, 'VISION_NOT_CONFIGURED');
  await s.app.camera.setMode(s.table.id, 'off', s.admin);
  assert.equal((await http(s.app, 'GET', `/v1/tables/${s.table.id}`)).body.camera.mode, 'off');
});

test('the Claude card reader sends the picture with structured output and reads the answer', async () => {
  const calls: any[] = [];
  const fakeFetch = async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { status: 200, text: async () => JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"visible":true,"cards":["Qh","4h","9d"],"confidence":0.98,"note":"clear"}' }] }) };
  };
  const read = claudeVision('test-key', fakeFetch);
  assert.deepEqual(await read(JPEG), { visible: true, cards: ['Qh', '4h', '9d'], confidence: 0.98, note: 'clear' });
  const { url, headers, body } = calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(headers['x-api-key'], 'test-key');
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.messages[0].content[0].source.data, JPEG);

  const refused = claudeVision('k', async () => ({ status: 200, text: async () => JSON.stringify({ stop_reason: 'refusal', content: [] }) }));
  assert.equal((await refused(JPEG)).visible, false);
  const broken = claudeVision('k', async () => ({ status: 529, text: async () => 'overloaded' }));
  await assert.rejects(broken(JPEG), /529/);
});

test('two readings of the same picture never agree, and a picture from an earlier hand is never trusted', async () => {
  const flop = ['Qh', '4h', '9d'];
  const s = await setup({ vision: scripted(sure(flop), sure(flop), sure(flop), sure(flop), sure(flop), sure(flop), sure(flop)) });
  await s.app.camera.setMode(s.table.id, 'auto', s.admin);
  const { r } = await closedRound(s);
  const same = pic();
  assert.equal((await s.app.camera.scan(r.id, same, 'staff:host')).state, 'checking');
  assert.equal((await s.app.camera.scan(r.id, same, 'staff:host')).state, 'checking'); // frozen or repeated picture
  const last = pic();
  assert.equal((await s.app.camera.scan(r.id, last, 'staff:host')).state, 'settled');

  // Next hand: replaying the last hand's pictures settles nothing.
  const r2 = await s.app.game.openRound(s.table.id, 'd');
  await s.app.game.closeRound(r2.id, 'd');
  assert.equal((await s.app.camera.scan(r2.id, same, 'staff:host')).state, 'waiting');
  assert.equal((await s.app.camera.scan(r2.id, last, 'staff:host')).state, 'waiting');
  assert.equal((await s.app.game.round(r2.id)).status, 'closed');
  assert.deepEqual((await s.app.camera.readings(r2.id)).map((x) => x.outcome), ['replayed', 'replayed']);
});

test('switching the camera mode while a picture is being read takes effect on that reading', async () => {
  let release!: () => void;
  const flop = ['Qh', '4h', '9d'];
  const answers = [sure(flop), sure(flop), sure(flop), sure(flop)];
  const vision = async () => { if (answers.length === 3) await new Promise<void>((r) => (release = r)); return answers.shift()!; };
  const s = await setup({ vision });
  await s.app.camera.setMode(s.table.id, 'auto', s.admin);
  const { r } = await closedRound(s);
  await s.app.camera.scan(r.id, pic(), 'staff:host');
  const pending = s.app.camera.scan(r.id, pic(), 'staff:host'); // held inside the reader
  await new Promise((z) => setTimeout(z, 20));
  await s.app.camera.setMode(s.table.id, 'assist', s.admin);
  release();
  assert.equal((await pending).state, 'read'); // assist now: shown to the dealer, not entered
  assert.equal((await s.app.game.round(r.id)).status, 'closed');
  await s.app.camera.setMode(s.table.id, 'off', s.admin);
  await assert.rejects(s.app.camera.scan(r.id, pic(), 'staff:host'), { code: 'CAMERA_OFF' });
});

test('on a dual-confirmation table the camera never confirms a person\'s entry', async () => {
  const flop = ['Ah', '7c', '2d'];
  const s = await setup({ vision: scripted(sure(flop), sure(flop), sure(flop)) });
  await s.app.game.updateTable(s.table.id, { dualConfirm: true }, s.admin);
  await s.app.camera.setMode(s.table.id, 'auto', s.admin);
  const { r } = await closedRound(s);
  await s.app.game.submitFlop(r.id, flop, 'staff:dealer'); // the dealer enters first
  await s.app.camera.scan(r.id, pic(), 'staff:host');
  assert.equal((await s.app.camera.scan(r.id, pic(), 'staff:host')).state, 'awaiting_confirmation');
  assert.equal((await s.app.game.round(r.id)).status, 'closed'); // still needs a second person
  assert.equal((await s.app.game.submitFlop(r.id, flop, 'staff:floor')).settled, true);
});

test('the dealer console keeps a trusted reading when a later picture is unclear', async () => {
  const flop = ['Ah', '7c', '2d'];
  const s = await setup({ vision: scripted(sure(flop), sure(flop), { visible: false, cards: [], confidence: 0.1, note: 'hand over the cards' }) });
  const { r } = await closedRound(s); // assist
  await s.app.camera.scan(r.id, pic(), 'staff:host');
  await s.app.camera.scan(r.id, pic(), 'staff:host');
  await s.app.camera.scan(r.id, pic(), 'staff:host');
  const latest = await s.app.camera.latest(r.id);
  assert.equal(latest.reading?.outcome, 'agreed');
  assert.deepEqual(latest.reading?.cards, flop);
});
