import { $, api, flop, h, money, odds, pts, serverNow, stream, syncClock, time, toast } from './lib.js';

// A launch link from a partner carries the session in the URL hash: #token=...&table=...
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get('token')) {
  localStorage.setItem('gf.player', hash.get('token'));
  history.replaceState(null, '', location.pathname);
}
const call = api('gf.player');
const state = { me: null, tab: 'tables', tableId: hash.get('table'), tournamentId: null, playFor: 'cash', chip: 0, es: null, data: null };

async function loadMe() {
  try {
    state.me = await call('GET', '/v1/me');
  } catch {
    localStorage.removeItem('gf.player');
    location.href = 'index.html';
    return;
  }
  $('#who').textContent = state.me.displayName;

  $('#balance').textContent = state.me.balance === null ? '' : money(state.me.balance, state.me.currency);
}

$('#logout').onclick = async () => {
  await call('POST', '/v1/auth/logout').catch(() => {});
  localStorage.removeItem('gf.player');
  location.href = 'index.html';
};
document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => go(b.dataset.tab)));
$('#me').onclick = () => go('account');

// The table's video lives outside #view so re-rendering the table (live updates, the backup
// refresh) never reloads the player. It is only replaced when the stream URL changes.
// A table with a video stream shows it above the table (kept outside #view so redraws never reload
// it). Without one, the table shows the live picture from its camera host inside the table view.
function syncStream() {
  const here = state.tableId && state.data?.table?.id === state.tableId;
  const url = (here && state.data.table.streamUrl) || '';
  const el = $('#stream');
  if (el.dataset.url === url) return;
  el.dataset.url = url;
  el.replaceChildren(url ? h('div', { class: 'card' }, h('iframe', { src: url, style: 'width:100%;aspect-ratio:16/9;border:0;border-radius:8px', allow: 'autoplay; fullscreen' })) : '');
}

// The camera picture: one element kept across redraws, given a new picture about every second
// (swapped in only once it has loaded, so it never flashes empty).
function cameraView() {
  const d = state.data;
  if (!d?.camera?.live || d.table.streamUrl) return null;
  const src = () => `/v1/tables/${d.table.id}/camera.jpg?t=${Date.now()}`;
  if (!state.cam || state.cam.dataset.table !== d.table.id) {
    const img = h('img', { src: src(), alt: 'Live picture of the table', class: 'live-cam' });
    state.cam = h('div', { class: 'card cam-card', 'data-table': d.table.id }, h('span', { class: 'pill open live-tag' }, '● Live'), img);
    clearInterval(state.camTimer);
    state.camTimer = setInterval(() => {
      if (document.visibilityState !== 'visible' || !state.cam?.isConnected) return;
      const next = new Image();
      next.onload = () => { img.src = next.src; };
      next.src = `/v1/tables/${state.cam.dataset.table}/camera.jpg?t=${Date.now()}`;
    }, 1000);
  }
  return state.cam;
}

function go(tab, extra = {}) {
  Object.assign(state, { tab, tableId: null, tournamentId: null }, extra);
  tableVisit++; // responses requested before this navigation are never shown
  syncStream();
  const lit = tab === 'safer' ? 'account' : tab; // limits live under Account
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === lit));
  listen();
  render();
}

// One live connection: the lobby plus the table on screen.
function listen() {
  state.es?.close();
  const url = state.tableId ? `/v1/stream?table=${state.tableId}` : state.tournamentId ? `/v1/tournaments/${state.tournamentId}/stream` : '/v1/stream';
  state.es = stream(url, (ev, data) => {
    if (ev === 'round.settled') {
      loadMe();
      if (state.tableId) {
        showResult(data).catch(() => {});
        return loadTable().catch(() => {});
      }
    }
    if (ev === 'table.changed') return loadMe().then(render);
    if (ev === 'round.bets' && state.data?.round?.id === data.id) {
      state.data.round.betsByMarket = data.betsByMarket;
      return renderTable();
    }
    render();
  });
}

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  try {
    if (state.tableId) await loadTable();
    else if (state.tournamentId) await loadTournament();
    else if (state.tab === 'tables') await loadLobby();
    else if (state.tab === 'tournaments') await loadTournaments();
    else if (state.tab === 'safer') await loadSafer();
    else if (state.tab === 'account') await loadAccount();
    else await loadHistory();
  } catch (e) {
    if (seq === renderSeq) toast(e.message, true);
  }
}

// ---------- lobby ----------
// Every active table live on one screen. The player picks a chip once and bets on any table
// straight from its tile (the four most played markets); "All markets" opens the table itself.
const FEATURED = ['RAINBOW', 'TWO_TONE', 'PAIRED', 'HAS_ACE'];
const lobby = { tables: [], tours: [], mine: new Map(), rounds: new Map(), chip: 2, loading: null, synced: false };

