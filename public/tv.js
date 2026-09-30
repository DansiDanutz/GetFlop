// Table TV: a big screen for the room. Shows one table live (countdown, odds, how many bets
// each market has, the flop, the winners), the last flops, how often each market hit lately,
// and the leaderboard of the running tournament. Public data only; no login.
//   tv.html?table=<tableId>      (without it: the only table, or a list to pick from)

import { $, api, flop, h, odds, pts, serverNow, stream, syncClock } from './lib.js';

const call = api('gf.tv');
const params = new URLSearchParams(location.search);
let tableId = params.get('table');
let view = null;
let tour = null;
let loading = null;

async function start() {
  if (!tableId) {
    const tables = await call('GET', '/v1/tables');
    if (tables.length !== 1) return pick(tables);
    tableId = tables[0].id;
  }
  // A wrong or retired table link: say so and offer the tables that are live.
  const first = await call('GET', `/v1/tables/${encodeURIComponent(tableId)}`).catch(() => null);
  if (!first || first.table.status !== 'active') return pick(await call('GET', '/v1/tables').catch(() => []), 'That table is not dealing. Pick one:');
  await Promise.all([load(), loadTournament()]);
  stream(`/v1/stream?table=${encodeURIComponent(tableId)}`, (ev, data) => {
    if (ev === 'round.bets' && view?.round?.id === data.id) { view.round.betsByMarket = data.betsByMarket; return render(); }
    if (ev.startsWith('round.') || ev === 'table.changed') return load();
    if (ev === 'tournaments.changed') return loadTournament();
  });
  // Backup for hosts that cut long connections, and the tournament board.
  setInterval(() => load(), 5000);
  setInterval(() => loadTournament(), 20000);
  setInterval(tick, 250);
  keepAwake();
}

function pick(tables, title = 'Which table is this screen for?') {
  $('#app').replaceChildren(h('div', { class: 'picker' },
    h('h1', {}, title),
    tables.length ? tables.map((t) => h('a', { href: `?table=${encodeURIComponent(t.id)}` }, t.name)) : h('p', { class: 'muted' }, 'No active tables yet.')));
}

async function load() {
  if (loading) return loading; // one refresh at a time; callers share it
  loading = (async () => {
    try {
      const v = await call('GET', `/v1/tables/${encodeURIComponent(tableId)}`);
      syncClock(v.serverTime);
      view = v;
      render();
    } catch { /* keep showing the last good state; the next refresh retries */ } finally { loading = null; }
  })();
  return loading;
}

async function loadTournament() {
  try {
    const running = (await call('GET', '/v1/tournaments')).filter((t) => t.status === 'running');
    tour = running.length ? await call('GET', `/v1/tournaments/${running[0].id}`) : null;
    render();
  } catch { /* keep the last one */ }
}

function phase(r) {
  if (!r) return { pill: 'waiting', cls: '', msg: 'Next hand soon', sub: 'Bets open when the dealer starts the hand' };
  if (r.status === 'open' && serverNow() < r.closesAt) return { pill: 'Place your bets', cls: 'open', msg: 'Place your bets', sub: 'On your phone, before the flop is dealt' };
  if (r.status === 'open' || r.status === 'closed') return { pill: 'no more bets', cls: 'closed', msg: r.awaitingConfirmation ? 'Confirming the flop…' : 'No more bets', sub: 'The dealer is dealing the flop' };
  if (r.status === 'void') return { pill: 'hand voided', cls: 'void', msg: 'Hand voided', sub: 'All bets are returned' };
  return { pill: 'result', cls: 'settled', msg: `Hand #${r.number} result`, sub: 'Next hand soon' };
}

function render() {
  if (!view) return;
  const { table, round: r, markets, history } = view;
  const p = phase(r);
  const settled = r?.status === 'settled';
  const wins = new Set(settled ? r.winningMarkets : []);
  const recent = history.slice(0, 20);
  const hits = (id) => recent.filter((x) => x.winningMarkets.includes(id)).length;
  const name = (id) => markets.find((m) => m.id === id)?.name ?? id;

  $('#app').replaceChildren(
    h('header', {},
      h('span', { class: 'brand' }, 'Get', h('b', {}, 'Flop')),
      h('span', { class: 'tname' }, table.name),
      h('span', { class: 'hand' }, r ? `Hand #${r.number}` : ''),
      h('span', { class: `pill ${p.cls}` }, p.pill),
      h('span', { class: 'clock', id: 'clock' }, ''),
    ),
    h('main', {},
      h('section', { class: 'stage' },
        flop(settled ? r.flop : null),
        h('div', { class: 'msg' }, p.msg),
        settled ? h('div', { class: 'winners' }, r.winningMarkets.map((id) => h('span', {}, name(id)))) : h('div', { class: 'sub' }, p.sub),
      ),
      h('section', { class: 'board' }, markets.map((m) => h('div', { class: `m${settled ? (wins.has(m.id) ? ' win' : ' lose') : ''}` },
        h('div', { class: 'o' }, odds(m.oddsX100)),
        h('div', { class: 'n' }, m.name),
        h('div', { class: 'meta' },
          h('span', {}, r?.betsByMarket?.[m.id] ? `${r.betsByMarket[m.id]} bet${r.betsByMarket[m.id] > 1 ? 's' : ''}` : ''),
          h('span', {}, recent.length ? `hit ${hits(m.id)}/${recent.length}` : '')),
      ))),
    ),
    h('footer', {},
      h('div', { class: 'strip' }, recent.slice(0, 12).map((x) => h('div', { class: 'h' }, flop(x.flop, true), `#${x.number}`))),
      h('div', { class: 'side' },
        tour ? h('div', { class: 'lb' },
          h('div', { class: 't' }, `${tour.name} · ${tour.entrants} players`),
          tour.leaderboard.slice(0, 5).map((e) => h('div', { class: 'r' }, h('span', {}, `${e.rank}. ${e.displayName}`), h('span', {}, `${pts(e.points)} pts`)))) : '',
        h('div', { class: 'join' }, h('div', { class: 'muted' }, 'Play on your phone'), h('div', { class: 'u' }, location.host)),
      ),
    ),
    document.fullscreenElement || !document.documentElement.requestFullscreen ? '' : h('button', { id: 'fs', class: 'small', onclick: () => document.documentElement.requestFullscreen().then(render).catch(() => {}) }, 'Full screen'),
  );
  tick();
}

function tick() {
  const el = $('#clock');
  const r = view?.round;
  if (!el) return;
  const left = r?.status === 'open' ? Math.max(0, Math.ceil((r.closesAt - serverNow()) / 1000)) : null;
  el.textContent = left === null ? '' : `${left}s`;
  el.classList.toggle('hurry', left !== null && left <= 5);
  // The window just ran out: switch to "no more bets" without waiting for the server.
  if (left === 0 && r.status === 'open' && !r.closedShown) { r.closedShown = true; render(); }
}

// Keep the TV from dimming while the page is open (where the browser allows it).
async function keepAwake() {
  try {
    let lock = await navigator.wakeLock?.request('screen');
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && lock?.released !== false) lock = await navigator.wakeLock?.request('screen');
    });
  } catch { /* not supported or not allowed */ }
}

start();
