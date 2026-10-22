import { and, eq, gt, lte } from 'drizzle-orm';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppContext } from '../../context.js';
import { sessionRevocations, sessions, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { newToken, sha256 } from './crypto.js';

export const SESSION_COOKIE = 'gf_session';
const SESSION_DAYS = 30;

export type AuthUser = typeof users.$inferSelect;

/** Why a presented token no longer works (401 auth.session_ended / session.expired). */
export type SessionProblem =
  | { readonly kind: 'ended'; readonly reason: string; readonly deviceLabel: string | null }
  | { readonly kind: 'expired' };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionProblem?: SessionProblem;
    }
  }
}

export async function createSession(ctx: AppContext, userId: string, userAgent?: string): Promise<string> {
  const token = newToken();
  const expiresAt = new Date(ctx.now().getTime() + SESSION_DAYS * 86_400_000);
  await ctx.db.insert(sessions).values({ id: sha256(token), userId, expiresAt, userAgent });
  return token;
}

export function setSessionCookie(ctx: AppContext, res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.secureCookies,
    maxAge: SESSION_DAYS * 86_400_000,
    path: '/',
  });
}

export async function userFromToken(ctx: AppContext, token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const rows = await ctx.db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, ctx.now())))
    .limit(1);
  const user = rows[0]?.user;
  return user && user.isActive && !user.deletedAt ? user : null;
}

export function tokenFrom(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
}

/** For a token that did not resolve to a user: was it revoked, or has it expired? */
export async function sessionProblem(ctx: AppContext, token: string | undefined): Promise<SessionProblem | undefined> {
  if (!token) return undefined;
  const id = sha256(token);
  const [revoked] = await ctx.db.select().from(sessionRevocations).where(eq(sessionRevocations.id, id)).limit(1);
  if (revoked) return { kind: 'ended', reason: revoked.reason, deviceLabel: revoked.deviceLabel };
  const [expired] = await ctx.db.select({ id: sessions.id }).from(sessions)
    .where(and(eq(sessions.id, id), lte(sessions.expiresAt, ctx.now()))).limit(1);
  return expired ? { kind: 'expired' } : undefined;
}

/** Attaches req.user when a valid session is present, or the reason it is not. Never rejects. */
export function loadUser(ctx: AppContext): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = tokenFrom(req);
      req.user = (await userFromToken(ctx, token)) ?? undefined;
      if (!req.user) req.sessionProblem = await sessionProblem(ctx, token);
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) {
    const problem = req.sessionProblem;
    if (problem?.kind === 'expired') throw new AppError('session.expired', 401);
    if (problem?.kind === 'ended') {
      throw new AppError('auth.session_ended', 401, {
        reason: problem.reason, ...(problem.deviceLabel ? { deviceLabel: problem.deviceLabel } : {}),
      });
    }
    throw new AppError('auth.required', 401);
  }
  return req.user;
}

export function requireAdmin(req: Request): AuthUser {
  const user = currentUser(req);
  if (!user.isPlatformAdmin) throw new AppError('auth.forbidden', 403);
  return user;
}

export async function destroySession(ctx: AppContext, token: string | undefined): Promise<void> {
  if (token) await ctx.db.delete(sessions).where(eq(sessions.id, sha256(token)));
}
