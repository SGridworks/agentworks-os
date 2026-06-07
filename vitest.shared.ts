import type { InlineConfig } from 'vitest';

// Shared vitest test config for every package in this workspace.
// Reason: package-level configs with default worker pools can exhaust local
// development machines when multiple agent runs trigger tests concurrently.
// singleFork forces one process per package run; the root package.json caps
// workspace concurrency at 1 so packages run sequentially.
export const sharedTestConfig = {
  globals: true,
  environment: 'node',
  pool: 'forks',
  poolOptions: {
    forks: {
      singleFork: true,
      maxForks: 1,
    },
  },
} satisfies InlineConfig;
