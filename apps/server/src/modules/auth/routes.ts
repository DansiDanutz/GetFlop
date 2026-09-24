import { and, eq, ne, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { sessions, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { handle } from '../../http/respond.js';
import { rooms } from '../../realtime/events.js';
import { consumeCode, issueCode } from './codes.js';
import { hashSecret, sha256, verifySecret } from './crypto.js';
import {
  SESSION_COOKIE, createSession, currentUser, destroySession, setSessionCookie, tokenFrom, type AuthUser,
} from './session.js';
import { assertDisplayName, assertEmail, assertPin, assertUsername, langSchema } from './validation.js';

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 5;
/** Bump when the player terms change; users are asked to accept again. */
export const TERMS_VERSION = 1;

/** The user as the client sees it. Never includes secrets. */
export function publicUser(u: AuthUser) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName ?? u.username,
    role: u.isPlatformAdmin ? 'admin' : 'player',
    email: u.email,
    emailVerified: Boolean(u.emailVerifiedAt),
    language: u.language,
    activeClubId: u.activeClubId,
    playerCode: u.playerCode,
    termsRequired: !u.termsAcceptedAt,
  };
}

const registerSchema = z.object({
  username: z.string(),
  displayName: z.string().optional(),
  pin: z.string(),
  email: z.string().optional(),
  adult: z.boolean().optional(),
  acceptTerms: z.boolean().optional(),
  marketingEmail: z.boolean().optional(),
  lang: langSchema,
});

async function findByUsername(ctx: AppContext, username: string): Promise<AuthUser | undefined> {
  const [row] = await ctx.db.select().from(users).where(sql`lower(${users.username}) = lower(${username})`).limit(1);
  return row;
}

async function assertAvailable(ctx: AppContext, username: string, email: string): Promise<void> {
  if (await findByUsername(ctx, username)) throw new AppError('auth.username_taken', 409);
  const [taken] = await ctx.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (taken) throw new AppError('auth.email_taken', 409);
}

/** Signs in: one device at a time, so every other session is revoked and told. */
async function startSession(ctx: AppContext, user: AuthUser, userAgent: string | undefined, reason = 'other_device') {
  const others = await ctx.db.delete(sessions).where(eq(sessions.userId, user.id)).returning({ id: sessions.id });
  if (others.length > 0) ctx.events.emit(rooms.user(user.id), 'session:ended', { reason, deviceLabel: deviceLabel(userAgent) });
  return createSession(ctx, user.id, userAgent);
}

export function deviceLabel(ua: string | undefined): string {
  if (!ua) return 'other';
  if (/iPad/.test(ua)) return 'ipad';
  if (/iPhone/.test(ua)) return 'iphone';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh/.test(ua)) return 'mac';
  if (/Linux/.test(ua)) return 'linux';
  return 'other';
}

