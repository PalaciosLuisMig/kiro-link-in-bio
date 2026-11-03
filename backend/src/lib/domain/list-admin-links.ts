// Pure domain use case: the links the owner manages in the Panel.
//
// This module is pure domain logic: no AWS, no Node, no DOM imports. It mirrors
// `listPublicLinks` but keeps inactive links and the management-only fields.

import type { AdminLink } from '@link-in-bio/shared';

import type { Link } from './entities.js';
import type { LinkRepository } from './ports.js';

/** Projects a domain {@link Link} to the admin contract (drops `createdAt`). */
export function toAdminLink(link: Link): AdminLink {
  return {
    id: link.id,
    title: link.title,
    url: link.url,
    active: link.active,
    position: link.position,
    clicks: link.clicks,
  };
}

/**
 * Returns every link (active and inactive) as {@link AdminLink}, ordered by
 * `position` ascending. The repository's array is copied before sorting.
 */
export async function listAdminLinks(linkRepository: LinkRepository): Promise<AdminLink[]> {
  const links = await linkRepository.list();
  return links
    .slice()
    .sort((a, b) => a.position - b.position)
    .map(toAdminLink);
}
