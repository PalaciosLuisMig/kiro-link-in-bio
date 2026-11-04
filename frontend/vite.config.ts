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

/**
 * Where the local API server listens (`npm run dev:api`). Only the dev server uses
 * this: in AWS, CloudFront sends `/api/*` to API Gateway on the same origin.
 */
const LOCAL_API = 'http://127.0.0.1:8787';

// Multipage build; the HTML entry points live at the frontend root.
// Two pages: the public one (`index.html`) and the owner Panel (`panel.html`). The
// size budget below applies to the public page only.
export default defineConfig({
  plugins: [publicBundleBudget()],
  // Development only (`vite`, not `vite build`). The browser talks to ONE origin, as
  // it does behind CloudFront: `/api` goes to the local API and `/ws` is the
  // WebSocket the Panel connects to.
  server: {
    proxy: {
      '/api': { target: LOCAL_API },
      '/ws': { target: LOCAL_API, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        index: new URL('./index.html', import.meta.url).pathname,
        panel: new URL('./panel.html', import.meta.url).pathname,
      },
    },
  },
});