export function authRouter(ctx: AppContext): Router {
  const r = Router();

  r.post('/register/code', handle(async (req) => {
    const body = registerSchema.parse(req.body);
    const username = assertUsername(body.username.trim());
    const displayName = assertDisplayName(body.displayName ?? username);
    assertPin(body.pin);
    if (!body.adult || !body.acceptTerms) throw new AppError('auth.terms_required');
    const email = assertEmail(body.email);
    await assertAvailable(ctx, username, email);
    const { id, code } = await issueCode(ctx, {
      purpose: 'register',
      target: email,
      payload: { username, displayName, pinHash: await hashSecret(body.pin), marketing: Boolean(body.marketingEmail), lang: body.lang ?? 'en' },
    });
    await sendCode(ctx, email, code, 'Your GetFlop registration code');
    return { registrationId: id };
  }));

  r.post('/register', handle(async (req, res) => {
    const body = z.object({ registrationId: z.string(), code: z.string() }).parse(req.body);
    const row = await consumeCode(ctx, { purpose: 'register', id: body.registrationId }, body.code);
    const p = row.payload as { username: string; displayName: string; pinHash: string; marketing: boolean; lang: string };
    await assertAvailable(ctx, p.username, row.target!);
    const [user] = await ctx.db.insert(users).values({
      username: p.username,
      displayName: p.displayName,
      pinHash: p.pinHash,
      email: row.target,
      emailVerifiedAt: ctx.now(),
      language: p.lang,
      marketingConsent: p.marketing,
      termsAcceptedAt: ctx.now(),
    }).returning();
    const token = await createSession(ctx, user!.id, req.get('user-agent'));
    setSessionCookie(ctx, res, token);
    return { token, user: publicUser(user!) };
  }));

  r.post('/login', handle(async (req, res) => {
    const body = z.object({ username: z.string(), pin: z.string(), lang: langSchema }).parse(req.body);
    const user = await findByUsername(ctx, body.username.trim());
    if (!user || user.deletedAt) throw new AppError('auth.pin_wrong', 401);
    if (!user.isActive) throw new AppError('auth.account_inactive', 403);
    if (user.lockedUntil && user.lockedUntil > ctx.now()) throw new AppError('auth.too_many', 429);
    if (!(await verifySecret(body.pin, user.pinHash))) {
      const failed = user.failedLogins + 1;
      const locked = failed >= MAX_FAILED_LOGINS;
      await ctx.db.update(users).set({
        failedLogins: locked ? 0 : failed,
        lockedUntil: locked ? new Date(ctx.now().getTime() + LOCK_MINUTES * 60_000) : null,
      }).where(eq(users.id, user.id));
      throw new AppError(locked ? 'auth.too_many' : 'auth.pin_wrong', locked ? 429 : 401);
    }
    const [fresh] = await ctx.db.update(users)
      .set({ failedLogins: 0, lockedUntil: null, ...(body.lang ? { language: body.lang } : {}) })
      .where(eq(users.id, user.id)).returning();
    const token = await startSession(ctx, fresh!, req.get('user-agent'));
    setSessionCookie(ctx, res, token);
    return { token, user: publicUser(fresh!) };
  }));

  r.post('/logout', handle(async (req, res) => {
    await destroySession(ctx, tokenFrom(req));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return {};
  }));

  r.get('/me', handle((req) => ({ user: publicUser(currentUser(req)) })));

  r.put('/display-name', handle(async (req) => {
    const user = currentUser(req);
    const displayName = assertDisplayName(z.object({ displayName: z.string() }).parse(req.body).displayName);
    const [updated] = await ctx.db.update(users).set({ displayName }).where(eq(users.id, user.id)).returning();
    return { user: publicUser(updated!) };
  }));

  r.post('/pin/change', handle(async (req) => {
    const user = currentUser(req);
    const body = z.object({ pin: z.string(), newPin: z.string() }).parse(req.body);
    if (!(await verifySecret(body.pin, user.pinHash))) throw new AppError('auth.pin_wrong', 401);
    assertPin(body.newPin);
    await ctx.db.update(users).set({ pinHash: await hashSecret(body.newPin) }).where(eq(users.id, user.id));
    const current = tokenFrom(req);
    await ctx.db.delete(sessions).where(and(eq(sessions.userId, user.id), ne(sessions.id, sha256(current ?? ''))));
    ctx.events.emit(rooms.user(user.id), 'session:ended', { reason: 'pin_change' });
    return {};
  }));

  r.post('/pin-reset/request', handle(async (req) => {
    const body = z.object({ username: z.string() }).parse(req.body);
    const user = await findByUsername(ctx, body.username.trim());
    // Neutral response whether or not the account exists.
    if (user?.email && user.emailVerifiedAt && user.isActive) {
      const { code } = await issueCode(ctx, { purpose: 'pin_reset', target: user.id, userId: user.id });
      await sendCode(ctx, user.email, code, 'Your GetFlop PIN reset code');
    }
    return {};
  }));

  r.post('/pin-reset/confirm', handle(async (req) => {
    const body = z.object({ username: z.string(), code: z.string(), newPin: z.string() }).parse(req.body);
    assertPin(body.newPin);
    const user = await findByUsername(ctx, body.username.trim());
    if (!user) throw new AppError('auth.code_missing');
    await consumeCode(ctx, { purpose: 'pin_reset', target: user.id }, body.code);
    await ctx.db.update(users).set({ pinHash: await hashSecret(body.newPin), failedLogins: 0, lockedUntil: null })
      .where(eq(users.id, user.id));
    await ctx.db.delete(sessions).where(eq(sessions.userId, user.id));
    ctx.events.emit(rooms.user(user.id), 'session:ended', { reason: 'pin_reset' });
    return {};
  }));

  r.get('/identity', handle((req) => {
    const user = currentUser(req);
    return {
      email: user.email,
      emailVerified: Boolean(user.emailVerifiedAt),
      google: { linked: Boolean(user.googleSub) },
      googleEnabled: Boolean(process.env.GOOGLE_CLIENT_ID),
      marketingEmail: Boolean(user.marketingConsent),
    };
  }));

  r.post('/email', handle(async (req) => {
    const user = currentUser(req);
    const body = z.object({ email: z.string(), pin: z.string() }).parse(req.body);
    if (!(await verifySecret(body.pin, user.pinHash))) throw new AppError('auth.pin_wrong', 401);
    const email = assertEmail(body.email);
    const [taken] = await ctx.db.select({ id: users.id }).from(users)
      .where(and(sql`lower(${users.email}) = ${email}`, ne(users.id, user.id))).limit(1);
    if (taken) throw new AppError('auth.email_taken', 409);
    const { code } = await issueCode(ctx, { purpose: 'email_verify', target: user.id, userId: user.id, payload: { email } });
    await sendCode(ctx, email, code, 'Confirm your GetFlop email');
    return {};
  }));

  r.post('/email/verify', handle(async (req) => {
    const user = currentUser(req);
    const body = z.object({ code: z.string() }).parse(req.body);
    const row = await consumeCode(ctx, { purpose: 'email_verify', target: user.id }, body.code);
    const email = (row.payload as { email: string }).email;
    const [updated] = await ctx.db.update(users).set({ email, emailVerifiedAt: ctx.now() }).where(eq(users.id, user.id)).returning();
    return { user: publicUser(updated!) };
  }));

  r.post('/consent', handle(async (req) => {
    const user = currentUser(req);
    const parsed = z.object({ marketingEmail: z.boolean() }).safeParse(req.body);
    if (!parsed.success) throw new AppError('auth.consent_invalid');
    await ctx.db.update(users).set({ marketingConsent: parsed.data.marketingEmail }).where(eq(users.id, user.id));
    return {};
  }));

  r.get('/terms', handle((req) => ({ required: !currentUser(req).termsAcceptedAt, version: TERMS_VERSION })));

  r.post('/accept-terms', handle(async (req) => {
    const user = currentUser(req);
    const body = z.object({ adult: z.boolean(), acceptTerms: z.boolean() }).parse(req.body);
    if (!body.adult || !body.acceptTerms) throw new AppError('auth.terms_required');
    await ctx.db.update(users).set({ termsAcceptedAt: ctx.now() }).where(eq(users.id, user.id));
    return {};
  }));

  r.get('/google/config', handle(() => ({
    enabled: Boolean(process.env.GOOGLE_CLIENT_ID),
    clientId: process.env.GOOGLE_CLIENT_ID ?? null,
  })));

  return r;
}

async function sendCode(ctx: AppContext, to: string, code: string, subject: string): Promise<void> {
  try {
    await ctx.mailer.send({ to, subject, text: `Your code is ${code}. It expires in 15 minutes.` });
  } catch (err) {
    ctx.logger.error('Email send failed', err);
    throw new AppError('auth.email_send_failed', 502);
  }
}
