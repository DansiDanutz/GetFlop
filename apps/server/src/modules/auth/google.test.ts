import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, errCode, ok, type TestEnv } from '../../test/harness.js';
import { setGoogleKeySource, type Jwk } from './google.js';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
let env: TestEnv;
let privateKey: KeyObject;
let jwk: Jwk;

beforeEach(async () => { env = await createTestEnv(); });
afterEach(async () => {
  delete process.env.GOOGLE_CLIENT_ID;
  setGoogleKeySource(null);
  await env.close();
});

function enableGoogle(): void {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  jwk = { ...(pair.publicKey.export({ format: 'jwk' }) as Jwk), kid: 'k1', alg: 'RS256' };
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  setGoogleKeySource(async () => [jwk]);
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

function credential(claims: Record<string, unknown> = {}, opts: { kid?: string; key?: KeyObject } = {}): string {
  const nowS = Math.floor(env.clock.now().getTime() / 1000);
  const payload = {
    iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'g-123', email: 'Maria@Gmail.com', email_verified: true,
    iat: nowS, exp: nowS + 3600, ...claims,
  };
  const head = `${b64({ alg: 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' })}.${b64(payload)}`;
  return `${head}.${sign('RSA-SHA256', Buffer.from(head), opts.key ?? privateKey).toString('base64url')}`;
}

const finish = { username: 'maria', displayName: 'Maria', pin: '4321', adult: true, acceptTerms: true, lang: 'en' };

describe('Google sign-in turned off', () => {
  it('reports disabled and refuses every Google call', async () => {
    expect(ok(await request(env.url).get('/api/auth/google/config'))).toEqual({ enabled: false, clientId: null });
    expect(errCode(await request(env.url).post('/api/auth/google').send({ credential: 'x' }))).toBe('auth.google_disabled');
    expect(errCode(await request(env.url).post('/api/auth/google/register').send({ ...finish, registrationToken: 'a.b' })))
      .toBe('auth.google_disabled');
    const nick = await env.login('nick');
    expect(errCode(await nick.post('/api/auth/google/link').send({ credential: 'x', pin: '1234' }))).toBe('auth.google_disabled');
    expect(ok(await nick.get('/api/auth/identity'))).toMatchObject({ googleEnabled: false, google: { linked: false, email: null } });
  });
});

describe('Google sign-in', () => {
  beforeEach(enableGoogle);

  it('exposes the client id', async () => {
    expect(ok(await request(env.url).get('/api/auth/google/config'))).toEqual({ enabled: true, clientId: CLIENT_ID });
  });

  it('registers an unknown identity, then signs it in', async () => {
    const first = ok(await request(env.url).post('/api/auth/google').send({ credential: credential() }));
    expect(first).toMatchObject({ needsRegistration: true, email: 'maria@gmail.com', suggestedUsername: 'maria', emailTaken: false });
    const agent = request.agent(env.url);
    const { user } = ok(await agent.post('/api/auth/google/register').send({ ...finish, registrationToken: first.registrationToken }));
    expect(user).toMatchObject({ username: 'maria', email: 'maria@gmail.com', emailVerified: true });
    expect(ok(await agent.get('/api/auth/identity'))).toMatchObject({ google: { linked: true, email: 'maria@gmail.com' }, googleEnabled: true });

    const again = request.agent(env.url);
    expect(ok(await again.post('/api/auth/google').send({ credential: credential() })).user.id).toBe(user.id);
    ok(await again.get('/api/auth/me'));
  });

  it('checks the registration form and the token age', async () => {
    const { registrationToken } = ok(await request(env.url).post('/api/auth/google').send({ credential: credential() }));
    expect(errCode(await request(env.url).post('/api/auth/google/register').send({ ...finish, adult: false, registrationToken })))
      .toBe('auth.terms_required');
    expect(errCode(await request(env.url).post('/api/auth/google/register').send({ ...finish, pin: '12', registrationToken })))
      .toBe('auth.pin_invalid');
    expect(errCode(await request(env.url).post('/api/auth/google/register').send({ ...finish, registrationToken: 'bogus' })))
      .toBe('auth.google_expired');
    env.clock.advance(16 * 60_000);
    expect(errCode(await request(env.url).post('/api/auth/google/register').send({ ...finish, registrationToken })))
      .toBe('auth.google_expired');
  });

  it('refuses to create a second account for an email that already exists', async () => {
    await env.login('maria2');
    const taken = credential({ email: 'maria2@example.test' });
    const res = ok(await request(env.url).post('/api/auth/google').send({ credential: taken }));
    expect(res.emailTaken).toBe(true);
    expect(errCode(await request(env.url).post('/api/auth/google/register').send({ ...finish, registrationToken: res.registrationToken })))
      .toBe('auth.email_taken');
  });

  it.each([
    ['a foreign audience', () => credential({ aud: 'someone-else' })],
    ['an expired token', () => credential({ exp: Math.floor(env.clock.now().getTime() / 1000) - 10 })],
    ['an unverified email', () => credential({ email_verified: false })],
    ['a wrong issuer', () => credential({ iss: 'https://evil.example' })],
    ['an unknown key id', () => credential({}, { kid: 'nope' })],
    ['a forged signature', () => credential({}, { key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey })],
    ['garbage', () => 'not-a-jwt'],
  ])('rejects %s', async (_name, make) => {
    expect(errCode(await request(env.url).post('/api/auth/google').send({ credential: make() }))).toBe('auth.google_invalid');
  });

  it('links and unlinks from the account, with PIN and uniqueness rules', async () => {
    const nick = await env.login('nick');
    expect(errCode(await nick.post('/api/auth/google/link').send({ credential: credential(), pin: '0000' }))).toBe('auth.pin_wrong');
    const linked = ok(await nick.post('/api/auth/google/link').send({ credential: credential(), pin: '1234' }));
    expect(linked).toMatchObject({ google: { linked: true, email: 'maria@gmail.com' } });
    expect(errCode(await nick.post('/api/auth/google/link').send({ credential: credential({ sub: 'g-999' }), pin: '1234' })))
      .toBe('auth.google_already_linked');

    const eve = await env.login('eve');
    expect(errCode(await eve.post('/api/auth/google/link').send({ credential: credential(), pin: '1234' })))
      .toBe('auth.google_linked_elsewhere');

    // Signing in with Google replaces nick's other session (one device at a time).
    const viaGoogle = request.agent(env.url);
    expect(ok(await viaGoogle.post('/api/auth/google').send({ credential: credential() })).user.username).toBe('nick');
    expect(ok(await viaGoogle.delete('/api/auth/google/link'))).toMatchObject({ google: { linked: false, email: null } });
    expect(ok(await request(env.url).post('/api/auth/google').send({ credential: credential() })).needsRegistration).toBe(true);
  });

  it('forgets the Google link when the account is deleted', async () => {
    const nick = await env.login('nick');
    ok(await nick.post('/api/auth/google/link').send({ credential: credential(), pin: '1234' }));
    ok(await nick.post('/api/auth/delete-account').send({ pin: '1234' }));
    // A deleted account loses its Google link, so the identity is unknown again.
    expect(ok(await request(env.url).post('/api/auth/google').send({ credential: credential() })).needsRegistration).toBe(true);
  });
});
