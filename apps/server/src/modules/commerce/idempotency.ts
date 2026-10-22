import { and, eq } from 'drizzle-orm';
import type { Request } from 'express';
import type { Tx } from '../../db/client.js';
import { commerceIdempotency } from '../../db/schema/index.js';

const MAX_KEY_LENGTH = 200;

/** The Idempotency-Key header, when present and sane. */
export function idempotencyKey(req: Request): string | null {
  const key = req.header('idempotency-key')?.trim();
  return key && key.length <= MAX_KEY_LENGTH ? key : null;
}

/**
 * Runs `fn` once per (scope, key) inside the caller's transaction and replays the stored
 * response for a repeated key. Without a key the action simply runs.
 */
export async function once<T>(tx: Tx, scope: string, key: string | null, at: Date, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  const [seen] = await tx.select().from(commerceIdempotency)
    .where(and(eq(commerceIdempotency.scope, scope), eq(commerceIdempotency.key, key)));
  if (seen) return seen.response as T;
  const result = await fn();
  await tx.insert(commerceIdempotency).values({ scope, key, response: JSON.parse(JSON.stringify(result ?? null)), createdAt: at });
  return result;
}
