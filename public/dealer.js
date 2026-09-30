import { $, flop, h, money, serverNow, stream, syncClock, toast } from './lib.js';
import { call, requireStaff } from './staff.js';

const RANKS = 'AKQJT98765432'.split('');
const SUITS = [['s', '♠'], ['h', '♥'], ['d', '♦'], ['c', '♣']];
const state = { me: null, tableId: localStorage.getItem('gf.dealer.table'), data: null, picked: [], es: null, risk: null };

requireStaff((me) => { state.me = me; state.tableId ? openTable(state.tableId) : pickTable(); });

async function pickTable() {
  state.es?.close();
  $('#seats').replaceChildren();
  const tables = await call('GET', '/v1/dealer/tables');
  $('#view').replaceChildren(h('h2', {}, 'Choose your table'),
    tables.length ? h('div', { class: 'grid' }, tables.map((t) => h('button', { class: 'card big', onclick: () => openTable(t.id) }, t.name))) : h('p', { class: 'muted' }, 'No active tables. An admin can create one.'));
}

function openTable(id) {
  state.tableId = id;
  localStorage.setItem('gf.dealer.table', id);
  state.es?.close();
  state.es = stream(`/v1/stream?table=${id}`, (ev) => {
    if (ev === 'table.changed') loadSeats();
    if (ev !== 'tables.changed') load();
  });
  buildSeatsPanel();
  load();
}

// ---------- seated players ----------
// Players sitting at this table can see their hole cards, so they must not bet on its flop.
// The panel is built once per table so typing in the search box survives live updates.
function buildSeatsPanel() {
  const results = h('div', {});
  let timer;
  const search = h('input', { placeholder: 'Find a player by name or username', oninput: () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = search.value.trim();
      if (q.length < 2) return results.replaceChildren();
      const found = await call('GET', `/v1/dealer/players?q=${encodeURIComponent(q)}`).catch(() => []);
      results.replaceChildren(found.length ? h('table', { class: 'list' }, found.map((p) => h('tr', {},
        h('td', {}, p.displayName, h('div', { class: 'muted small' }, p.username ?? p.operator)),
        h('td', {}, p.seatedAt === state.tableId ? h('span', { class: 'muted small' }, 'seated here')
          : h('button', { class: 'small', onclick: () => seat(p) }, p.seatedAt ? 'Move here' : 'Seat'))))) : h('p', { class: 'muted small' }, 'No player found.'));
    }, 250);
  } });
  state.seatSearch = { search, results };
  $('#seats').replaceChildren(h('div', { class: 'card' },
    h('h2', {}, 'Seated players'),
    h('p', { class: 'muted small' }, 'Check players in when they sit down. They cannot bet on this table while seated; bets they already have on the current hand are returned.'),
    h('div', { id: 'seat-list', style: 'margin-bottom:12px' }), search, results));
  loadSeats();
}

async function loadSeats() {
  const el = $('#seat-list');
  if (!el) return;
  const seats = await call('GET', `/v1/dealer/tables/${state.tableId}/seats`).catch(() => []);
  el.replaceChildren(seats.length ? h('table', { class: 'list' }, seats.map((p) => h('tr', {},
    h('td', {}, p.displayName, h('div', { class: 'muted small' }, p.username ?? p.operator)),
    h('td', { class: 'small muted' }, `since ${new Date(p.seatedAt).toLocaleTimeString()}`),
    h('td', {}, h('button', { class: 'small', onclick: () => unseat(p) }, 'Left table'))))) : h('p', { class: 'muted small' }, 'Nobody checked in.'));
}

async function seat(p) {
  try {
    const res = await call('POST', `/v1/dealer/tables/${state.tableId}/seats`, { playerId: p.playerId });
    toast(`${res.displayName} seated${res.betsCancelled ? `, ${res.betsCancelled} bet(s) on this hand returned` : ''}`);
    state.seatSearch.search.value = '';
    state.seatSearch.results.replaceChildren();
    loadSeats();
    load();
  } catch (e) { toast(e.message, true); }
}

async function unseat(p) {
  try {
    await call('POST', `/v1/dealer/tables/${state.tableId}/seats/${p.playerId}/remove`);
    loadSeats();
  } catch (e) { toast(e.message, true); }
}

async function load() {
  try {
    state.data = await call('GET', `/v1/tables/${state.tableId}`);
    syncClock(state.data.serverTime);
    const r = state.data.round;
    state.risk = r && (r.status === 'open' || r.status === 'closed') ? await call('GET', `/v1/dealer/rounds/${r.id}/risk`) : null;
    render();
  } catch (e) {
    if (e.code === 'TABLE_NOT_FOUND') { localStorage.removeItem('gf.dealer.table'); return pickTable(); }
    toast(e.message, true);
  }
}

async function act(fn, ok) {
  try { await fn(); if (ok) toast(ok); await load(); } catch (e) { toast(e.message, true); }
}

