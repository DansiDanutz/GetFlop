import { and, eq, gt } from 'drizzle-orm';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppContext } from '../../context.js';
import { sessions, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { newToken, sha256 } from './crypto.js';

export const SESSION_COOKIE = 'gf_session';
const SESSION_DAYS = 30;

export type AuthUser = typeof users.$inferSelect;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
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

/** Attaches req.user when a valid session is present. Never rejects. */
export function loadUser(ctx: AppContext): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.user = (await userFromToken(ctx, tokenFrom(req))) ?? undefined;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new AppError('auth.required', 401);
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
