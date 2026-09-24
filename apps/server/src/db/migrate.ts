import { createRequire } from 'node:module';
import type { Db } from './client.js';
import * as schema from './schema/index.js';

const require = createRequire(import.meta.url);

interface DrizzleKitApi {
  generateDrizzleJson(s: Record<string, unknown>): unknown;
  generateMigration(prev: unknown, next: unknown): Promise<string[]>;
  pushSchema(s: Record<string, unknown>, db: unknown): Promise<{ apply(): Promise<void>; hasDataLoss: boolean }>;
}
const kit = (): DrizzleKitApi => require('drizzle-kit/api') as DrizzleKitApi;

/** Full DDL for an empty database (fast; used by tests and first boot). */
export async function schemaDdl(): Promise<string[]> {
  const { generateDrizzleJson, generateMigration } = kit();
  return generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema as Record<string, unknown>));
}

/** Brings an existing database up to the current schema (dev and single-node deploys). */
export async function pushSchema(db: Db): Promise<void> {
  const result = await kit().pushSchema(schema as Record<string, unknown>, db);
  if (result.hasDataLoss && process.env.ALLOW_SCHEMA_DATA_LOSS !== '1') {
    throw new Error('Schema change would lose data. Set ALLOW_SCHEMA_DATA_LOSS=1 to apply.');
  }
  await result.apply();
}