function lobbyChips() {
  if (state.playFor === 'cash') return [100, 500, 1000, 2500, 10_000];
  const r = lobby.tours.find((t) => t.id === state.playFor)?.rules;
  return r ? [...new Set([r.minStake, 25, 50, 100, 250].filter((v) => v >= r.minStake && v <= r.maxStake))] : [10];
}

function loadLobby() {
  lobby.loading ??= (async () => {
    try {
      const visit = tableVisit;
      const [tables, tours, cash, health] = await Promise.all([
        call('GET', '/v1/tables'), myRunningTournaments(), call('GET', '/v1/me/bets'), lobby.synced ? null : call('GET', '/v1/health'),
      ]);
      if (health) { syncClock(health.time); lobby.synced = true; }
      if (visit !== tableVisit || state.tableId || state.tab !== 'tables') return;
      for (const t of tables) for (const m of t.markets) marketNames[m.id] = m.name;
      // A hand the player watched here just finished: tell them how their bets did.
      for (const t of tables) {
        const prev = lobby.rounds.get(t.id);
        if (prev && t.round && prev.id === t.round.id && prev.status !== 'settled' && t.round.status === 'settled') showResult(t.round).catch(() => {});
        lobby.rounds.set(t.id, t.round ? { id: t.round.id, status: t.round.status } : null);
      }
      if (state.playFor !== 'cash' && !tours.find((t) => t.id === state.playFor)) state.playFor = 'cash';
      const bets = state.playFor === 'cash' ? cash : tours.find((t) => t.id === state.playFor)?.me?.bets ?? [];
      const mine = new Map();
      for (const b of bets) (mine.get(b.roundId) ?? mine.set(b.roundId, new Set()).get(b.roundId)).add(b.marketId);
      Object.assign(lobby, { tables, tours, mine });
      renderLobby();
    } finally {
      lobby.loading = null;
    }
  })();
  return lobby.loading;
}

function renderLobby() {
  if (state.tableId || state.tab !== 'tables') return;
  const chips = lobbyChips();
  lobby.chip = Math.min(lobby.chip, chips.length - 1);
  const stake = chips[lobby.chip];
  $('#view').replaceChildren(
    h('div', { class: 'card lobby-bar' },
      h('div', { class: 'row' },
        h('span', { class: 'muted small' }, 'Playing for'),
        h('select', { style: 'width:auto', onchange: (e) => { state.playFor = e.target.value; loadLobby(); } },
          h('option', { value: 'cash', selected: state.playFor === 'cash' }, `Cash · ${state.me.balance === null ? '' : money(state.me.balance, state.me.currency)}`),
          lobby.tours.map((t) => h('option', { value: t.id, selected: state.playFor === t.id }, `${t.name} · ${pts(t.me.points)} pts`)),
        ),
      ),
      h('div', { class: 'chips' }, chips.map((v, i) => h('button', { class: `chip c${i % 5}${i === lobby.chip ? ' sel' : ''}`, title: fmtStake(v), 'aria-label': `Chip ${fmtStake(v)}`, onclick: () => { lobby.chip = i; renderLobby(); } }, state.playFor === 'cash' ? short(v / 100) : short(v)))),
      h('p', { class: 'muted small', style: 'margin:0' }, `Your chip: ${fmtStake(stake)}. Tap a market on any open table to bet it. Odds include your stake.`),
    ),
    lobby.tables.length ? h('div', { class: 'lobby' }, lobby.tables.map((t) => tile(t, stake))) : h('div', { class: 'card muted' }, 'No tables are dealing right now. Check back soon.'),
  );
  tickCountdown();
}

