// Pure domain use cases: owner-side management of the managed links.
//
// This module is pure domain logic: no AWS, no Node, no DOM imports. Every use
// case takes its ports (`LinkRepository`, `MetricsRepository`, `Logger`) as
// injected dependencies and never touches the AWS SDK; the composition roots
// wire the real adapters and the tests wire the in-memory doubles
// (`testing/fakes.ts`). File location follows the flat convention of the other
// domain modules (`metrics.ts`, `ports.ts`, `list-public-links.ts`): there is
// no `use-cases/` folder, so grouping the four management use cases in one
// kebab-case file keeps the layout consistent.
//
// Assumption — where format validation happens (Requirements 6.6, 6.7, 6.8):
// the HTTP pipeline (task 10) validates the request body with the Zod schemas
// of `shared/` (`CreateLinkRequest`, `UpdateLinkRequest`, `ReorderRequest`),
// which delegate title/URL checks to `validateTitle`/`validateUrl`. By the time
// these use cases run, `title` and `url` are already well-formed. The use cases
// still TRIM the title here with `validateTitle` so the stored value has no
// leading/trailing whitespace (Requirement 6.1) regardless of the caller, and
// treat a title that fails to trim as a `ValidationError` naming the `title`
// field (Requirement 6.8); a URL that already passed the schema is stored as
// received (no trim), matching `validateUrl`'s contract.

import { MAX_LINKS, validateTitle } from '@link-in-bio/shared';

import type { Link, StoredLink } from './entities.js';
import { LimitReached, NotFound, ValidationError } from './errors.js';
import type { IdGenerator, LinkPatch, LinkRepository, Logger, MetricsRepository } from './ports.js';

/** First position assigned to a link when the list is empty (Requirement 6.1). */
const FIRST_POSITION = 0;

/**
 * The fields the owner supplies when creating a link. Format is already checked
 * by the request schema (see the assumption at the top of the file); the use
 * case re-trims the title and asserts it is still non-empty.
 *
 * `now` is the creation time in Unix ms, supplied by the caller (the
 * composition root reads it from the `Clock` port, task 9). Passing it in keeps
 * this module free of ambient time and deterministic in tests, instead of the
 * use case reading `Date.now()` directly.
 */
export interface CreateLinkInput {
  readonly title: string;
  readonly url: string;
  readonly now: number;
}

/**
 * Creates a link (Requirements 6.1, 6.8, 6.9).
 *
 * Counts the existing links (active AND inactive) and rejects with
 * {@link LimitReached} when the list is already full, creating nothing
 * (Requirement 6.9). The new link is active, its title is trimmed with
 * `validateTitle` (Requirement 6.1), its `position` is `max(position) + 1` over
 * the existing links, or {@link FIRST_POSITION} (0) when the list is empty, and
 * its id is a fresh one from the {@link IdGenerator}, distinct from every
 * existing link's id.
 *
 * Id uniqueness vs. DELETED links (Requirement 6.1): the design keeps no record
 * of removed ids, and the production `IdGenerator` is UUID v4 (see `ports.ts`),
 * whose collision probability is negligible, so a new id is distinct from any
 * previously deleted link's id by construction. The explicit regeneration loop
 * below only guards against collision with a CURRENTLY existing id, which is
 * also what the `create` condition (`attribute_not_exists(pk)`) enforces at the
 * adapter; the loop keeps the in-memory reasoning self-contained and avoids
 * relying on the adapter's conditional alone.
 *
 * @param linkRepository Port that lists and creates links.
 * @param idGenerator Port that produces a fresh unique id.
 * @param input The owner-supplied title, url and creation time `now`
 *   (title/url schema-validated upstream; `now` from the composition root's
 *   `Clock`).
 * @returns The created {@link Link}.
 * @throws LimitReached when 10 links already exist.
 * @throws ValidationError when the title does not survive trimming.
 */
export async function createLink(
  linkRepository: LinkRepository,
  idGenerator: IdGenerator,
  input: CreateLinkInput,
): Promise<Link> {
  const links = await linkRepository.list();
  if (links.length >= MAX_LINKS) {
    throw new LimitReached('maximum of 10 links reached');
  }

  const title = validateTitle(input.title);
  if (title === null) {
    throw new ValidationError('invalid title', ['title']);
  }

  const existingIds = new Set(links.map((link) => link.id));
  let id = idGenerator.next();
  while (existingIds.has(id)) {
    id = idGenerator.next();
  }

  const position = nextPosition(links);

  const stored: StoredLink = {
    id,
    title,
    url: input.url,
    position,
    active: true,
    createdAt: input.now,
  };
  await linkRepository.create(stored);

  return { ...stored, clicks: 0 };
}

/**
 * Updates an existing link's title, url and/or active flag (Requirements 6.2,
 * 6.3, 6.12).
 *
 * Delegates to `LinkRepository.update`, whose `attribute_exists(pk)` condition
 * rejects a missing link with {@link NotFound} (Requirement 6.12) rather than
 * recreating a phantom one. The id, position and click counter are never
 * touched. When a `title` is supplied it is re-trimmed with `validateTitle`
 * (Requirement 6.1/6.8 semantics); the url, already schema-validated, is passed
 * through unchanged. Returns the updated {@link Link}.
 *
 * @param linkRepository Port that updates a link conditionally.
 * @param id The id of the link to update.
 * @param patch The fields to change (at least one, enforced by the schema).
 * @returns The updated {@link Link}.
 * @throws NotFound when the link does not exist.
 * @throws ValidationError when a supplied title does not survive trimming.
 */
