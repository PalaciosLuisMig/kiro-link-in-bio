import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Flat ESLint config for the Link in Bio monorepo.
 *
 * Besides the usual recommended rules, it enforces the architecture
 * boundaries described in the steering (`structure.md`) through
 * `no-restricted-imports`, scoped per folder:
 *
 * - `backend/src/lib/domain/` is pure domain logic: it must not import the
 *   AWS SDK, the Lambda `handlers/`, nor the `adapters/`.
 * - `shared/` is consumed by both the browser and the Lambdas, so it must not
 *   import anything from Node, the DOM, or AWS.
 * - `no-console` is on across the whole backend; only the `Logger` adapter is
 *   allowed to touch `console`.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/cdk.out/**', '**/coverage/**', '**/*.tsbuildinfo'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
  },

  // shared/: pure TypeScript only. No Node, no DOM, no AWS.
  {
    files: ['shared/**/*.{ts,mts,cts}'],
    languageOptions: {
      globals: {},
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@aws-sdk/*', 'aws-cdk-lib', 'aws-cdk-lib/*', 'aws-lambda'],
              message: 'shared/ must not depend on AWS.',
            },
            {
              group: [
                'node:*',
                'fs',
                'path',
                'crypto',
                'os',
                'http',
                'https',
                'stream',
                'util',
                'buffer',
                'events',
              ],
              message: 'shared/ must not depend on Node built-ins (it runs in the browser too).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'shared/ must not depend on the DOM.' },
        { name: 'document', message: 'shared/ must not depend on the DOM.' },
        { name: 'process', message: 'shared/ must not depend on Node.' },
        { name: 'Buffer', message: 'shared/ must not depend on Node.' },
        { name: '__dirname', message: 'shared/ must not depend on Node.' },
        { name: '__filename', message: 'shared/ must not depend on Node.' },
      ],
    },
  },

  // backend/: no console anywhere (the Logger adapter is the only exception).
  {
    files: ['backend/**/*.{ts,mts,cts}'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'error',
    },
  },

  // backend/src/lib/domain/: pure domain. No AWS SDK, no handlers, no adapters.
  {
    files: ['backend/src/lib/domain/**/*.{ts,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@aws-sdk/*'],
              message: 'Domain logic must not import the AWS SDK. Use a port instead.',
            },
            {
              group: ['**/handlers/**', '**/handlers'],
              message: 'Domain logic must not import Lambda handlers.',
            },
            {
              group: ['**/adapters/**', '**/adapters'],
              message: 'Domain logic must not import adapters. Depend on ports instead.',
            },
          ],
        },
      ],
    },
  },

  // The Logger adapter is the single place allowed to use console.
  {
    files: ['backend/src/lib/adapters/**/logger*.{ts,mts,cts}'],
    rules: {
      'no-console': 'off',
    },
  },

  // Frontend browser code may use the DOM.
  {
    files: ['frontend/**/*.{ts,mts,cts}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  prettier,
);