function tile(t, stake) {
  const r = t.round;
  const live = r?.status === 'open' && serverNow() < r.closesAt;
  const settled = r?.status === 'settled';
  const seated = state.me.seatedAt === t.id;
  const wins = new Set(settled ? r.winningMarkets : []);
  const mine = lobby.mine.get(r?.id) ?? new Set();
  const inRange = state.playFor !== 'cash' || (stake >= t.minStake && stake <= t.maxStake);
  const [label, cls] = !r ? ['Waiting for the dealer', ''] : live ? ['Place your bets', 'open'] : settled ? ['Result', 'settled']
    : r.status === 'void' ? ['Hand voided', 'void'] : ['No more bets', 'closed'];
  const betCount = r ? Object.values(r.betsByMarket ?? {}).reduce((a, b) => a + b, 0) : 0;
  return h('article', { class: `card tile${live ? ' live' : ''}` },
    h('div', { class: 'row' },
      h('strong', { class: 'tname' }, t.name),
      t.camera?.live ? h('span', { class: 'pill open', title: 'Camera live' }, '● Live') : null,
      h('span', { class: `pill ${cls}` }, label),
      h('span', { class: 'right countdown tile-cd', 'data-closes': live ? String(r.closesAt) : '' }, ''),
    ),
    h('div', { class: 'muted small' }, [r ? `Hand #${r.number}` : 'No hand yet', `stakes ${money(t.minStake)}–${money(t.maxStake)}`, betCount ? `${betCount} bet${betCount > 1 ? 's' : ''} this hand` : ''].filter(Boolean).join(' · ')),
    t.camera?.live ? h('img', { class: 'tile-cam', src: `/v1/tables/${t.id}/camera.jpg?t=${t.camera.frameAt}`, alt: `Live picture of ${t.name}`, loading: 'lazy' }) : null,
    h('div', { class: 'tile-flop' },
      flop(settled ? r.flop : null),
      t.recent.length ? h('div', { class: 'recent' }, h('span', { class: 'muted small' }, 'Last flops'), t.recent.slice(0, 3).map((x) => flop(x.flop, true))) : null,
    ),
    seated ? h('p', { class: 'small', style: 'color:var(--gold);margin:0' }, "You're checked in at this table, so you can't bet on its flop.") : null,
    h('div', { class: 'quick' }, FEATURED.map((id) => {
      const m = t.markets.find((x) => x.id === id);
      const n = r?.betsByMarket?.[id];
      return h('button', {
        class: `mkt${wins.has(id) ? ' win' : ''}${mine.has(id) ? ' mine' : ''}`, disabled: !live || seated || !inRange,
        onclick: () => lobbyBet(t, m, stake),
      }, n ? h('div', { class: 'count' }, `${n} bet${n > 1 ? 's' : ''}`) : '', h('div', { class: 'odds' }, odds(m.oddsX100)), h('div', { class: 'name' }, m.name));
    })),
    h('div', { class: 'row' },
      !inRange && live ? h('span', { class: 'muted small' }, `Your chip is outside this table's limits`) : null,
      h('button', { class: 'right', onclick: () => go('tables', { tableId: t.id }) }, `All ${t.markets.length} markets →`),
    ),
  );
}

