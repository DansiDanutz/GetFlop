import { sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import type { AuthUser } from './session.js';

/** Google sign-in is on only when GOOGLE_CLIENT_ID is configured (read per request). */
export function googleClientId(): string | null {
  return process.env.GOOGLE_CLIENT_ID?.trim() || null;
}

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

/** Sign-in methods and email state for the account page. */
export function identityOf(u: AuthUser) {
  return {
    email: u.email,
    emailVerified: Boolean(u.emailVerifiedAt),
    google: { linked: Boolean(u.googleSub), email: u.googleSub ? u.googleEmail : null },
    googleEnabled: Boolean(googleClientId()),
    marketingEmail: Boolean(u.marketingConsent),
  };
}

export async function findByUsername(ctx: AppContext, username: string): Promise<AuthUser | undefined> {
  const [row] = await ctx.db.select().from(users).where(sql`lower(${users.username}) = lower(${username})`).limit(1);
  return row;
}

export async function emailOwner(db: DbOrTx, email: string): Promise<string | null> {
  const [row] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`).limit(1);
  return row?.id ?? null;
}

export async function assertAvailable(ctx: AppContext, username: string, email: string): Promise<void> {
  if (await findByUsername(ctx, username)) throw new AppError('auth.username_taken', 409);
  if (await emailOwner(ctx.db, email)) throw new AppError('auth.email_taken', 409);
}
