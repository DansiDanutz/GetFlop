import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';

let env: TestEnv;
beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => { await env.close(); });

const form = {
  username: 'maria', displayName: 'Maria', pin: '4321', email: 'Maria@Example.com',
  adult: true, acceptTerms: true, marketingEmail: false, lang: 'en',
};

describe('registration', () => {
  it('registers with an emailed code and signs in', async () => {
    const agent = request.agent(env.url);
    const { registrationId } = ok(await agent.post('/api/auth/register/code').send(form));
    const code = env.mailer.lastTo('maria@example.com')!.text.match(/\d{6}/)![0];
    const { user } = ok(await agent.post('/api/auth/register').send({ registrationId, code }));
    expect(user).toMatchObject({ username: 'maria', displayName: 'Maria', emailVerified: true, role: 'player' });
    expect(ok(await agent.get('/api/auth/me')).user.id).toBe(user.id);
  });

  it.each([
    [{ username: 'a' }, 'user.username_invalid'],
    [{ pin: '12' }, 'auth.pin_invalid'],
    [{ adult: false }, 'auth.terms_required'],
    [{ email: 'nope' }, 'auth.email_invalid'],
    [{ email: '' }, 'auth.email_required'],
    [{ displayName: '<b>' }, 'name.invalid_chars'],
  ])('rejects %o with %s', async (patch, code) => {
    expect(errCode(await request(env.url).post('/api/auth/register/code').send({ ...form, ...patch }))).toBe(code);
  });

  it('rejects taken usernames and emails, case-insensitively', async () => {
    await env.login('Maria');
    expect(errCode(await request(env.url).post('/api/auth/register/code').send(form))).toBe('auth.username_taken');
    expect(errCode(await request(env.url).post('/api/auth/register/code').send({ ...form, username: 'other', email: 'MARIA@example.test' })))
      .toBe('auth.email_taken');
  });

  it('counts wrong codes and locks after five', async () => {
    const agent = request.agent(env.url);
    const { registrationId } = ok(await agent.post('/api/auth/register/code').send(form));
    for (let i = 0; i < 4; i++) {
      expect(errCode(await agent.post('/api/auth/register').send({ registrationId, code: '000000x' }))).toBe('auth.code_invalid');
    }
    expect(errCode(await agent.post('/api/auth/register').send({ registrationId, code: 'bad' }))).toBe('auth.code_attempts');
  });

  it('expires codes after 15 minutes', async () => {
    const agent = request.agent(env.url);
    const { registrationId } = ok(await agent.post('/api/auth/register/code').send(form));
    const code = env.mailer.lastTo('maria@example.com')!.text.match(/\d{6}/)![0];
    env.clock.advance(16 * 60_000);
    expect(errCode(await agent.post('/api/auth/register').send({ registrationId, code }))).toBe('auth.code_expired');
  });
});

describe('login and sessions', () => {
  it('rejects a wrong PIN and locks after five failures', async () => {
    await env.login('nick');
    for (let i = 0; i < 4; i++) {
      expect(errCode(await request(env.url).post('/api/auth/login').send({ username: 'nick', pin: '0000' }))).toBe('auth.pin_wrong');
    }
    expect(errCode(await request(env.url).post('/api/auth/login').send({ username: 'nick', pin: '0000' }))).toBe('auth.too_many');
    expect(errCode(await request(env.url).post('/api/auth/login').send({ username: 'nick', pin: '1234' }))).toBe('auth.too_many');
    env.clock.advance(6 * 60_000);
    ok(await request(env.url).post('/api/auth/login').send({ username: 'nick', pin: '1234' }));
  });

  it('keeps one device at a time', async () => {
    const first = await env.login('nick');
    await env.login('nick');
    expect(errCode(await first.get('/api/auth/me'))).toBe('auth.required');
    expect(env.events.named('session:ended')).toHaveLength(1);
  });

  it('changes the PIN and signs out other devices', async () => {
    const agent = await env.login('nick');
    expect(errCode(await agent.post('/api/auth/pin/change').send({ pin: '9999', newPin: '5555' }))).toBe('auth.pin_wrong');
    ok(await agent.post('/api/auth/pin/change').send({ pin: '1234', newPin: '5555' }));
    ok(await agent.get('/api/auth/me'));
    ok(await request(env.url).post('/api/auth/login').send({ username: 'nick', pin: '5555' }));
  });

  it('resets a forgotten PIN by email code', async () => {
    await env.login('nick');
    ok(await request(env.url).post('/api/auth/pin-reset/request').send({ username: 'nick' }));
    const code = env.mailer.lastTo('nick@example.test')!.text.match(/\d{6}/)![0];
    ok(await request(env.url).post('/api/auth/pin-reset/confirm').send({ username: 'nick', code, newPin: '7777' }));
    ok(await request(env.url).post('/api/auth/login').send({ username: 'nick', pin: '7777' }));
  });

  it('logs out', async () => {
    const agent = await env.login('nick');
    ok(await agent.post('/api/auth/logout'));
    expect(errCode(await agent.get('/api/auth/me'))).toBe('auth.required');
  });

  it('updates the display name and email', async () => {
    const agent = await env.login('nick');
    expect(ok(await agent.put('/api/auth/display-name').send({ displayName: 'Nicky' })).user.displayName).toBe('Nicky');
    expect(errCode(await agent.put('/api/auth/display-name').send({ displayName: 'x'.repeat(31) }))).toBe('auth.display_name_too_long');
    ok(await agent.post('/api/auth/email').send({ email: 'new@example.com', pin: '1234' }));
    const code = env.mailer.lastTo('new@example.com')!.text.match(/\d{6}/)![0];
    expect(ok(await agent.post('/api/auth/email/verify').send({ code })).user.email).toBe('new@example.com');
  });
});
