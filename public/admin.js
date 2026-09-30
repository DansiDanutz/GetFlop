import { $, h, money, odds, time, toast } from './lib.js';
import { call, requireStaff } from './staff.js';

const TABS = [['tables', 'Tables'], ['partners', 'Partners'], ['players', 'Players'], ['tournaments', 'Tournaments'], ['reports', 'Commission'], ['integrity', 'Audit & integrity'], ['staff', 'Staff']];
let tab = localStorage.getItem('gf.admin.tab') || 'tables';

requireStaff(() => show(tab));

function show(t) {
  tab = t;
  localStorage.setItem('gf.admin.tab', t);
  const body = h('div', {});
  $('#view').replaceChildren(h('div', { class: 'tabs' }, TABS.map(([id, label]) => h('button', { class: id === t ? 'on' : '', onclick: () => show(id) }, label))), body);
  ({ tables, partners, players, tournaments, reports, integrity, staff })[t](body).catch((e) => toast(e.message, true));
}

const form = (fields, submit, label) => h('form', { onsubmit: async (e) => {
  e.preventDefault();
  try { await submit(Object.fromEntries(new FormData(e.target))); } catch (err) { toast(err.message, true); }
} }, h('div', { class: 'grid' }, fields), h('button', { class: 'primary', style: 'margin-top:8px' }, label));
const field = (label, name, attrs = {}) => h('label', {}, label, attrs.options
  ? h('select', { name }, attrs.options.map(([v, l]) => h('option', { value: v, selected: v === attrs.value }, l)))
  : h('input', { name, ...attrs }));
const cents = (v) => Math.round(Number(v) * 100);
const ts = (v) => new Date(v).getTime();
const localInput = (ms) => new Date(ms - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);

// ---------- tables ----------
async function tables(el) {
  const list = await call('GET', '/v1/admin/tables');
  el.append(
    h('div', { class: 'card' }, h('h2', {}, 'Tables'),
      h('table', { class: 'list' },
        h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Status'), h('th', { class: 'num' }, 'Margin'), h('th', { class: 'num' }, 'Stake'), h('th', { class: 'num' }, 'Max round risk'), h('th', { class: 'num' }, 'Betting'), h('th', {}, '')),
        list.map((t) => h('tr', {}, h('td', {}, t.name, t.dualConfirm ? h('span', { class: 'muted small' }, ' · dual confirm') : ''), h('td', {}, h('span', { class: 'pill' }, t.status)),
          h('td', { class: 'num' }, `${t.marginBps / 100}%`), h('td', { class: 'num' }, `${money(t.minStake)}–${money(t.maxStake)}`), h('td', { class: 'num' }, money(t.maxRoundLiability)), h('td', { class: 'num' }, `${t.bettingSeconds}s`),
          h('td', {}, h('button', { class: 'small', onclick: async () => { await call('PATCH', `/v1/admin/tables/${t.id}`, { status: t.status === 'active' ? 'inactive' : 'active' }); show('tables'); } }, t.status === 'active' ? 'Deactivate' : 'Activate')))))),
    h('div', { class: 'card' }, h('h2', {}, 'New table'),
      form([
        field('Name', 'name', { required: true, placeholder: 'Table 2 · NLH 1/2' }),
        field('House margin %', 'margin', { type: 'number', step: '0.1', value: '5' }),
        field('Min stake', 'minStake', { type: 'number', step: '0.01', value: '1' }),
        field('Max stake', 'maxStake', { type: 'number', step: '0.01', value: '500' }),
        field('Max payout per bet', 'maxBetPayout', { type: 'number', step: '0.01', value: '10000' }),
        field('Max house loss per hand', 'maxRoundLiability', { type: 'number', step: '0.01', value: '50000' }),
        field('Betting window (seconds)', 'bettingSeconds', { type: 'number', value: '45' }),
        field('Flop confirmation', 'dualConfirm', { options: [['0', 'Dealer only'], ['1', 'Dealer + 2nd person']] }),
        field('Video stream URL (optional)', 'streamUrl', { placeholder: 'https://…' }),
      ], async (f) => {
        await call('POST', '/v1/admin/tables', {
          name: f.name, marginBps: Math.round(Number(f.margin) * 100), minStake: cents(f.minStake), maxStake: cents(f.maxStake), maxBetPayout: cents(f.maxBetPayout),
          maxRoundLiability: cents(f.maxRoundLiability), bettingSeconds: Number(f.bettingSeconds), dualConfirm: f.dualConfirm === '1', streamUrl: f.streamUrl || null,
        });
        toast('Table created');
        show('tables');
      }, 'Create table')),
    h('div', { class: 'card' }, h('h2', {}, 'Price list at 5% margin'), await priceTable(500)),
  );
}

