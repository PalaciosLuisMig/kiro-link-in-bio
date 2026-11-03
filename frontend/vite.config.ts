import { gzipSync } from 'node:zlib';

import { defineConfig, type Plugin } from 'vite';

import { checkBundleBudget, PUBLIC_BUDGET } from './build/bundle-budget.js';

/** Normalizes the separators of a module id or file path. */
const slashes = (value: string): string => value.replaceAll('\\', '/');

/**
 * Fails the build when the public page ships Zod or grows past its gzip budget
 * (task 14.8, Requirement 13.1).
 *
 * It measures what `index.html` really loads: the entry chunk, every chunk it
 * imports, and its CSS. Other pages (the Panel, task 15) are not counted.
 */
function publicBundleBudget(): Plugin {
  return {
    name: 'public-bundle-budget',
    apply: 'build',
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find(
        (item) =>
          item.type === 'chunk' &&
          item.isEntry &&
          slashes(item.facadeModuleId ?? '').endsWith('/index.html'),
      );
      if (entry === undefined || entry.type !== 'chunk') {
        this.error('public-bundle-budget: the entry chunk of index.html was not found');
      }

      const seen = new Set<string>();
      const visit = (fileName: string): void => {
        if (seen.has(fileName)) {
          return;
        }
        seen.add(fileName);
        const item = bundle[fileName];
        if (item?.type === 'chunk') {
          item.imports.forEach(visit);
          item.viteMetadata?.importedCss.forEach((css) => seen.add(css));
        }
      };
      visit(entry.fileName);

      let gzipBytes = 0;
      const moduleIds: string[] = [];
      for (const fileName of seen) {
        const item = bundle[fileName];
        if (item?.type === 'chunk') {
          gzipBytes += gzipSync(item.code).length;
          moduleIds.push(...Object.keys(item.modules));
        } else if (item?.type === 'asset') {
          gzipBytes += gzipSync(item.source).length;
        }
      }

      const problems = checkBundleBudget({ gzipBytes, moduleIds }, PUBLIC_BUDGET);
      if (problems.length > 0) {
        this.error(`public-bundle-budget: ${problems.join('; ')}`);
      }
      this.info(
        `public bundle: ${gzipBytes} bytes gzip of ${PUBLIC_BUDGET.maxGzipBytes} allowed, no Zod`,
      );
    },
  };
}

// Multipage build; the HTML entry points live at the frontend root.
// The public page is here; the owner dashboard (`panel.html`) arrives in task 15.
export default defineConfig({
  plugins: [publicBundleBudget()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        index: new URL('./index.html', import.meta.url).pathname,
      },
    },
  },
});
