import { expect, test } from 'vitest';
import { BACKEND_PACKAGE } from './smoke.js';

// Trivial test: confirms `npm test` picks up the backend workspace.
// Removed once the first real backend test lands (task 3).
test('backend workspace runs under vitest', () => {
  expect(BACKEND_PACKAGE).toBe('@link-in-bio/backend');
});