export async function updateLink(
  linkRepository: LinkRepository,
  id: string,
  patch: LinkPatch,
): Promise<Link> {
  let title: string | undefined = patch.title;
  if (patch.title !== undefined) {
    const trimmed = validateTitle(patch.title);
    if (trimmed === null) {
      throw new ValidationError('invalid title', ['title']);
    }
    title = trimmed;
  }

  const normalized: LinkPatch = {
    ...(title !== undefined ? { title } : {}),
    ...(patch.url !== undefined ? { url: patch.url } : {}),
    ...(patch.active !== undefined ? { active: patch.active } : {}),
  };
  return linkRepository.update(id, normalized);
}

/**
 * Reorders the links (Requirements 6.4, 6.13).
 *
 * Requires `orderedIds` to be an EXACT permutation of the existing links' ids:
 * same ids, none missing, none extra, none duplicated. When it is not, rejects
 * with {@link ValidationError} naming the `ids` field and leaves every position
 * unchanged (Requirement 6.13). Otherwise it delegates to
 * `LinkRepository.reorder`, which renumbers the links 0..n-1 in the received
 * order via a single transaction.
 *
 * The in-domain permutation check fails fast with a clear error; the
 * transactional `reorder` is also conditional on each link existing, so a
 * concurrent delete surfaces as a cancelled transaction that the adapter
 * translates to {@link ValidationError} (Requirement 6.13), never a 500. Any
 * `ValidationError` from the adapter is propagated as-is.
 *
 * @param linkRepository Port that lists and transactionally reorders links.
 * @param orderedIds The desired order; must be a permutation of existing ids.
 * @throws ValidationError when `orderedIds` is not an exact permutation.
 */
export async function reorderLinks(
  linkRepository: LinkRepository,
  orderedIds: readonly string[],
): Promise<void> {
  const links = await linkRepository.list();
  const existingIds = links.map((link) => link.id);
  if (!isExactPermutation(existingIds, orderedIds)) {
    throw new ValidationError('ids are not an exact permutation of the existing links', ['ids']);
  }
  await linkRepository.reorder(orderedIds);
}

/**
 * Removes a link and its orphan per-link click counter (Requirement 6.5).
 *
 * Checks first that the link exists with `get`; when it does not, rejects with
 * {@link NotFound} WITHOUT touching any counter (Requirement 6.12). Otherwise it
 * deletes the `LINKS` item with `remove` and THEN clears the orphan `l#<id>`
 * counter with `removeLinkCounter`. The total click counter, the per-minute
 * counters and the per-channel counters are never touched.
 *
 * Best-effort counter cleanup (Requirement 6.5): if `removeLinkCounter` fails,
 * the link is already gone, so the use case LOGS the failure (only an event
 * `code` and the optional `route`/`requestId`, never any link value, via the
 * closed `Logger` context) and still SUCCEEDS. A leftover `l#<id>` counter is
 * harmless because `getMetrics` filters per-link clicks by the existing links.
 *
 * @param linkRepository Port that reads and deletes a link.
 * @param metricsRepository Port that removes the orphan per-link counter.
 * @param logger Port used to record a best-effort counter-cleanup failure.
 * @param id The id of the link to remove.
 * @param logContext Optional `route`/`requestId` to include on the log entry.
 * @throws NotFound when the link does not exist.
 */
export async function removeLink(
  linkRepository: LinkRepository,
  metricsRepository: MetricsRepository,
  logger: Logger,
  id: string,
  logContext: { readonly route?: string; readonly requestId?: string } = {},
): Promise<void> {
  const existing = await linkRepository.get(id);
  if (existing === null) {
    throw new NotFound('link not found');
  }

  await linkRepository.remove(id);

  try {
    await metricsRepository.removeLinkCounter(id);
  } catch {
    // Best effort: the link is gone and getMetrics filters orphan counters, so
    // the operation still succeeds. Log only allowed fields (no link value).
    logger.error('remove_link_counter_failed', {
      code: 'remove_link_counter_failed',
      ...(logContext.route !== undefined ? { route: logContext.route } : {}),
      ...(logContext.requestId !== undefined ? { requestId: logContext.requestId } : {}),
    });
  }
}

// --- Helpers ----------------------------------------------------------------

/** The next position: `max(position) + 1`, or 0 when there are no links. */
function nextPosition(links: readonly Link[]): number {
  if (links.length === 0) {
    return FIRST_POSITION;
  }
  const maxPosition = links.reduce(
    (max, link) => (link.position > max ? link.position : max),
    Number.NEGATIVE_INFINITY,
  );
  return maxPosition + 1;
}

/** True when `candidate` is an exact permutation of `base` (same multiset). */
function isExactPermutation(base: readonly string[], candidate: readonly string[]): boolean {
  if (base.length !== candidate.length) {
    return false;
  }
  const remaining = new Map<string, number>();
  for (const id of base) {
    remaining.set(id, (remaining.get(id) ?? 0) + 1);
  }
  for (const id of candidate) {
    const count = remaining.get(id);
    if (count === undefined || count === 0) {
      return false;
    }
    remaining.set(id, count - 1);
  }
  return true;
}
