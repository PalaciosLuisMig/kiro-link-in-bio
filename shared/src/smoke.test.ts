import { expect, test } from 'vitest';
import { SHARED_PACKAGE } from './index.js';

// Trivial test: confirms `npm test` picks up the shared workspace.
// Removed once the first real shared test lands (task 2).
test('shared workspace runs under vitest', () => {
  expect(SHARED_PACKAGE).toBe('@link-in-bio/shared');
});
