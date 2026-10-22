import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import type { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { handle } from '../../http/respond.js';
import { emailOwner, findByUsername, googleClientId, identityOf, publicUser } from './accounts.js';
import { consumeCode, issueCode } from './codes.js';
import { hashSecret, verifySecret } from './crypto.js';
import { startSession } from './revocation.js';
import { currentUser, setSessionCookie } from './session.js';
import { assertDisplayName, assertPin, assertUsername, langSchema } from './validation.js';

export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS: ReadonlySet<string> = new Set(['accounts.google.com', 'https://accounts.google.com']);
const FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_SECONDS = 3_600;
/** Tolerated clock difference for "issued at" in the future. */
const MAX_IAT_SKEW_S = 300;

export interface Jwk {
  readonly kty: string;
  readonly n: string;
  readonly e: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly use?: string;
}

export interface GoogleIdentity {
  readonly sub: string;
  readonly email: string;
}

type KeySource = (opts: { refresh: boolean }) => Promise<readonly Jwk[]>;

let cache: { keys: readonly Jwk[]; until: number } | null = null;

/** Google's public signing keys, cached for as long as Google's Cache-Control allows. */
const fetchGoogleKeys: KeySource = async ({ refresh }) => {
  if (cache && !refresh && cache.until > Date.now()) return cache.keys;
  const res = await fetch(GOOGLE_CERTS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Google certs HTTP ${res.status}`);
  const body = z.object({ keys: z.array(z.object({ kty: z.string(), n: z.string(), e: z.string(), kid: z.string().optional(), alg: z.string().optional() })) })
    .parse(await res.json());
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? DEFAULT_CACHE_SECONDS);
  cache = { keys: body.keys, until: Date.now() + maxAge * 1000 };
  return body.keys;
};

let keySource: KeySource = fetchGoogleKeys;

/** Test seam: replace where public keys come from (null restores Google's endpoint). */
export function setGoogleKeySource(source: (() => Promise<readonly Jwk[]>) | null): void {
  keySource = source ? () => source() : fetchGoogleKeys;
  cache = null;
}

// 400, not 401: a bad Google token must not look like a lost session to a signed-in client.
const invalid = (): AppError => new AppError('auth.google_invalid', 400);

function decodePart(part: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw invalid();
}

async function keyFor(ctx: AppContext, kid: string): Promise<Jwk> {
  try {
    const found = (await keySource({ refresh: false })).find((k) => k.kid === kid);
    if (found) return found;
    const refreshed = (await keySource({ refresh: true })).find((k) => k.kid === kid);
    if (refreshed) return refreshed;
  } catch (err) {
    ctx.logger.error('Google key fetch failed', err);
    throw new AppError('auth.google_invalid', 503);
  }
  throw invalid();
}

const claimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().min(1),
  email: z.string().min(3),
  email_verified: z.union([z.boolean(), z.literal('true'), z.literal('false')]),
  exp: z.number(),
  iat: z.number().optional(),
});

/** Verifies a Google ID token (RS256, Google's keys, issuer, audience, expiry, verified email). */
export async function verifyGoogleCredential(ctx: AppContext, credential: string, clientId: string): Promise<GoogleIdentity> {
  const parts = credential.split('.');
  if (parts.length !== 3) throw invalid();
  const [head, body, sig] = parts as [string, string, string];
  const header = decodePart(head);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw invalid();
  const jwk = await keyFor(ctx, header.kid);
  let good = false;
  try {
    const key = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
    good = verifySignature('RSA-SHA256', Buffer.from(`${head}.${body}`), key, Buffer.from(sig, 'base64url'));
  } catch {
    good = false;
  }
  if (!good) throw invalid();
  const parsed = claimsSchema.safeParse(decodePart(body));
  if (!parsed.success) throw invalid();
  const c = parsed.data;
  const nowS = ctx.now().getTime() / 1000;
  const audiences = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!GOOGLE_ISSUERS.has(c.iss) || !audiences.includes(clientId)) throw invalid();
  if (c.exp <= nowS || (c.iat !== undefined && c.iat > nowS + MAX_IAT_SKEW_S)) throw invalid();
  if (c.email_verified !== true && c.email_verified !== 'true') throw invalid();
  return { sub: c.sub, email: c.email.trim().toLowerCase() };
}

function requireGoogle(): string {
  const clientId = googleClientId();
  if (!clientId) throw new AppError('auth.google_disabled', 403);
  return clientId;
}

/** A username suggestion from the email's local part (3–20 allowed characters). */
export function suggestUsername(email: string): string {
  const base = (email.split('@')[0] ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 20);
  return base.length >= 3 ? base : `${base}player`.slice(0, 20);
}

const REG_TOKEN_SEP = '.';

async function consumeRegistration(ctx: AppContext, token: string): Promise<GoogleIdentity> {
  const [id, code, extra] = token.split(REG_TOKEN_SEP);
  if (!id || !code || extra !== undefined) throw new AppError('auth.google_expired');
  try {
    const row = await consumeCode(ctx, { purpose: 'google_register', id }, code);
    return row.payload as unknown as GoogleIdentity;
  } catch (err) {
    if (err instanceof AppError && err.code.startsWith('auth.code_')) throw new AppError('auth.google_expired');
    throw err;
  }
}

const registerBody = z.object({
  registrationToken: z.string(),
  username: z.string(),
  displayName: z.string().optional(),
  pin: z.string(),
  adult: z.boolean().optional(),
  acceptTerms: z.boolean().optional(),
  marketingEmail: z.boolean().optional(),
  lang: langSchema,
});

/** Google sign-in, finish-account, link and unlink. Mounted on the /auth router. */
export function googleRoutes(r: Router, ctx: AppContext): void {
  r.get('/google/config', handle(() => {
    const clientId = googleClientId();
    return { enabled: Boolean(clientId), clientId };
  }));

  r.post('/google', handle(async (req, res) => {
    const clientId = requireGoogle();
    const body = z.object({ credential: z.string().max(10_000), lang: langSchema }).parse(req.body);
    const identity = await verifyGoogleCredential(ctx, body.credential, clientId);
    const [linked] = await ctx.db.select().from(users).where(eq(users.googleSub, identity.sub)).limit(1);
    if (linked) {
      if (!linked.isActive || linked.deletedAt) throw new AppError('auth.account_inactive', 403);
      const token = await startSession(ctx, linked, req.get('user-agent'));
      setSessionCookie(ctx, res, token);
      return { token, user: publicUser(linked) };
    }
    const { id, code } = await issueCode(ctx, { purpose: 'google_register', target: identity.sub, payload: { ...identity } });
    return {
      needsRegistration: true, registrationToken: `${id}${REG_TOKEN_SEP}${code}`, email: identity.email,
      suggestedUsername: suggestUsername(identity.email), emailTaken: Boolean(await emailOwner(ctx.db, identity.email)),
    };
  }));

  r.post('/google/register', handle(async (req, res) => {
    requireGoogle();
    const body = registerBody.parse(req.body);
    const username = assertUsername(body.username.trim());
    const displayName = assertDisplayName(body.displayName || username);
    assertPin(body.pin);
    if (!body.adult || !body.acceptTerms) throw new AppError('auth.terms_required');
    if (await findByUsername(ctx, username)) throw new AppError('auth.username_taken', 409);
    const identity = await consumeRegistration(ctx, body.registrationToken);
    if (await emailOwner(ctx.db, identity.email)) throw new AppError('auth.email_taken', 409);
    const [elsewhere] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.googleSub, identity.sub)).limit(1);
    if (elsewhere) throw new AppError('auth.google_linked_elsewhere', 409);
    const [user] = await ctx.db.insert(users).values({
      username, displayName, pinHash: await hashSecret(body.pin), email: identity.email, emailVerifiedAt: ctx.now(),
      googleSub: identity.sub, googleEmail: identity.email, language: body.lang ?? 'en',
      marketingConsent: Boolean(body.marketingEmail), termsAcceptedAt: ctx.now(),
    }).returning();
    const token = await startSession(ctx, user!, req.get('user-agent'));
    setSessionCookie(ctx, res, token);
    return { token, user: publicUser(user!) };
  }));

  r.post('/google/link', handle(async (req) => {
    const user = currentUser(req);
    const clientId = requireGoogle();
    const body = z.object({ credential: z.string().max(10_000), pin: z.string() }).parse(req.body);
    if (!(await verifySecret(body.pin, user.pinHash))) throw new AppError('auth.pin_wrong', 403);
    const identity = await verifyGoogleCredential(ctx, body.credential, clientId);
    if (user.googleSub && user.googleSub !== identity.sub) throw new AppError('auth.google_already_linked', 409);
    const [elsewhere] = await ctx.db.select({ id: users.id }).from(users)
      .where(and(eq(users.googleSub, identity.sub), ne(users.id, user.id))).limit(1);
    if (elsewhere) throw new AppError('auth.google_linked_elsewhere', 409);
    const [updated] = await ctx.db.update(users).set({ googleSub: identity.sub, googleEmail: identity.email })
      .where(eq(users.id, user.id)).returning();
    return identityOf(updated!);
  }));

  r.delete('/google/link', handle(async (req) => {
    const user = currentUser(req);
    const [updated] = await ctx.db.update(users).set({ googleSub: null, googleEmail: null }).where(eq(users.id, user.id)).returning();
    return identityOf(updated!);
  }));
}