async function priceTable(bps) {
  const rows = await call('GET', `/v1/admin/pricing?marginBps=${bps}`);
  return h('table', { class: 'list' }, h('tr', {}, h('th', {}, 'Market'), h('th', { class: 'num' }, 'Chance'), h('th', { class: 'num' }, 'Odds'), h('th', { class: 'num' }, 'House edge')),
    rows.map((m) => h('tr', {}, h('td', {}, m.name), h('td', { class: 'num' }, `${(m.probability * 100).toFixed(2)}%`), h('td', { class: 'num' }, odds(m.oddsX100)), h('td', { class: 'num' }, `${(m.houseEdge * 100).toFixed(2)}%`))));
}

// ---------- partners ----------
async function partners(el, created) {
  const list = await call('GET', '/v1/admin/operators');
  const secretBox = h('div', {});
  const reveal = (o) => secretBox.replaceChildren(h('div', { class: 'card', style: 'border-color:var(--gold)' },
    h('h2', {}, `Credentials for ${o.name}`), h('p', { class: 'muted small' }, 'Send these to the partner securely. The secret is shown only now.'),
    'API key', h('code', { class: 'secret' }, o.apiKey), 'Secret', h('code', { class: 'secret' }, o.secret)));
  el.append(secretBox,
    h('div', { class: 'card' }, h('h2', {}, 'Partners (operators)'),
      h('table', { class: 'list' },
        h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Wallet'), h('th', {}, 'Currency'), h('th', { class: 'num' }, 'Commission'), h('th', {}, 'Status'), h('th', {}, '')),
        list.map((o) => h('tr', {}, h('td', {}, o.name, h('div', { class: 'muted small' }, o.id)), h('td', {}, o.walletMode, o.walletUrl ? h('div', { class: 'muted small' }, o.walletUrl) : ''), h('td', {}, o.currency),
          h('td', { class: 'num' }, `${o.commissionBps / 100}% of GGR`), h('td', {}, h('span', { class: 'pill' }, o.status)),
          h('td', {}, o.id === 'op_direct' ? h('span', { class: 'muted small' }, 'your own players') : h('div', { class: 'row' },
            h('button', { class: 'small', onclick: async () => { await call('PATCH', `/v1/admin/operators/${o.id}`, { status: o.status === 'active' ? 'suspended' : 'active' }); show('partners'); } }, o.status === 'active' ? 'Suspend' : 'Activate'),
            h('button', { class: 'small', onclick: async () => { if (confirm('Rotate secret? The old one stops working immediately.')) reveal(await call('POST', `/v1/admin/operators/${o.id}/rotate-secret`)); } }, 'New secret'))))))),
    h('div', { class: 'card' }, h('h2', {}, 'Add partner'),
      form([
        field('Name', 'name', { required: true }),
        field('Currency (3 letters)', 'currency', { value: 'EUR', maxlength: 3 }),
        field('Wallet', 'walletMode', { options: [['transfer', 'Transfer (they move money into GetFlop)'], ['seamless', 'Seamless (we call their wallet)']] }),
        field('Wallet URL (seamless only)', 'walletUrl', { placeholder: 'https://partner.example/getflop-wallet' }),
        field('Commission % of GGR', 'commission', { type: 'number', step: '0.5', value: '15' }),
      ], async (f) => {
        const o = await call('POST', '/v1/admin/operators', { name: f.name, currency: f.currency, walletMode: f.walletMode, walletUrl: f.walletUrl || null, commissionBps: Math.round(Number(f.commission) * 100) });
        el.replaceChildren();
        await partners(el, o);
      }, 'Create partner')),
  );
  if (created) reveal(created);
}