async function lobbyBet(t, m, stake) {
  const clientRef = crypto.randomUUID();
  try {
    if (state.playFor === 'cash') await call('POST', '/v1/bets', { roundId: t.round.id, marketId: m.id, stake, clientRef });
    else await call('POST', `/v1/tournaments/${state.playFor}/bets`, { roundId: t.round.id, marketId: m.id, stake, clientRef });
    toast(`${fmtStake(stake)} on ${m.name} @ ${odds(m.oddsX100)} · ${t.name}`);
    await loadMe();
    await loadLobby();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- table ----------
// Refreshes can overlap (live updates, the backup timer, the player switching table or wallet).
// A response is shown only if the player is still on the same visit of the same table with the
// same betting wallet (cash vs tournament points) it was requested for, and nothing newer has
// been shown yet. So an
// older response never puts back an old table, video or wallet, and a slow connection still
// shows every response that is the newest so far.
let tableLoadSeq = 0;
let tableShownSeq = 0;
let tableLoadsInFlight = 0;
let lastTableLoadAt = 0;
let tableVisit = 0;
async function loadTable() {
  const seq = ++tableLoadSeq;
  const visit = tableVisit;
  const tableId = state.tableId;
  const wanted = state.playFor;
  const stillWanted = () => tableVisit === visit && state.tableId === tableId && state.playFor === wanted && seq > tableShownSeq;
  tableLoadsInFlight++;
  lastTableLoadAt = Date.now();
  try {
    const [view, tours] = await Promise.all([call('GET', `/v1/tables/${tableId}`), myRunningTournaments()]);
    if (!stillWanted()) return;
    const playFor = wanted !== 'cash' && !tours.find((t) => t.id === wanted) ? 'cash' : wanted;
    const myBets = playFor === 'cash'
      ? (await call('GET', '/v1/me/bets')).filter((b) => b.roundId === view.round?.id)
      : (tours.find((t) => t.id === playFor)?.me?.bets ?? []).filter((b) => b.roundId === view.round?.id);
    if (!stillWanted()) return;
    tableShownSeq = seq;
    syncClock(view.serverTime);
    Object.assign(state, { data: view, tours, playFor, myBets });
    renderTable();
  } finally {
    tableLoadsInFlight--;
  }
}

async function myRunningTournaments() {
  const list = (await call('GET', '/v1/tournaments')).filter((t) => t.status === 'running');
  const full = await Promise.all(list.map((t) => call('GET', `/v1/tournaments/${t.id}`)));
  return full.filter((t) => t.me);
}

function chipValues() {
  if (state.playFor === 'cash') {
    const t = state.data.table;
    return [1, 5, 10, 25, 100].map((m) => t.minStake * m).filter((v) => v <= t.maxStake);
  }
  const r = state.tours.find((t) => t.id === state.playFor).rules;
  return [...new Set([r.minStake, 25, 50, 100, 250].filter((v) => v >= r.minStake && v <= r.maxStake))];
}
const fmtStake = (v) => (state.playFor === 'cash' ? money(v) : `${pts(v)} pts`);

function renderTable() {
  syncStream();
  const { table, round, markets, history } = state.data;
  const finished = round && (round.status === 'settled' || round.status === 'void');
  const chips = chipValues();
  state.chip = Math.min(state.chip, chips.length - 1);
  const seatedHere = state.me.seatedAt === table.id;
  const live = round?.status === 'open' && serverNow() < round.closesAt;
  const open = live && !seatedHere;
  const mine = new Set(state.myBets.map((b) => b.marketId));
  const wins = new Set(round?.winningMarkets ?? []);
  const tour = state.tours.find((t) => t.id === state.playFor);

  $('#view').replaceChildren(
    h('div', { class: 'row', style: 'margin-bottom:12px' }, h('button', { onclick: () => go('tables') }, '← Tables'), h('h1', { style: 'margin:0' }, table.name)),
    seatedHere ? h('div', { class: 'card', style: 'border-color:var(--gold)' }, "You're checked in at this table, so you can't bet on its flop. Pick another table to bet.") : '',
    h('div', { class: 'split' },
      h('div', {},
        h('div', { class: 'card row' },
          h('div', {}, h('div', { class: 'muted small' }, !round ? 'Waiting for the first hand' : finished ? `Hand #${round.number} · next hand soon` : `Hand #${round.number}`),
            h('span', { class: `pill ${round?.status ?? ''}` }, !round ? 'waiting' : finished ? (round.status === 'void' ? 'hand voided' : 'result') : live ? 'Place your bets' : round.status === 'open' ? 'closing' : round.awaitingConfirmation ? 'confirming flop' : 'no more bets')),
          h('div', { class: 'right countdown', id: 'cd' }, ''),
          h('div', {}, flop(round?.flop)),
        ),
        cameraView(),
        h('div', { class: 'card' },
          h('div', { class: 'row', style: 'margin-bottom:12px' },
            h('span', { class: 'muted small' }, 'Playing for'),
            h('select', { style: 'width:auto', onchange: (e) => { state.playFor = e.target.value; loadTable(); } },
              h('option', { value: 'cash', selected: state.playFor === 'cash' }, `Cash · ${state.me.balance === null ? '' : money(state.me.balance, state.me.currency)}`),
              state.tours.map((t) => h('option', { value: t.id, selected: state.playFor === t.id }, `${t.name} · ${pts(t.me.points)} pts · ${t.rules.maxBets - t.me.betsUsed} bets left`)),
            ),
          ),
          h('div', { class: 'chips', style: 'margin-bottom:14px' }, chips.map((v, i) => h('button', { class: `chip c${i % 5}${i === state.chip ? ' sel' : ''}`, title: fmtStake(v), onclick: () => { state.chip = i; renderTable(); } }, state.playFor === 'cash' ? short(v / 100) : short(v)))),
          h('div', { class: 'markets' }, markets.map((m) => h('button', {
            class: `mkt${wins.has(m.id) ? ' win' : ''}${mine.has(m.id) ? ' mine' : ''}`, disabled: !open,
            onclick: () => bet(m, chips[state.chip]),
          }, h('div', { class: 'count' }, round?.betsByMarket?.[m.id] ? `${round.betsByMarket[m.id]} bet${round.betsByMarket[m.id] > 1 ? 's' : ''}` : ''), h('div', { class: 'odds' }, odds(m.oddsX100)), h('div', { class: 'name' }, m.name)))),
          h('p', { class: 'muted small' }, `Tap a chip, then a market. Odds include your stake. ${state.playFor === 'cash' ? `Limits ${money(table.minStake)}–${money(table.maxStake)} per bet.` : tour ? `Tournament: ${tour.rules.minStake}–${tour.rules.maxStake} pts per bet.` : ''}`),
        ),
      ),
      h('div', {},
        h('div', { class: 'card' }, h('h3', {}, finished ? `My bets · hand #${round.number}` : 'My bets this hand'),
          state.myBets.length ? h('table', { class: 'list' }, state.myBets.map((b) => h('tr', {}, h('td', {}, marketName(b.marketId)), h('td', { class: 'num' }, fmtStake(b.stake)), h('td', { class: 'num' }, `@${odds(b.oddsX100)}`), h('td', {}, h('span', { class: `pill ${b.status}` }, b.status)))))
            : h('div', { class: 'muted small' }, 'None yet.')),
        h('div', { class: 'card' }, h('h3', {}, 'Last flops'),
          history.length ? history.map((x) => h('div', { class: 'row', style: 'margin-bottom:6px' }, h('span', { class: 'muted small', style: 'width:48px' }, `#${x.number}`), flop(x.flop, true))) : h('div', { class: 'muted small' }, 'No hands yet.')),
      ),
    ),
  );
  tickCountdown();
}

const short = (n) => (n >= 1000 ? `${n / 1000}k` : String(n));
let marketNames = {}; // id -> name, loaded once for screens without a table
const marketName = (id) => state.data?.markets.find((m) => m.id === id)?.name ?? marketNames[id] ?? id;

async function bet(market, stake) {
  const round = state.data.round;
  const clientRef = crypto.randomUUID();
  try {
    if (state.playFor === 'cash') await call('POST', '/v1/bets', { roundId: round.id, marketId: market.id, stake, clientRef });
    else await call('POST', `/v1/tournaments/${state.playFor}/bets`, { roundId: round.id, marketId: market.id, stake, clientRef });
    toast(`${fmtStake(stake)} on ${market.name} @ ${odds(market.oddsX100)}`);
    await loadMe();
    await loadTable();
  } catch (e) {
    toast(e.message, true);
  }
}

async function showResult(round) {
  // Check every wallet the player used this hand, cash and each tournament, from fresh data so
  // the result does not depend on which table refresh was shown last.
  const [cashBets, tours] = await Promise.all([call('GET', '/v1/me/bets'), myRunningTournaments()]);
  const cash = cashBets.filter((b) => b.roundId === round.id);
  const tour = tours.flatMap((t) => (t.me?.bets ?? []).filter((b) => b.roundId === round.id));
  const mine = [...cash, ...tour];
  if (!mine.length) return;
  const won = mine.filter((b) => round.winningMarkets.includes(b.marketId));
  toast(won.length ? `Winner! ${won.map((b) => marketName(b.marketId)).join(', ')}` : 'No luck this flop.');
}

function tickCountdown() {
  for (const c of document.querySelectorAll('.tile-cd[data-closes]')) {
    if (!c.dataset.closes) continue;
    const left = Math.max(0, Math.ceil((Number(c.dataset.closes) - serverNow()) / 1000));
    c.textContent = `${left}s`;
    c.classList.toggle('hurry', left <= 5);
    if (left === 0 && !c.dataset.done) { c.dataset.done = '1'; renderLobby(); } // betting just closed on this table
  }
  const el = $('#cd');
  const r = state.data?.round;
  if (!el || !r) return;
  const left = r.status === 'open' ? Math.max(0, Math.ceil((r.closesAt - serverNow()) / 1000)) : 0;
  el.textContent = r.status === 'open' ? `${left}s` : '';
  if (r.status === 'open' && left === 0 && !state.closedShown) { state.closedShown = true; renderTable(); }
  if (left > 0) state.closedShown = false;
}
setInterval(tickCountdown, 250);
// Backup for the live stream (some hosts cut long connections): refresh the open table now and then.
const STALLED_MS = 12_000;
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  // Don't pile up on a slow connection: wait for the pending refresh, but not for a stalled one.
  if (state.tableId) { if (!tableLoadsInFlight || Date.now() - lastTableLoadAt > STALLED_MS) loadTable().catch(() => {}); }
  else if (state.tournamentId) render();
  else if (state.tab === 'tables') loadLobby().catch(() => {}); // bet counts and hands on every table
}, 4000);
setInterval(() => { if (document.visibilityState === 'visible') loadMe(); }, 15000);

