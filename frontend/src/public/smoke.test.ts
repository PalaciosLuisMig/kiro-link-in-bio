import { expect, test } from 'vitest';
import { FRONTEND_PACKAGE } from './main.js';

// Trivial test: confirms `npm test` picks up the frontend workspace.
// Removed once the first real frontend test lands (task 14).
test('frontend workspace runs under vitest', () => {
  expect(FRONTEND_PACKAGE).toBe('@link-in-bio/frontend');
});