// ---------- players ----------
async function players(el, q = '') {
  const list = await call('GET', `/v1/admin/players?q=${encodeURIComponent(q)}`);
  el.replaceChildren(h('div', { class: 'card' },
    h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); players(el, e.target.q.value); } }, h('input', { name: 'q', value: q, placeholder: 'Search name or username', style: 'flex:1' }), h('button', {}, 'Search')),
    h('table', { class: 'list', style: 'margin-top:12px' },
      h('tr', {}, h('th', {}, 'Player'), h('th', {}, 'Via'), h('th', { class: 'num' }, 'Balance'), h('th', {}, 'Cashier (direct players)')),
      list.map((p) => h('tr', {}, h('td', {}, p.displayName, h('div', { class: 'muted small' }, p.username ?? p.externalId)), h('td', {}, p.operator),
        h('td', { class: 'num' }, p.operator === 'GetFlop Direct' ? money(p.balance, p.currency) : '—'),
        h('td', {}, p.operator === 'GetFlop Direct' ? h('form', { class: 'row', onsubmit: async (e) => {
          e.preventDefault();
          try {
            await call('POST', `/v1/admin/players/${p.id}/cashier`, { amount: cents(e.target.amount.value), note: e.target.note.value || 'desk' });
            toast('Balance updated');
            players(el, q);
          } catch (err) { toast(err.message, true); }
        } }, h('input', { name: 'amount', type: 'number', step: '0.01', placeholder: '+50 or -20', style: 'width:110px', required: true }), h('input', { name: 'note', placeholder: 'note', style: 'width:120px' }), h('button', { class: 'small' }, 'Apply')) : ''))))));
}

