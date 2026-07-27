/**
 * Mirror a platform's catalogue locally (plan §1).
 *
 * Walks A-Z plus the numeric section, following pagination within each section,
 * and upserts every row. One polite crawl replaces hundreds of live searches.
 *
 * ## Pagination
 *
 * Listings are capped at 200 rows per page — verified, not assumed: PS2 section
 * 'S' returns 200 rows plus a 'Next' link, then 39 more. Plan §1's estimate of
 * ~27 requests per platform counted sections only. Stopping at the first page of
 * each section would silently mirror part of the catalogue while reporting
 * success, so `hasNextPage` is load-bearing and every page must make progress.
 *
 * ## The default filters
 *
 * The listing view is filtered before you ask it anything: four regions checked,
 * newest version only, first disc only, no prototypes/demos/unlicensed/bonus.
 * A sync that accepts those defaults returns 1,831 PS2 rows instead of ~11,800,
 * and every one of them is USA — which would quietly break region preference,
 * the feature plan §4.2 treats as policy. `listFilters` from the source registry
 * is therefore applied to every listing request.
 */
import type { Platform, SyncProgress } from '@vl-collection-builder/shared';
import { fetchPage } from './fetcher.js';
import { parseListing } from './parser.js';
import { loadRegistry } from '../sources/load.js';
import { completeSync, countEntries, setSyncStatus, upsertEntries } from '../db/catalog.js';
import { getSettings } from '../db/settings.js';

/** A-Z plus Vimm's numeric bucket. */
export const SECTIONS = [
  'number',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
] as const;

/**
 * Runaway guard. A section needing more than this many pages means either the
 * catalogue grew enormously or the pager is looping; either way, stop and say so
 * rather than crawling forever.
 */
const MAX_PAGES_PER_SECTION = 60;

export interface SyncOptions {
  onProgress?: (p: SyncProgress) => void;
  signal?: AbortSignal;
}

export interface SyncResult {
  platform: string;
  entriesSeen: number;
  inserted: number;
  updated: number;
  pagesFetched: number;
  entryCount: number;
  warnings: string[];
}

/** Appends the registry's filter parameters, expanding array values (countries[]). */
function applyFilters(
  params: URLSearchParams,
  filters: Record<string, string | string[]>,
): void {
  for (const [key, value] of Object.entries(filters)) {
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, v);
    } else {
      params.set(key, value);
    }
  }
}

function listingUrl(
  baseUrl: string,
  system: string,
  section: string,
  page: number,
  filters: Record<string, string | string[]>,
): string {
  const params = new URLSearchParams({ p: 'list', system, section });
  applyFilters(params, filters);
  if (page > 1) params.set('page', String(page));
  return `${baseUrl}/vault/?${params.toString()}`;
}

/** Tracks in-flight syncs so two clients cannot crawl the same platform at once. */
const running = new Set<string>();

export function isSyncing(platform: string): boolean {
  return running.has(platform);
}

export async function syncPlatform(
  platform: Platform,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  if (running.has(platform.slug)) {
    throw new Error(`a sync is already running for ${platform.slug}`);
  }
  running.add(platform.slug);

  const { registry } = await loadRegistry();
  const settings = getSettings();
  const warnings: string[] = [];

  let entriesSeen = 0;
  let inserted = 0;
  let updated = 0;
  let pagesFetched = 0;
  /** Warn once per sync, not once per page, if the fallback parser kicks in. */
  let fallbackWarned = false;

  setSyncStatus(platform.slug, 'running');

  try {
    for (const [index, section] of SECTIONS.entries()) {
      if (opts.signal?.aborted) throw new Error('sync cancelled');

      let page = 1;
      for (;;) {
        const url = listingUrl(
          registry.baseUrl,
          platform.system,
          section,
          page,
          registry.listFilters,
        );
        const html = await fetchPage(url, { delayMs: settings.crawlDelayMs });
        pagesFetched += 1;

        const result = parseListing(html);

        if (result.columnsMissing && !fallbackWarned) {
          fallbackWarned = true;
          warnings.push(
            `section ${section}: ${result.warnings[0] ?? 'fallback parser used'} — entries are missing region, version, language and rating`,
          );
        }
        for (const w of result.warnings) {
          if (!result.columnsMissing) warnings.push(`section ${section} page ${page}: ${w}`);
        }

        if (result.entries.length > 0) {
          const counts = upsertEntries(platform.slug, registry.baseUrl, result.entries);
          inserted += counts.inserted;
          updated += counts.updated;
          entriesSeen += result.entries.length;
        }

        opts.onProgress?.({
          platform: platform.slug,
          section: page > 1 ? `${section} (page ${page})` : section,
          sectionsDone: index,
          sectionsTotal: SECTIONS.length,
          entriesSeen,
          status: 'running',
        });

        if (!result.hasNextPage) break;

        // A 'Next' link with nothing on the page would loop forever.
        if (result.entries.length === 0) {
          warnings.push(
            `section ${section} page ${page}: pager advertises another page but this one had no rows — stopping this section`,
          );
          break;
        }

        page += 1;
        if (page > MAX_PAGES_PER_SECTION) {
          warnings.push(
            `section ${section}: stopped at the ${MAX_PAGES_PER_SECTION}-page cap; the catalogue for this letter may be incomplete`,
          );
          break;
        }
      }
    }

    const entryCount = countEntries(platform.slug);
    completeSync(platform.slug, entryCount);

    opts.onProgress?.({
      platform: platform.slug,
      section: 'done',
      sectionsDone: SECTIONS.length,
      sectionsTotal: SECTIONS.length,
      entriesSeen,
      status: 'idle',
    });

    return { platform: platform.slug, entriesSeen, inserted, updated, pagesFetched, entryCount, warnings };
  } catch (err) {
    const message = (err as Error).message;
    setSyncStatus(platform.slug, 'error', message);
    opts.onProgress?.({
      platform: platform.slug,
      section: 'error',
      sectionsDone: 0,
      sectionsTotal: SECTIONS.length,
      entriesSeen,
      status: 'error',
      message,
    });
    throw err;
  } finally {
    running.delete(platform.slug);
  }
}

/**
 * Live search against the site, for the review queue's "search site" escape
 * hatch when a title is missing from a stale mirror (plan §4.1).
 */
export async function liveSearch(platform: Platform, query: string) {
  const { registry } = await loadRegistry();
  const params = new URLSearchParams({ p: 'list', system: platform.system, q: query });
  // Same filter treatment as the crawl: a live search that hides other regions
  // would be a worse escape hatch than the mirror it is meant to back up.
  applyFilters(params, registry.listFilters);
  const html = await fetchPage(`${registry.baseUrl}/vault/?${params.toString()}`);
  return parseListing(html);
}
