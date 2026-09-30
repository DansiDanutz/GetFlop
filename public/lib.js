// Shared browser helpers: API calls, formatting, cards, toasts. No framework.

export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function api(tokenKey) {
  return async (method, path, body) => {
    const token = localStorage.getItem(tokenKey);
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.message || data.error || `HTTP ${res.status}`);
      e.code = data.error;
      e.status = res.status;
      throw e;
    }
    return data;
  };
}

export const money = (minor, currency = '') => `${(minor / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ' ' + currency : ''}`;
export const odds = (x100) => (x100 / 100).toFixed(2);
export const pts = (n) => Number(n).toLocaleString();
export const time = (ms) => new Date(ms).toLocaleString();

const SUIT = { c: '♣', d: '♦', h: '♥', s: '♠' };
export function card(text, small = false) {
  if (!text) return h('span', { class: `pc back${small ? ' small' : ''}` });
  const r = text[0] === 'T' ? '10' : text[0];
  const s = text[1];
  return h('span', { class: `pc${small ? ' small' : ''}${s === 'd' || s === 'h' ? ' red' : ''}` }, r, h('span', { class: 's' }, SUIT[s]));
}
export const flop = (cards, small) => h('span', { class: 'flop' }, (cards || [null, null, null]).map((c) => card(c, small)));

let toastTimer;
export function toast(msg, isError = false) {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: `toast${isError ? ' err' : ''}` }, msg);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3500);
}

// Live updates via Server-Sent Events. Reconnects on its own.
export function stream(url, onEvent) {
  const es = new EventSource(url);
  for (const ev of ['round.opened', 'round.closed', 'round.settled', 'round.voided', 'round.bets', 'round.flop_pending', 'round.flop_mismatch', 'tables.changed', 'table.changed', 'tournaments.changed', 'tournament.changed'])
    es.addEventListener(ev, (e) => onEvent(ev, JSON.parse(e.data)));
  return es;
}

// Server time offset so countdowns are right even if the device clock is off.
let offset = 0;
export const syncClock = (serverTime) => { offset = serverTime - Date.now(); };
export const serverNow = () => Date.now() + offset;