// ---------- tournaments ----------
async function tournaments(el) {
  const [list, strategies] = await Promise.all([call('GET', '/v1/admin/tournaments'), call('GET', '/v1/admin/tournament-strategies')]);
  const now = Date.now();
  el.append(
    h('div', { class: 'card' }, h('h2', {}, 'Tournaments'),
      h('table', { class: 'list' },
        h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Format'), h('th', {}, 'Status'), h('th', { class: 'num' }, 'Players'), h('th', { class: 'num' }, 'Buy-in'), h('th', { class: 'num' }, 'Pool'), h('th', {}, 'Runs'), h('th', {}, '')),
        list.map((t) => h('tr', {}, h('td', {}, t.name), h('td', {}, t.strategyName), h('td', {}, h('span', { class: `pill ${t.status}` }, t.status)), h('td', { class: 'num' }, t.entrants),
          h('td', { class: 'num' }, t.buyIn ? money(t.buyIn, t.currency) : 'free'), h('td', { class: 'num' }, money(t.prizePool, t.currency)), h('td', { class: 'small' }, `${time(t.startsAt)} → ${time(t.endsAt)}`),
          h('td', {}, ['scheduled', 'running'].includes(t.status) ? h('button', { class: 'small danger', onclick: async () => {
            const reason = prompt('Cancel and refund all buy-ins. Reason:');
            if (reason) { await call('POST', `/v1/admin/tournaments/${t.id}/cancel`, { reason }); show('tournaments'); }
          } }, 'Cancel') : ''))))),
    h('div', { class: 'card' }, h('h2', {}, 'New tournament'),
      form([
        field('Name', 'name', { required: true, placeholder: 'Friday Flop Race' }),
        field('Format', 'strategy', { options: strategies.map((s) => [s.id, s.name]) }),
        field('Starts', 'startsAt', { type: 'datetime-local', value: localInput(now) }),
        field('Ends', 'endsAt', { type: 'datetime-local', value: localInput(now + 8 * 3600_000) }),
        field('Currency', 'currency', { value: 'EUR', maxlength: 3 }),
        field('Buy-in (0 = free)', 'buyIn', { type: 'number', step: '0.01', value: '0' }),
        field('Fee % of buy-ins', 'rake', { type: 'number', step: '0.5', value: '10' }),
        field('Guaranteed prize pool', 'guaranteed', { type: 'number', step: '0.01', value: '0' }),
        field('Starting points', 'startingPoints', { type: 'number', value: '1000' }),
        field('Max bets per player', 'maxBets', { type: 'number', value: '100' }),
        field('Min / max stake (points)', 'stakes', { value: '10/1000' }),
        field('Min bets to qualify', 'minBetsToQualify', { type: 'number', value: '1' }),
        field('Paid places (% of players)', 'paidPercent', { type: 'number', step: '0.5', value: '5' }),
        field('Prize split', 'payoutCurve', { options: [['top_heavy', 'More for higher places'], ['flat', 'Equal']] }),
      ], async (f) => {
        const [minStake, maxStake] = f.stakes.split('/').map(Number);
        await call('POST', '/v1/admin/tournaments', {
          name: f.name, strategy: f.strategy, startsAt: ts(f.startsAt), endsAt: ts(f.endsAt), currency: f.currency, buyIn: cents(f.buyIn),
          rakeBps: Math.round(Number(f.rake) * 100), guaranteed: cents(f.guaranteed),
          rules: { startingPoints: Number(f.startingPoints), maxBets: Number(f.maxBets), minStake, maxStake, minBetsToQualify: Number(f.minBetsToQualify), paidPercent: Number(f.paidPercent), payoutCurve: f.payoutCurve },
        });
        toast('Tournament created');
        show('tournaments');
      }, 'Create tournament')),
  );
}

// ---------- commission ----------
async function reports(el) {
  const to = Date.now();
  const from = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const out = h('div', {});
  const run = async (f, t) => {
    const r = await call('GET', `/v1/admin/reports/ggr?from=${f}&to=${t}`);
    out.replaceChildren(h('table', { class: 'list' },
      h('tr', {}, h('th', {}, 'Partner'), h('th', { class: 'num' }, 'Players'), h('th', { class: 'num' }, 'Bets'), h('th', { class: 'num' }, 'Stakes'), h('th', { class: 'num' }, 'Paid out'), h('th', { class: 'num' }, 'GGR'), h('th', { class: 'num' }, 'Hold'), h('th', { class: 'num' }, 'Commission'), h('th', {}, '')),
      r.rows.map((x) => h('tr', {}, h('td', {}, x.operator), h('td', { class: 'num' }, x.players), h('td', { class: 'num' }, x.bets), h('td', { class: 'num' }, money(x.stakes, x.currency)),
        h('td', { class: 'num' }, money(x.payouts, x.currency)), h('td', { class: 'num' }, money(x.ggr, x.currency)), h('td', { class: 'num' }, `${(x.holdPct * 100).toFixed(1)}%`),
        h('td', { class: 'num' }, `${money(x.commissionIfInvoiced, x.currency)} (${x.commissionBps / 100}%)`),
        h('td', {}, x.operatorId === 'op_direct' ? '' : h('button', { class: 'small', onclick: async () => {
          try { const inv = await call('POST', '/v1/admin/invoices', { operatorId: x.operatorId, from: f, to: Math.min(t, Date.now()) }); toast(`Invoice: ${money(inv.commission, inv.currency)}`); invoices(); } catch (e) { toast(e.message, true); }
        } }, 'Invoice period'))))));
  };
  const invBox = h('div', {});
  const invoices = async () => {
    const list = await call('GET', '/v1/admin/invoices');
    invBox.replaceChildren(h('table', { class: 'list' },
      h('tr', {}, h('th', {}, 'Partner'), h('th', {}, 'Period'), h('th', { class: 'num' }, 'GGR'), h('th', { class: 'num' }, 'Carried in'), h('th', { class: 'num' }, 'Commission'), h('th', { class: 'num' }, 'Carried out')),
      list.map((i) => h('tr', {}, h('td', {}, i.operator_id), h('td', { class: 'small' }, `${time(i.period_from)} → ${time(i.period_to)}`), h('td', { class: 'num' }, money(i.ggr, i.currency)),
        h('td', { class: 'num' }, money(i.carry_in, i.currency)), h('td', { class: 'num' }, h('strong', {}, money(i.commission, i.currency))), h('td', { class: 'num' }, money(i.carry_out, i.currency))))));
  };
  el.append(
    h('div', { class: 'card' }, h('h2', {}, 'GGR and commission by partner'),
      h('form', { class: 'row', style: 'margin-bottom:12px', onsubmit: (e) => { e.preventDefault(); run(ts(e.target.f.value), ts(e.target.t.value)).catch((x) => toast(x.message, true)); } },
        h('input', { name: 'f', type: 'datetime-local', value: localInput(from), style: 'width:auto' }), h('input', { name: 't', type: 'datetime-local', value: localInput(to), style: 'width:auto' }), h('button', {}, 'Show')),
      out, h('p', { class: 'muted small' }, 'GGR = stakes lost minus winnings paid. Losing periods are carried forward into the next invoice.')),
    h('div', { class: 'card' }, h('h2', {}, 'Invoices'), invBox),
  );
  await Promise.all([run(from, to), invoices()]);
}

