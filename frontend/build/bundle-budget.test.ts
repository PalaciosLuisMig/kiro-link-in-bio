import { describe, expect, test } from 'vitest';

import { checkBundleBudget, PUBLIC_BUDGET, type PublicBundle } from './bundle-budget.js';

// Tests of the public bundle budget (task 14.8): the guard that makes the build
// fail when Zod reaches the public page or the bundle grows past 30 KB gzip.
//
// Validates: Requirement 13.1.

const APP_MODULES = [
  '/repo/frontend/src/public/main.ts',
  '/repo/frontend/src/public/page.ts',
  '/repo/shared/dist/constants.js',
];

function bundle(overrides: Partial<PublicBundle> = {}): PublicBundle {
  return { gzipBytes: 2000, moduleIds: APP_MODULES, ...overrides };
}

describe('checkBundleBudget', () => {
  test('a small bundle without Zod is within budget', () => {
    expect(checkBundleBudget(bundle(), PUBLIC_BUDGET)).toEqual([]);
  });

  test('the budget is 30 KB gzip and forbids Zod', () => {
    expect(PUBLIC_BUDGET.maxGzipBytes).toBe(30 * 1024);
    expect(PUBLIC_BUDGET.forbiddenPackages).toContain('zod');
  });

  test('a bundle that includes Zod fails, even if it is small', () => {
    const problems = checkBundleBudget(
      bundle({ moduleIds: [...APP_MODULES, '/repo/node_modules/zod/v4/core/schemas.js'] }),
      PUBLIC_BUDGET,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"zod"');
    expect(problems[0]).toContain('tree-shaken');
  });

  test('detects Zod in a Windows-style path too', () => {
    const problems = checkBundleBudget(
      bundle({ moduleIds: ['C:\\repo\\node_modules\\zod\\index.js'] }),
      PUBLIC_BUDGET,
    );
    expect(problems).toHaveLength(1);
  });

  test('does not confuse a package whose name only contains "zod"', () => {
    const problems = checkBundleBudget(
      bundle({ moduleIds: ['/repo/node_modules/zodiac/index.js', '/repo/src/zod-like.ts'] }),
      PUBLIC_BUDGET,
    );
    expect(problems).toEqual([]);
  });

  test('exactly 30 KB passes and one byte more fails', () => {
    expect(checkBundleBudget(bundle({ gzipBytes: 30 * 1024 }), PUBLIC_BUDGET)).toEqual([]);
    const problems = checkBundleBudget(bundle({ gzipBytes: 30 * 1024 + 1 }), PUBLIC_BUDGET);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('above the budget');
  });

  test('reports every violation at once', () => {
    const problems = checkBundleBudget(
      bundle({ gzipBytes: 40_000, moduleIds: ['/repo/node_modules/zod/index.js'] }),
      PUBLIC_BUDGET,
    );
    expect(problems).toHaveLength(2);
  });
});
