// Absolute paths inside the monorepo, resolved from this file so they work the
// same from `tsx` (cdk synth) and from Vitest.

import { join, resolve } from 'node:path';

/** Root of the monorepo (two levels above `infra/lib`). */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/** Lock file of the monorepo root, required by `NodejsFunction` bundling. */
export const DEPS_LOCK_FILE = join(REPO_ROOT, 'package-lock.json');

/** Folder with the Lambda entry points, `backend/src/handlers`. */
export const HANDLERS_DIR = join(REPO_ROOT, 'backend', 'src', 'handlers');

/** Default folder of the built frontend, `frontend/dist`. */
export const FRONTEND_DIST = join(REPO_ROOT, 'frontend', 'dist');
