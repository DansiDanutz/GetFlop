// Table host: the camera device at the table (a phone, tablet or small PC). It sends a picture of
// the table every second, which players and the TV watch as the table's live feed. Once betting
// closes it asks for the flop to be read from the pictures, again and again, until the hand is
// settled (see src/camera.ts for when a reading is trusted and what happens next).

import { $, h, toast } from './lib.js';
import { call, requireStaff } from './staff.js';

const FRAME_MS = 1000; // one picture a second to viewers
const SCAN_MS = 1500; // pause between flop readings
const MAX_WIDTH = 1280; // pictures are scaled down to this width before sending

const state = { tableId: localStorage.getItem('gf.host.table'), table: null, round: null, camera: null, video: null, sending: false, scanning: false, sent: 0, last: null, deviceId: localStorage.getItem('gf.host.camera') || '', wake: null, timers: [] };

requireStaff(() => (state.tableId ? openTable(state.tableId) : pickTable()));

async function pickTable() {
  stop();
  const tables = await call('GET', '/v1/dealer/tables');
  $('#view').replaceChildren(
    h('h2', {}, 'Which table is this camera over?'),
    h('p', { class: 'muted small' }, 'Put this device above the table so the middle of the felt, where the flop lands, is clearly in view.'),
    tables.length ? h('div', { class: 'grid' }, tables.map((t) => h('button', { class: 'card big', onclick: () => openTable(t.id) }, t.name))) : h('p', { class: 'muted' }, 'No active tables.'),
  );
}

async function openTable(id) {
  state.tableId = id;
  localStorage.setItem('gf.host.table', id);
  try {
    await refresh();
  } catch (e) {
    localStorage.removeItem('gf.host.table');
    return pickTable();
  }
  render();
  await startCamera();
  state.timers.push(setInterval(sendFrame, FRAME_MS), setInterval(() => refresh().then(render).catch(() => {}), 2000));
  keepAwake();
}

async function refresh() {
  const v = await call('GET', `/v1/tables/${state.tableId}`);
  state.table = v.table;
  state.round = v.round;
  state.camera = v.camera;
  maybeScan();
}

// Betting closed and the flop not in yet: read it from the camera.
function maybeScan() {
  if (state.round?.status === 'closed' && state.camera.mode !== 'off' && state.camera.visionReady && !state.scanning && state.scanDone !== scanKey(state.round.id, state.camera.mode, state.round.awaitingConfirmation)) scanLoop(state.round.id);
}

// Reading pauses once a trusted reading waits for a person, for exactly that situation: the same
// hand, the same camera mode and, in auto mode, the same pending entry (in assist mode the camera
// never enters the flop, so a pending entry changes nothing). If any of them changes (a switch from
// assist to auto, or a mismatch that clears the pending entry), reading resumes by itself.
function scanKey(roundId, mode, pending) {
  return mode === 'auto' ? `${roundId}:auto:${!!pending}` : `${roundId}:${mode}`;
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: state.deviceId ? { deviceId: { exact: state.deviceId }, width: { ideal: 1920 } } : { facingMode: 'environment', width: { ideal: 1920 } },
      audio: false,
    });
    state.video.srcObject = stream;
    await state.video.play();
  } catch (e) {
    toast(`Camera not available: ${e.message}. Allow camera access for this page.`, true);
  }
  render();
}

function stop() {
  state.timers.forEach(clearInterval);
  state.timers = [];
  state.video?.srcObject?.getTracks().forEach((t) => t.stop());
}

// The current picture as base64 JPEG, or null before the camera is running.
function capture() {
  const v = state.video;
  if (!v || !v.videoWidth) return null;
  const scale = Math.min(1, MAX_WIDTH / v.videoWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * scale);
  c.height = Math.round(v.videoHeight * scale);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72).split(',')[1];
}

async function sendFrame() {
  if (state.sending || document.visibilityState !== 'visible') return;
  const jpeg = capture();
  if (!jpeg) return;
  state.sending = true;
  try {
    await call('POST', `/v1/host/tables/${state.tableId}/frame`, { jpeg });
    state.sent++;
    const el = $('#sent');
    if (el) el.textContent = `${state.sent} pictures sent`;
  } catch (e) {
    const el = $('#sent');
    if (el) el.textContent = `Sending failed: ${e.message}`;
  } finally {
    state.sending = false;
  }
}

async function scanLoop(roundId) {
  state.scanning = true;
  try {
    while (state.round?.id === roundId && state.round.status === 'closed') {
      const jpeg = capture();
      if (jpeg) {
        try {
          const res = await call('POST', `/v1/host/rounds/${roundId}/scan`, { jpeg });
          state.last = { ...res, at: Date.now() };
          render();
          if (['settled', 'done', 'off'].includes(res.state)) break;
          // A trusted reading is waiting for a person: stop reading (and paying for) more pictures.
          // The key records what the server acted on ('read' only happens in assist mode, and
          // 'awaiting_confirmation' only in auto mode with an entry pending), not what a later
          // refresh sees: a change made meanwhile must still restart reading.
          if (res.state === 'read') { state.scanDone = scanKey(roundId, 'assist'); break; }
          if (res.state === 'awaiting_confirmation') { state.scanDone = scanKey(roundId, 'auto', true); break; }
        } catch (e) {
          state.last = { state: 'error', message: e.message, at: Date.now() };
          render();
          if (['CAMERA_OFF', 'VISION_NOT_CONFIGURED', 'ROUND_FINISHED'].includes(e.code)) break;
        }
      }
      await new Promise((r) => setTimeout(r, SCAN_MS));
      await refresh().catch(() => {});
    }
  } finally {
    state.scanning = false;
  }
  // Anything that changed while this loop ran (mode, pending entry) is picked up now.
  await refresh().catch(() => {});
}

