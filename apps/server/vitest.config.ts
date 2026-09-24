import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { name: 'server', include: ['src/**/*.test.ts'], testTimeout: 20_000, hookTimeout: 30_000, pool: 'forks' },
});
