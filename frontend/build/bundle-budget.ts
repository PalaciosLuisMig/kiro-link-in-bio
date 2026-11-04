// Budget of the public bundle (task 14.8): a guard of Requirement 13.1 (the list
// must be visible within 2 s on a mobile network).
//
// Pure on purpose, with no Node imports: the gzip size is measured by the caller
// (the Vite plugin in `vite.config.ts`), so this logic is tested without a build.

/** What the public page ships: the JS and CSS reachable from `index.html`. */
export interface PublicBundle {
  /** Total gzip size, in bytes, of those files. */
  readonly gzipBytes: number;
  /** Ids (paths) of every module bundled into those files. */
  readonly moduleIds: readonly string[];
}

export interface BudgetOptions {
  /** Largest allowed gzip size, in bytes. */
  readonly maxGzipBytes: number;
  /** Package folders that must not reach the public bundle, e.g. `zod`. */
  readonly forbiddenPackages: readonly string[];
}

/** The budget of the public page: 30 KB gzip and no Zod (it is for the API). */
export const PUBLIC_BUDGET: BudgetOptions = {
  maxGzipBytes: 30 * 1024,
  forbiddenPackages: ['zod'],
};

/** Module ids use `/` on every platform for the comparison. */
function normalize(id: string): string {
  return id.replaceAll('\\', '/');
}

/**
 * Checks the bundle against the budget. Returns one message per violation, or an
 * empty array when the bundle is within budget.
 */
export function checkBundleBudget(bundle: PublicBundle, options: BudgetOptions): string[] {
  const problems: string[] = [];

  for (const name of options.forbiddenPackages) {
    const offending = bundle.moduleIds
      .map(normalize)
      .find((id) => id.includes(`/node_modules/${name}/`));
    if (offending !== undefined) {
      problems.push(
        `the public bundle includes "${name}" (${offending}); ` +
          `import only types and constants from shared/ so it is tree-shaken`,
      );
    }
  }

  if (bundle.gzipBytes > options.maxGzipBytes) {
    problems.push(
      `the public bundle is ${bundle.gzipBytes} bytes gzip, above the budget of ` +
        `${options.maxGzipBytes} bytes`,
    );
  }

  return problems;
}