// ---------- tournaments ----------
async function loadTournaments() {
  const list = await call('GET', '/v1/tournaments?all=1');
  $('#view').replaceChildren(
    list.length ? h('div', { class: 'grid' }, list.map((t) => h('button', { class: 'card', style: 'text-align:left', onclick: () => go('tournaments', { tournamentId: t.id }) },
      h('div', { class: 'row' }, h('strong', {}, t.name), h('span', { class: `pill right ${t.status}` }, t.status)),
      h('div', { class: 'muted small', style: 'margin-top:8px' }, `${t.strategyName} · ${t.entrants} players · prize pool ${money(t.prizePool, t.currency)}`),
      h('div', { class: 'muted small' }, `Buy-in ${t.buyIn ? money(t.buyIn, t.currency) : 'FREE'} · ends ${time(t.endsAt)}`),
    ))) : h('div', { class: 'card muted' }, 'No tournaments yet.'),
  );
}

async function loadTournament() {
  const t = await call('GET', `/v1/tournaments/${state.tournamentId}`);
  const canJoin = !t.me && (t.status === 'scheduled' || (t.status === 'running' && t.rules.lateJoin !== false));
  $('#view').replaceChildren(
    h('div', { class: 'row', style: 'margin-bottom:12px' }, h('button', { onclick: () => go('tournaments') }, '← Tournaments'), h('h1', { style: 'margin:0' }, t.name), h('span', { class: `pill ${t.status}` }, t.status)),
    h('div', { class: 'split' },
      h('div', { class: 'card' }, h('h3', {}, `Leaderboard · ${t.entrants} players · top ${t.paidPlaces} paid`),
        h('table', { class: 'list' },
          h('tr', {}, h('th', {}, '#'), h('th', {}, 'Player'), h('th', { class: 'num' }, 'Points'), h('th', { class: 'num' }, 'Bets'), h('th', { class: 'num' }, 'Prize')),
          t.leaderboard.map((r) => h('tr', { style: r.playerId === state.me.playerId ? 'color:var(--gold)' : '' },
            h('td', {}, r.rank), h('td', {}, r.displayName, r.qualified ? '' : h('span', { class: 'muted small' }, ' (not qualified)')),
            h('td', { class: 'num' }, pts(r.points)), h('td', { class: 'num' }, r.betsUsed), h('td', { class: 'num' }, r.prize ? money(r.prize, t.currency) : ''))),
        )),
      h('div', {},
        h('div', { class: 'card' },
          h('div', { class: 'muted small' }, 'Prize pool'), h('div', { class: 'countdown' }, money(t.prizePool, t.currency)),
          h('div', { class: 'muted small', style: 'margin:8px 0' }, `${time(t.startsAt)} → ${time(t.endsAt)}`),
          t.me ? h('div', {},
            h('p', {}, `You: #${t.me.rank} of ${t.me.of} · ${pts(t.me.points)} pts · ${t.me.betsUsed}/${t.rules.maxBets} bets`, t.me.prize ? ` · currently ${money(t.me.prize, t.currency)}` : ''),
            t.status === 'running' ? h('button', { class: 'primary big', onclick: () => go('tables') }, 'Pick a table and play') : null)
            : canJoin ? h('button', { class: 'primary big', onclick: () => join(t) }, t.buyIn ? `Join for ${money(t.buyIn, t.currency)}` : 'Join free') : null,
        ),
        h('div', { class: 'card' }, h('h3', {}, 'How it works'), h('ul', { style: 'padding-left:18px;margin:0' }, t.howItWorks.map((x) => h('li', {}, x)))),
      ),
    ),
  );
}

