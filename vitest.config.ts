import { defineConfig } from 'vitest/config';

// A deterministic timezone keeps minute-bucket math stable across machines.
process.env.TZ ??= 'UTC';
// fast-check run count: 100 by default; the save hook lowers it to 20.
process.env.FC_NUM_RUNS ??= '100';

export default defineConfig({
  test: {
    // Find the *.test.ts of every workspace (shared, frontend, backend, infra).
    include: ['{shared,frontend,backend,infra}/**/*.test.ts'],
    environment: 'node',
    env: {
      TZ: process.env.TZ,
      FC_NUM_RUNS: process.env.FC_NUM_RUNS,
    },
  },
});
