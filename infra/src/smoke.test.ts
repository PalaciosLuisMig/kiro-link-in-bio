import { expect, test } from 'vitest';
import { INFRA_PACKAGE } from './smoke.js';

// Trivial test: confirms `npm test` picks up the infra workspace.
// Removed once the first real infra test lands (task 13).
test('infra workspace runs under vitest', () => {
  expect(INFRA_PACKAGE).toBe('@link-in-bio/infra');
});