async function join(t) {
  try {
    await call('POST', `/v1/tournaments/${t.id}/join`);
    toast(`You're in! ${t.rules.startingPoints} points to play.`);
    await loadMe();
    render();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- history ----------
async function loadHistory() {
  const [bets, markets] = await Promise.all([call('GET', '/v1/me/bets'), Object.keys(marketNames).length ? null : call('GET', '/v1/markets')]);
  if (markets) marketNames = Object.fromEntries(markets.map((m) => [m.id, m.name]));
  // Four columns so it fits a phone: what/where, the bet, the flop, the outcome.
  $('#view').replaceChildren(h('div', { class: 'card' },
    bets.length ? h('table', { class: 'list' },
      h('tr', {}, h('th', {}, 'Hand'), h('th', {}, 'Bet'), h('th', {}, 'Flop'), h('th', { class: 'num' }, 'Result')),
      bets.map((b) => h('tr', {},
        h('td', {}, `${b.tableName} #${b.roundNumber}`, h('div', { class: 'muted small' }, time(b.placedAt))),
        h('td', {}, marketName(b.marketId), h('div', { class: 'muted small' }, `${money(b.stake, b.currency)} @ ${odds(b.oddsX100)}`)),
        h('td', {}, b.flop ? flop(b.flop, true) : ''),
        h('td', { class: 'num' }, h('span', { class: `pill ${b.status}` }, b.status), b.payout ? h('div', { class: 'small' }, money(b.payout, b.currency)) : ''))),
    ) : h('div', { class: 'muted' }, 'No bets yet.')));
}

// ---------- account ----------
const KIND_SIGN = (n) => (n > 0 ? `+${money(n)}` : money(n));

async function loadAccount() {
  const a = await call('GET', '/v1/me/account');
  const c = a.currency;
  const st = a.stats;
  const p = a.profile;
  const direct = p.accountType === 'direct';
  const stat = (k, v, cls = '') => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: `v ${cls}` }, v));
  const form = (fields, label, submit) => h('form', { onsubmit: async (e) => {
    e.preventDefault();
    try { await submit(Object.fromEntries(new FormData(e.target))); e.target.reset(); } catch (err) { toast(err.message, true); }
  } }, fields, h('button', { class: 'primary' }, label));
  const lim = a.limits;
  const limText = (k, label) => `${label}: ${lim[k] === null ? 'no limit' : `${money(lim[k], c)} (used ${money(lim.used[k], c)})`}`;

  $('#view').replaceChildren(h('div', { class: 'split' },
    h('div', {},
      h('div', { class: 'card' },
        h('div', { class: 'row', style: 'gap:14px;margin-bottom:16px' },
          h('div', { class: 'avatar', 'aria-hidden': 'true' }, p.displayName.trim()[0]?.toUpperCase() ?? '?'),
          h('div', {},
            h('h2', { style: 'margin:0' }, p.displayName),
            h('div', { class: 'muted small' }, [p.username ? `@${p.username}` : null, direct ? 'GetFlop account' : `Plays through ${p.via}`, `member since ${new Date(p.memberSince).toLocaleDateString()}`].filter(Boolean).join(' · ')),
          ),
        ),
        h('div', { class: 'stats' },
          stat('Balance', a.balance === null ? '—' : money(a.balance, c), 'big'),
          stat('In play', money(st.inPlay, c)),
          stat('Bets placed', String(st.bets)),
          stat('Bets won', st.settled ? `${st.won} of ${st.settled}` : '0'),
          stat('Net result', KIND_SIGN(st.net), st.net > 0 ? 'pos' : st.net < 0 ? 'neg' : ''),
          stat('Biggest win', money(st.biggestWin, c)),
        ),
        a.seatedAt ? h('p', { class: 'small', style: 'color:var(--gold);margin:12px 0 0' }, "You're checked in at a table in the club.") : null,
      ),
      h('div', { class: 'card' },
        h('h3', {}, 'Statement'),
        !a.statement ? h('p', { class: 'muted small' }, `Your money is held by ${p.via}. See your statement there.`)
          : a.statement.length ? h('table', { class: 'list' },
            h('tr', {}, h('th', {}, 'When'), h('th', {}, 'What'), h('th', { class: 'num' }, 'Amount'), h('th', { class: 'num' }, 'Balance')),
            a.statement.map((l) => h('tr', {},
              h('td', { class: 'small muted' }, time(l.at)),
              h('td', {}, l.text),
              h('td', { class: `num ${l.amount > 0 ? 'pos' : ''}` }, KIND_SIGN(l.amount)),
              h('td', { class: 'num' }, money(l.balanceAfter)))))
          : h('p', { class: 'muted small' }, 'No money movements yet. Deposits at the desk show up here.'),
      ),
    ),
    h('div', {},
      h('div', { class: 'card' },
        h('h3', {}, 'Tournaments'),
        a.tournaments.length ? h('table', { class: 'list' }, a.tournaments.map((t) => h('tr', { class: 'clickable', onclick: () => go('tournaments', { tournamentId: t.id }) },
          h('td', {}, t.name, h('div', { class: 'muted small' }, t.status === 'finished' ? (t.rank ? `Finished #${t.rank}` : 'Finished') : `${pts(t.points)} pts · ${t.betsUsed} bets`)),
          h('td', { class: 'num' }, t.prize ? h('span', { class: 'pos' }, money(t.prize, t.currency)) : h('span', { class: `pill ${t.status}` }, t.status)))))
          : h('p', { class: 'muted small' }, 'Not in any tournament yet.'),
      ),
      lim ? h('div', { class: 'card' },
        h('h3', {}, 'Limits and breaks'),
        lim.excludedUntil ? h('p', {}, `On a break until ${time(lim.excludedUntil)}.`) : null,
        h('p', { class: 'small', style: 'margin:0 0 4px' }, limText('lossDay', 'Loss per 24 hours')),
        h('p', { class: 'small', style: 'margin:0 0 4px' }, limText('lossWeek', 'Loss per 7 days')),
        h('p', { class: 'small', style: 'margin:0 0 12px' }, limText('depositWeek', 'Deposits per 7 days')),
        h('button', { onclick: () => go('safer') }, 'Set limits or take a break'),
      ) : null,
      h('div', { class: 'card' },
        h('h3', {}, 'Profile'),
        form(h('label', { for: 'dn' }, 'Name on leaderboards', h('input', { id: 'dn', name: 'displayName', required: true, minlength: 2, maxlength: 40, value: p.displayName })), 'Save name', async (v) => {
          await call('POST', '/v1/me/profile', v);
          toast('Name saved');
          await loadMe();
          loadAccount();
        }),
      ),
      direct ? h('div', { class: 'card' },
        h('h3', {}, 'Password'),
        form([
          h('label', { for: 'pw-cur' }, 'Current password', h('input', { id: 'pw-cur', name: 'currentPassword', type: 'password', autocomplete: 'current-password', required: true })),
          h('label', { for: 'pw-new' }, 'New password (8 characters or more)', h('input', { id: 'pw-new', name: 'newPassword', type: 'password', autocomplete: 'new-password', required: true, minlength: 8 })),
        ], 'Change password', async (v) => {
          await call('POST', '/v1/me/password', v);
          toast('Password changed. Other devices are signed out.');
        }),
      ) : null,
    ),
  ));
}