const STATE_TEXT = {
  waiting: 'Looking for the flop…',
  checking: 'Read once, checking with the next picture…',
  read: 'Flop read. The dealer confirms it on the console.',
  awaiting_confirmation: 'Flop entered. Waiting for a person to confirm.',
  settled: 'Flop entered. All bets settled.',
  mismatch: "The camera and the dealer's entry differ. Both must enter the flop again.",
  busy: 'Reading…',
  done: 'Hand finished.',
  off: 'Flop reading was switched off for this table.',
  error: 'The card reader did not answer. Retrying.',
};

function render() {
  if (!state.table) return;
  const r = state.round;
  const c = state.camera;
  if (!state.video) {
    state.video = h('video', { autoplay: true, muted: true, playsinline: true, style: 'width:100%;border-radius:10px;background:#000;aspect-ratio:16/9;object-fit:contain' });
    state.video.muted = true;
  }
  const hand = !r ? 'No hand yet' : r.status === 'open' ? `Hand #${r.number} · betting open` : r.status === 'closed' ? `Hand #${r.number} · no more bets` : `Hand #${r.number} · ${r.status}`;
  const last = state.last && r?.status === 'closed' ? state.last : null;
  $('#view').replaceChildren(h('div', {},
    h('div', { class: 'row', style: 'margin-bottom:12px' },
      h('button', { onclick: pickTable }, '← Tables'),
      h('h1', { style: 'margin:0' }, state.table.name),
      h('span', { class: `pill ${c.live ? 'open' : ''}` }, c.live ? 'Live' : 'Starting'),
    ),
    h('div', { class: 'split' },
      h('div', { class: 'card' }, state.video, h('div', { class: 'muted small', id: 'sent', style: 'margin-top:8px' }, `${state.sent} pictures sent`)),
      h('div', {},
        h('div', { class: 'card' },
          h('div', { class: 'muted small' }, 'Now'),
          h('h2', { style: 'margin:4px 0 12px' }, hand),
          c.mode === 'off' ? h('p', { class: 'small' }, 'Flop reading is off for this table: the dealer enters the flop by hand. The picture still goes to players and the TV.')
            : !c.visionReady ? h('p', { class: 'small', style: 'color:var(--gold)' }, 'Flop reading is not set up on the server (ANTHROPIC_API_KEY). The picture still goes to players and the TV.')
            : h('p', { class: 'small' }, c.mode === 'auto' ? 'When betting closes, the camera reads the flop and enters it.' : 'When betting closes, the camera reads the flop and the dealer confirms it with one tap.'),
          last ? h('div', { class: 'card', style: 'margin:0' },
            h('strong', {}, STATE_TEXT[last.state] ?? last.state),
            last.cards?.length ? h('div', { class: 'small', style: 'margin-top:6px' }, `Read: ${last.cards.join(' ')} · ${Math.round((last.confidence ?? 0) * 100)}% sure`) : null,
            last.note ? h('div', { class: 'muted small' }, last.note) : null,
            last.message ? h('div', { class: 'muted small' }, last.message) : null) : null,
        ),
        h('div', { class: 'card' },
          h('label', { for: 'cam' }, 'Camera', cameraSelect()),
          h('p', { class: 'muted small', style: 'margin:0' }, 'Keep this page open and the device plugged in. It sends a picture every second.'),
        ),
      ),
    ),
  ));
  // The preview is the same element on every redraw; moving it can pause it.
  if (state.video.srcObject && state.video.paused) state.video.play().catch(() => {});
}

// Built once and kept, so a redraw never resets it while someone is choosing.
function cameraSelect() {
  if (state.camSelect) return state.camSelect;
  state.camSelect = h('select', { id: 'cam', onchange: (e) => {
    state.deviceId = e.target.value;
    localStorage.setItem('gf.host.camera', state.deviceId);
    state.video.srcObject?.getTracks().forEach((t) => t.stop());
    startCamera();
  } }, h('option', { value: '' }, 'Back camera (default)'));
  navigator.mediaDevices?.enumerateDevices?.().then((all) => all.filter((d) => d.kind === 'videoinput').forEach((d, i) =>
    state.camSelect.append(h('option', { value: d.deviceId, selected: d.deviceId === state.deviceId }, d.label || `Camera ${i + 1}`)))).catch(() => {});
  return state.camSelect;
}

async function keepAwake() {
  try {
    state.wake = await navigator.wakeLock?.request('screen');
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible') state.wake = await navigator.wakeLock?.request('screen').catch(() => null);
    });
  } catch { /* not supported */ }
}
