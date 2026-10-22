import { eq } from 'drizzle-orm';
import { vi } from 'vitest';
import { clubBilling, clubs, diamondLedger } from '../../db/schema/index.js';
import { ok, type Agent, type TestEnv } from '../../test/harness.js';
import { DAY_MS } from './config.js';

/** Test-only helpers for the commerce tests (not a test file itself). */
export const COMMERCE_ENV_KEYS = [
  'COMMERCE_PILOT', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_TAX', 'COMMERCE_DEV_PAYMENTS',
] as const;

/** Every test starts with no Stripe key, no dev payments and the pilot ON (the defaults). */
export function resetCommerceEnv(): void {
  vi.unstubAllEnvs();
  for (const key of COMMERCE_ENV_KEYS) vi.stubEnv(key, '');
}

/** Switches the server pilot off and the club to enforced billing (through the admin API). */
export async function enforce(env: TestEnv, clubId: string): Promise<Agent> {
  vi.stubEnv('COMMERCE_PILOT', '0');
  const admin = await env.login('admin', { admin: true });
  ok(await admin.put(`/api/commerce/admin/clubs/${clubId}/enforcement`).send({ enabled: true }));
  return admin;
}

export async function topup(admin: Agent, clubId: string, diamonds: number, reference = 'BANK-1'): Promise<void> {
  ok(await admin.post(`/api/commerce/admin/clubs/${clubId}/topup`).send({ diamonds, reference }));
}

export const days = (n: number): number => n * DAY_MS;

export async function balance(env: TestEnv, clubId: string): Promise<number> {
  const [c] = await env.db.select({ b: clubs.diamondsBalance }).from(clubs).where(eq(clubs.id, clubId));
  return c!.b;
}

export async function ledgerTypes(env: TestEnv, clubId: string): Promise<string[]> {
  const rows = await env.db.select().from(diamondLedger).where(eq(diamondLedger.clubId, clubId)).orderBy(diamondLedger.createdAt);
  return rows.map((r) => r.type);
}

export async function billingRow(env: TestEnv, clubId: string) {
  const [b] = await env.db.select().from(clubBilling).where(eq(clubBilling.clubId, clubId));
  return b!;
}

/** Level product id by code, from the owner's pricing table. */
export async function levelId(owner: Agent, code: string): Promise<string> {
  const { levels } = ok(await owner.get('/api/commerce/club/dashboard'));
  const level = levels.find((l: { code: string }) => l.code === code);
  if (!level) throw new Error(`No level ${code}`);
  return level.productId as string;
}
