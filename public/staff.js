// Staff login shared by the dealer console and the admin screen.
import { $, api, h, toast } from './lib.js';

export const call = api('gf.staff');

export async function requireStaff(onReady) {
  try {
    const me = await call('GET', '/v1/staff/me');
    $('#who').textContent = `${me.username} · ${me.role}`;
    $('#logout').classList.remove('hidden');
    $('#logout').onclick = async () => { await call('POST', '/v1/staff/logout').catch(() => {}); localStorage.removeItem('gf.staff'); location.reload(); };
    onReady(me);
  } catch {
    localStorage.removeItem('gf.staff');
    $('#view').replaceChildren(h('div', { class: 'card', style: 'max-width:380px;margin:40px auto' },
      h('h2', {}, 'Staff login'),
      h('form', { onsubmit: async (e) => {
        e.preventDefault();
        try {
          const res = await call('POST', '/v1/staff/login', Object.fromEntries(new FormData(e.target)));
          localStorage.setItem('gf.staff', res.token);
          location.reload();
        } catch (err) { toast(err.message, true); }
      } },
        h('label', {}, 'Username', h('input', { name: 'username', autocomplete: 'username', required: true })),
        h('label', {}, 'Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
        h('button', { class: 'primary big' }, 'Log in'))));
  }
}