// ---------- safer play ----------
const LIMIT_LABELS = { lossDay: 'Loss limit per 24 hours', lossWeek: 'Loss limit per 7 days', depositWeek: 'Deposit limit per 7 days' };
const breakLabel = (d) => (d === 1 ? '24 hours' : d < 180 ? `${d} days` : d < 365 ? '6 months' : d === 365 ? '1 year' : '5 years');

async function loadSafer() {
  const v = await call('GET', '/v1/me/limits');
  const fields = {};
  const limitRow = (key) => {
    fields[key] = h('input', { type: 'number', min: '1', step: '0.01', placeholder: 'No limit', value: v[key] === null ? '' : (v[key] / 100).toFixed(2) });
    const waiting = v.pending && key in v.pending;
    return h('label', {}, LIMIT_LABELS[key], fields[key],
      h('div', { class: 'small muted' }, `Used: ${money(v.used[key], v.currency)}${v[key] !== null ? ` of ${money(v[key], v.currency)}` : ''}`,
        waiting ? ` · changes to ${v.pending[key] === null ? 'no limit' : money(v.pending[key], v.currency)} on ${time(v.pendingFrom)}` : ''));
  };
  const save = async () => {
    // Send only the limits the player changed, so saving one never touches another's pending raise.
    const body = {};
    for (const [k, el] of Object.entries(fields)) {
      if (el.value === el.defaultValue) continue;
      body[k] = el.value.trim() === '' ? null : Math.round(Number(el.value) * 100);
    }
    if (!Object.keys(body).length) return toast('Nothing changed.');
    try {
      const after = await call('POST', '/v1/me/limits', body);
      toast(after.pending ? 'Saved. Lower limits apply now; higher ones after 24 hours.' : 'Limits saved.');
      loadSafer();
    } catch (e) { toast(e.message, true); }
  };
  const takeBreak = async (days) => {
    if (!confirm(`Take a break for ${breakLabel(days)}? You won't be able to bet, join tournaments or deposit until it ends, and it cannot be undone.`)) return;
    try {
      await call('POST', '/v1/me/break', { days });
      toast(`Your break has started. See you after ${breakLabel(days)}.`);
      loadSafer();
    } catch (e) { toast(e.message, true); }
  };
  $('#view').replaceChildren(h('div', { class: 'split' },
    h('div', { class: 'card' },
      h('h3', {}, 'Limits'),
      h('p', { class: 'small muted' }, 'Lowering a limit works straight away. Raising or removing one takes effect after 24 hours.'),
      ...Object.keys(LIMIT_LABELS).map(limitRow),
      h('button', { class: 'primary', onclick: save }, 'Save limits'),
    ),
    h('div', { class: 'card' },
      h('h3', {}, 'Take a break'),
      v.excludedUntil
        ? h('p', {}, `You are on a break until ${time(v.excludedUntil)}. You can still withdraw your balance at the desk.`)
        : h('p', { class: 'small muted' }, 'Pause betting, tournaments and deposits. A break cannot be shortened once it starts.'),
      h('div', { class: 'row' }, v.breakDays.map((d) => h('button', { onclick: () => takeBreak(d) }, breakLabel(d)))),
      h('p', { class: 'small muted', style: 'margin-top:12px' }, 'Play for fun, never to win back losses. If gambling stops being fun, talk to someone: a friend, our staff, or a support line in your country.'),
    ),
  ));
}

await loadMe();
if (state.tableId) go('tables', { tableId: state.tableId });
else go('tables');
