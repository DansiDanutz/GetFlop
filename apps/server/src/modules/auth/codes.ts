import { and, desc, eq, isNull } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { authCodes } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { numericCode, sha256 } from './crypto.js';

export const CODE_TTL_MINUTES = 15;
export const MAX_CODE_ATTEMPTS = 5;

export type CodePurpose = 'register' | 'email_verify' | 'pin_reset';

interface IssueOptions {
  readonly purpose: CodePurpose;
  readonly target: string;
  readonly userId?: string;
  readonly payload?: Record<string, unknown>;
}

/** Stores a fresh code (replacing any pending one for the same target) and returns it and its id. */
export async function issueCode(ctx: AppContext, opts: IssueOptions): Promise<{ id: string; code: string }> {
  const code = numericCode(6);
  await ctx.db
    .update(authCodes)
    .set({ usedAt: ctx.now() })
    .where(and(eq(authCodes.purpose, opts.purpose), eq(authCodes.target, opts.target), isNull(authCodes.usedAt)));
  const [row] = await ctx.db
    .insert(authCodes)
    .values({
      purpose: opts.purpose,
      target: opts.target,
      userId: opts.userId,
      payload: opts.payload,
      codeHash: sha256(code),
      expiresAt: new Date(ctx.now().getTime() + CODE_TTL_MINUTES * 60_000),
    })
    .returning({ id: authCodes.id });
  return { id: row!.id, code };
}

/** Checks a code; on success marks it used and returns the row. */
export async function consumeCode(
  ctx: AppContext,
  where: { purpose: CodePurpose; target?: string; id?: string },
  code: string,
): Promise<typeof authCodes.$inferSelect> {
  const conditions = [eq(authCodes.purpose, where.purpose), isNull(authCodes.usedAt)];
  if (where.target) conditions.push(eq(authCodes.target, where.target));
  if (where.id) conditions.push(eq(authCodes.id, where.id));
  const [row] = await ctx.db.select().from(authCodes).where(and(...conditions)).orderBy(desc(authCodes.createdAt)).limit(1);
  if (!row) throw new AppError('auth.code_missing');
  if (row.expiresAt < ctx.now()) throw new AppError('auth.code_expired');
  if (row.attempts >= MAX_CODE_ATTEMPTS) throw new AppError('auth.code_attempts');
  if (row.codeHash !== sha256(code.trim())) {
    await ctx.db.update(authCodes).set({ attempts: row.attempts + 1 }).where(eq(authCodes.id, row.id));
    throw new AppError(row.attempts + 1 >= MAX_CODE_ATTEMPTS ? 'auth.code_attempts' : 'auth.code_invalid');
  }
  await ctx.db.update(authCodes).set({ usedAt: ctx.now() }).where(eq(authCodes.id, row.id));
  return row;
}
