import { $, api, toast } from './lib.js';

const call = api('gf.player');
let mode = 'login';
const setMode = (m) => {
  mode = m;
  $('#tab-login').classList.toggle('on', m === 'login');
  $('#tab-register').classList.toggle('on', m === 'register');
  $('#dn').classList.toggle('hidden', m === 'login');
  $('#submit').textContent = m === 'login' ? 'Log in' : 'Create account';
};
$('#tab-login').onclick = () => setMode('login');
$('#tab-register').onclick = () => setMode('register');

if (localStorage.getItem('gf.player')) {
  call('GET', '/v1/me').then(() => (location.href = 'play.html')).catch(() => localStorage.removeItem('gf.player'));
}

$('#form').onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    const res = await call('POST', mode === 'login' ? '/v1/auth/login' : '/v1/auth/register', f);
    localStorage.setItem('gf.player', res.token);
    location.href = 'play.html';
  } catch (err) {
    toast(err.message, true);
  }
};

call('GET', '/v1/demo/info').then((info) => {
  if (!info.demo) return;
  $('#demo').classList.remove('hidden');
  $('#play-now').onclick = async () => {
    try {
      const res = await call('POST', '/v1/demo/player');
      localStorage.setItem('gf.player', res.token);
      location.href = 'play.html';
    } catch (err) {
      toast(err.message, true);
    }
  };
}).catch(() => {});
