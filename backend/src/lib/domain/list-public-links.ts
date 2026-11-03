// Pure domain use case: the links the public page may show.
//
// This module is pure domain logic: no AWS, no Node, no DOM imports. It takes a
// `LinkRepository` port as an injected dependency and never touches the AWS SDK;
// the composition roots wire the real adapter and the tests wire the in-memory
// double (`testing/fakes.ts`). File location follows the flat convention of the
// other domain modules (`metrics.ts`, `ports.ts`, `entities.ts`): there is no
// `use-cases/` folder yet, so adding one for a single use case would break the
// existing layout; a later task can group them if more use cases warrant it.

import type { PublicLink } from '@link-in-bio/shared';

import type { Link } from './entities.js';
import type { LinkRepository } from './ports.js';

/**
 * Returns the links the public page shows: only the active ones, ordered by
 * `position` ascending, with no duplicates, each projected to the public
 * contract (`{ id, title, url }`).
 *
 * Projecting to {@link PublicLink} is what keeps management-only fields
 * (`position`, `active`, `clicks`, `createdAt`) out of the public response: the
 * return type cannot carry them, so the public page never leaks them
 * (Requirement 6.11). The result contains only active links (Requirement 1.3)
 * in ascending `position` order (Requirement 1.1).
 *
 * De-duplication is by `id`: should the repository ever return two links with
 * the same id (it should not, since the id is the item key), only the first in
 * the sorted order is kept, so an id never appears twice in the output.
 *
 * The input is not mutated: the links are copied into a new array before
 * sorting, and `sort` therefore runs on that copy, never on the repository's
 * array.
 *
 * @param linkRepository Port that lists every link (active and inactive).
 * @returns The active links as {@link PublicLink}, ordered by position.
 */
export async function listPublicLinks(linkRepository: LinkRepository): Promise<PublicLink[]> {
  const links = await linkRepository.list();

  const activeSorted = links
    .filter((link) => link.active)
    .slice()
    .sort(byPositionAscending);

  const seen = new Set<string>();
  const result: PublicLink[] = [];
  for (const link of activeSorted) {
    if (seen.has(link.id)) {
      continue;
    }
    seen.add(link.id);
    result.push(toPublicLink(link));
  }
  return result;
}

/** Orders links by `position` ascending (stable for equal positions). */
function byPositionAscending(a: Link, b: Link): number {
  return a.position - b.position;
}

/** Projects a domain {@link Link} to the public contract, dropping every
 * management-only field. */
function toPublicLink(link: Link): PublicLink {
  return { id: link.id, title: link.title, url: link.url };
}
