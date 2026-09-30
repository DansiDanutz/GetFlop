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

// The table's video lives outside #view so re-rendering the table (live updates, the backup
// refresh) never reloads the player. It is only replaced when the stream URL changes.
function syncStream() {
  const url = (state.tableId && state.data?.table?.id === state.tableId && state.data.table.streamUrl) || '';
  const el = $('#stream');
  if (el.dataset.url === url) return;
  el.dataset.url = url;
  el.replaceChildren(url ? h('div', { class: 'card' }, h('iframe', { src: url, style: 'width:100%;aspect-ratio:16/9;border:0;border-radius:8px', allow: 'autoplay; fullscreen' })) : '');
}

function go(tab, extra = {}) {
  Object.assign(state, { tab, tableId: null, tournamentId: null }, extra);
  syncStream();
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
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
      if (state.tableId) return loadTable().then(() => showResult(data)).catch(() => {});
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
    else await loadHistory();
  } catch (e) {
    if (seq === renderSeq) toast(e.message, true);
  }
}

// ---------- lobby ----------
async function loadLobby() {
  const tables = await call('GET', '/v1/tables');
  $('#view').replaceChildren(
    tables.length ? h('div', { class: 'grid' }, tables.map((t) => h('button', { class: 'card', style: 'text-align:left', onclick: () => go('tables', { tableId: t.id }) },
      h('div', { class: 'row' }, h('strong', {}, t.name), h('span', { class: `pill right ${t.round?.status ?? ''}` }, t.round ? (t.round.status === 'open' ? 'Betting open' : 'Dealing') : 'Waiting')),
      h('div', { class: 'muted small', style: 'margin-top:8px' }, `Hand #${t.round?.number ?? '–'} · stakes ${money(t.minStake)}–${money(t.maxStake)}`),
    ))) : h('div', { class: 'card muted' }, 'No live tables right now.'),
  );
}

// ---------- table ----------
// Refreshes can overlap (live updates, the backup timer, the player switching table or wallet).
// Only the most recently started one may update the screen: an older response must never put
// back an old table, video or betting wallet (cash vs tournament points).
let tableLoadSeq = 0;
async function loadTable() {
  const seq = ++tableLoadSeq;
  const tableId = state.tableId;
  const current = () => seq === tableLoadSeq && state.tableId === tableId;
  const [view, tours] = await Promise.all([call('GET', `/v1/tables/${tableId}`), myRunningTournaments()]);
  if (!current()) return;
  const playFor = state.playFor !== 'cash' && !tours.find((t) => t.id === state.playFor) ? 'cash' : state.playFor;
  const myBets = playFor === 'cash'
    ? (await call('GET', '/v1/me/bets')).filter((b) => b.roundId === view.round?.id)
    : (tours.find((t) => t.id === playFor)?.me?.bets ?? []).filter((b) => b.roundId === view.round?.id);
  if (!current()) return;
  syncClock(view.serverTime);
  Object.assign(state, { data: view, tours, playFor, myBets });
  renderTable();
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
          }, h('div', { class: 'count' }, round?.betsByMarket?.[m.id] ? `${round.betsByMarket[m.id]} bets` : ''), h('div', { class: 'odds' }, odds(m.oddsX100)), h('div', { class: 'name' }, m.name)))),
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
const marketName = (id) => state.data?.markets.find((m) => m.id === id)?.name ?? id;

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
  // Check every wallet the player used this hand: cash and each tournament.
  const cash = (await call('GET', '/v1/me/bets')).filter((b) => b.roundId === round.id);
  const tour = state.tours.flatMap((t) => (t.me?.bets ?? []).filter((b) => b.roundId === round.id));
  const mine = [...cash, ...tour];
  if (!mine.length) return;
  const won = mine.filter((b) => round.winningMarkets.includes(b.marketId));
  toast(won.length ? `Winner! ${won.map((b) => marketName(b.marketId)).join(', ')}` : 'No luck this flop.');
}

function tickCountdown() {
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
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (state.tableId) loadTable().catch(() => {});
  else if (state.tournamentId) render();
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
  const bets = await call('GET', '/v1/me/bets');
  $('#view').replaceChildren(h('div', { class: 'card' },
    bets.length ? h('table', { class: 'list' },
      h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Table'), h('th', {}, 'Bet'), h('th', { class: 'num' }, 'Stake'), h('th', { class: 'num' }, 'Odds'), h('th', {}, 'Flop'), h('th', {}, 'Result'), h('th', { class: 'num' }, 'Paid')),
      bets.map((b) => h('tr', {}, h('td', { class: 'small' }, time(b.placedAt)), h('td', {}, `${b.tableName} #${b.roundNumber}`), h('td', {}, b.marketId),
        h('td', { class: 'num' }, money(b.stake, b.currency)), h('td', { class: 'num' }, odds(b.oddsX100)), h('td', {}, b.flop ? flop(b.flop, true) : ''),
        h('td', {}, h('span', { class: `pill ${b.status}` }, b.status)), h('td', { class: 'num' }, b.payout ? money(b.payout, b.currency) : ''))),
    ) : h('div', { class: 'muted' }, 'No bets yet.')));
}

await loadMe();
if (state.tableId) go('tables', { tableId: state.tableId });
else go('tables');