// ---------- integrity ----------
async function integrity(el) {
  const [check, log, outbox] = await Promise.all([call('GET', '/v1/admin/integrity'), call('GET', '/v1/admin/audit'), call('GET', '/v1/admin/outbox?status=failed')]);
  el.append(
    h('div', { class: 'card' }, h('h2', {}, 'Integrity'),
      h('p', {}, check.ledger.ok ? '✅ Ledger balances: every account matches its entries, every currency sums to zero.' : '❌ Ledger mismatch: ' + JSON.stringify(check.ledger)),
      h('p', {}, check.audit.ok ? `✅ Audit chain intact (${check.audit.records} records).` : `❌ Audit chain broken at record ${check.audit.brokenAt}.`),
      h('p', {}, outbox.length ? `⚠️ ${outbox.length} wallet messages to partners failed after all retries.` : '✅ No failed wallet messages.')),
    h('div', { class: 'card' }, h('h2', {}, 'Audit log (latest 200)'),
      h('table', { class: 'list' }, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Who'), h('th', {}, 'Action'), h('th', {}, 'Details')),
        log.map((a) => h('tr', {}, h('td', { class: 'small' }, time(a.at)), h('td', {}, a.actor), h('td', {}, a.action), h('td', { class: 'small muted' }, JSON.stringify(a.data)))))),
  );
}

// ---------- staff ----------
async function staff(el) {
  const list = await call('GET', '/v1/admin/staff');
  el.append(
    h('div', { class: 'card' }, h('h2', {}, 'Staff'), h('table', { class: 'list' }, list.map((s) => h('tr', {}, h('td', {}, s.username), h('td', {}, s.role), h('td', { class: 'small muted' }, time(s.created_at)))))),
    h('div', { class: 'card' }, h('h2', {}, 'Add staff'), form([
      field('Username', 'username', { required: true }),
      field('Password (10+ characters)', 'password', { type: 'password', required: true, minlength: 10 }),
      field('Role', 'role', { options: [['dealer', 'Dealer: opens hands, enters flops'], ['supervisor', 'Supervisor: + voids, confirms'], ['admin', 'Admin: everything']] }),
    ], async (f) => { await call('POST', '/v1/admin/staff', f); toast('Staff added'); show('staff'); }, 'Add')),
  );
}