function render() {
  const { table } = state.data;
  const last = state.data.round;
  const round = last && (last.status === 'open' || last.status === 'closed') ? last : null;
  const bets = round ? Object.values(round.betsByMarket).reduce((a, b) => a + b, 0) : 0;
  const status = !round ? 'No hand in progress' : round.status === 'open' ? 'Betting is OPEN' : round.awaitingConfirmation ? 'Waiting for 2nd confirmation' : 'Betting closed · enter the flop';

  $('#view').replaceChildren(h('div', {},
    h('div', { class: 'row', style: 'margin-bottom:12px' }, h('button', { onclick: pickTable }, '← Tables'), h('h1', { style: 'margin:0' }, table.name),
      table.dualConfirm ? h('span', { class: 'pill' }, 'dual confirm') : null,
      h('a', { class: 'btn small right', href: `tv.html?table=${encodeURIComponent(table.id)}`, target: '_blank', title: 'Open on the TV in the room' }, 'TV screen')),
    h('div', { class: 'card row' },
      h('div', {}, h('div', { class: 'muted small' }, round ? `Hand #${round.number}` : ''), h('h2', { style: 'margin:0' }, status)),
      h('div', { class: 'right countdown', id: 'cd' }),
      !round && last?.flop ? h('div', { class: 'right' }, h('div', { class: 'muted small' }, `Last: hand #${last.number}`), flop(last.flop, true)) : null,
    ),
    h('div', { class: 'card muted small' }, `${bets} bets`,
      state.risk ? Object.entries(state.risk).map(([c, r]) => ` · ${c}: staked ${money(r.stakes)}, worst case ${money(Math.max(0, r.worstCase))}`) : ''),
    !round ? h('button', { class: 'primary big', onclick: () => act(() => call('POST', `/v1/dealer/tables/${table.id}/rounds`), 'Betting open') }, 'NEW HAND · open betting') : null,
    round?.status === 'open' ? h('button', { class: 'primary big', onclick: () => act(() => call('POST', `/v1/dealer/rounds/${round.id}/close`), 'No more bets') }, 'NO MORE BETS') : null,
    round?.status === 'open' ? h('p', { class: 'muted small' }, 'Press before the burn card. Betting also closes by itself when the timer ends.') : null,
    round?.status === 'closed' ? flopPicker(round) : null,
    round ? h('div', { style: 'margin-top:24px' }, h('button', { class: 'danger', disabled: state.me.role === 'dealer', title: state.me.role === 'dealer' ? 'A supervisor must void' : '', onclick: () => voidRound(round) }, 'Void hand (misdeal)')) : null,
  ));
  tick();
}

function flopPicker(round) {
  const picked = state.picked;
  return h('div', { class: 'card' },
    h('div', { class: 'row', style: 'margin-bottom:12px' }, h('h2', { style: 'margin:0' }, 'Tap the 3 flop cards'), h('span', { class: 'right' }, flop([picked[0], picked[1], picked[2]]))),
    h('div', { class: 'cardpick' }, SUITS.map(([s, sym]) => RANKS.map((r) => {
      const c = r + s;
      const on = picked.includes(c);
      return h('button', { class: `${s === 'h' || s === 'd' ? 'red' : ''}${on ? ' sel' : ''}`, disabled: !on && picked.length >= 3,
        onclick: () => { state.picked = on ? picked.filter((x) => x !== c) : [...picked, c]; render(); } }, `${r === 'T' ? '10' : r}${sym}`);
    }))),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { onclick: () => { state.picked = []; render(); } }, 'Clear'),
      h('button', { class: 'primary right', disabled: picked.length !== 3, onclick: () => submitFlop(round) }, round.awaitingConfirmation ? 'CONFIRM FLOP (2nd person)' : 'CONFIRM FLOP')),
  );
}

async function submitFlop(round) {
  try {
    const res = await call('POST', `/v1/dealer/rounds/${round.id}/flop`, { cards: state.picked });
    state.picked = [];
    toast(res.settled ? 'Flop settled. All bets paid.' : 'Entered. A second staff member must confirm the same flop.');
  } catch (e) {
    if (e.code === 'FLOP_MISMATCH') state.picked = [];
    toast(e.message, true);
  }
  load();
}

function voidRound(round) {
  const reason = prompt('Reason for voiding (all stakes are returned):', 'Misdeal');
  if (reason) act(() => call('POST', `/v1/dealer/rounds/${round.id}/void`, { reason }), 'Hand voided, stakes returned');
}

function tick() {
  const el = $('#cd');
  const r = state.data?.round;
  if (!el) return;
  el.textContent = r?.status === 'open' ? `${Math.max(0, Math.ceil((r.closesAt - serverNow()) / 1000))}s` : '';
}
setInterval(tick, 250);
// Backup for the live stream: refresh the table console now and then.
setInterval(() => { if (state.tableId && state.data && document.visibilityState === 'visible') load(); }, 4000);
