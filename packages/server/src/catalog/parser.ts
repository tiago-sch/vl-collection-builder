/**
 * Everything this project assumes about Vimm's HTML lives in this one file
 * (plan §2). When the site's markup changes, this file and its fixtures are the
 * only things that need updating.
 *
 * Two strategies, per plan §1.1 (changed decision #2):
 *   - `parseTable`   primary. cheerio over the listing table; keeps the region,
 *                    version, language and rating columns the review UI needs.
 *   - `parseAnchors` fallback. Regex over raw HTML; survives layout churn but
 *                    returns titles and ids only, flagged `columnsMissing`.
 *
 * ## The decoy anchors
 *
 * Every listing row begins with a hidden honeypot anchor:
 *
 *     <a href="/vault/999999" style="display:none">9</a>
 *     <a href= "/vault/9170" ...>S.L.A.I.: Steel Lancer Arena International</a>
 *
 * A naive `/vault/(\d+)` regex — the approach gamarr uses — collects two hits
 * per row and picks the honeypot first, yielding 200 bogus entries that all
 * collide on vault_id 999999. Our UNIQUE (platform, vault_id) constraint would
 * then collapse them into a single junk row instead of failing loudly, so the
 * damage would be quiet. Both strategies drop `display:none` anchors before
 * looking for ids, and DECOY_VAULT_ID is rejected as a belt-and-braces guard.
 *
 * Note the real anchors are written `href= "..."` with a space, while decoys use
 * `href="..."`. That difference is not relied on — it is too fragile to build on,
 * and `display:none` is the semantic signal.
 */
import * as cheerio from 'cheerio';
import type { ParsedEntry, ParseResult } from '@vault-lookup/shared';

/** The honeypot id. Never a real game. */
export const DECOY_VAULT_ID = 999999;

/** Rows per listing page, observed. Used only as a sanity signal, not for paging. */
export const ROWS_PER_PAGE = 200;

/** Matches a game page href: /vault/8433. Excludes /vault/?p=rating&id=… */
const VAULT_HREF = /^\/vault\/(\d+)\/?$/;

/** Same thing for the raw-HTML fallback, tolerating the `href= "…"` spacing. */
const VAULT_HREF_RAW = /href=\s*["']\/vault\/(\d+)\/?["']/gi;

/** Anchors the site hides from users. Stripped before any id extraction. */
const HIDDEN_ANCHOR_RAW = /<a\b[^>]*style=["'][^"']*display:\s*none[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}

function cleanText(s: string | undefined | null): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** Vimm writes '-' for "no languages listed" and 'none' for an unrated game. */
function optional(s: string): string | null {
  const t = cleanText(s);
  if (!t || t === '-' || t === '—' || t.toLowerCase() === 'none') return null;
  return t;
}

function parseRating(s: string): number | null {
  const t = optional(s);
  if (t === null) return null;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Is there another page after this one?
 *
 * The pager renders a 'Next' anchor on every page but hides it on the last with
 * `visibility:hidden` and an `href="#"`. Both are checked: either alone would be
 * a single point of failure for a bug whose symptom is a half-empty catalogue.
 */
function detectNextPage($: cheerio.CheerioAPI): boolean {
  let found = false;
  $('a').each((_, el) => {
    if (found) return;
    const a = $(el);
    if (cleanText(a.text()).toLowerCase() !== 'next') return;
    const href = a.attr('href') ?? '';
    const style = a.attr('style') ?? '';
    if (href && href !== '#' && !/visibility:\s*hidden/i.test(style)) found = true;
  });
  return found;
}

/**
 * Primary strategy.
 *
 * Rows are located by "contains a visible /vault/{id} anchor" rather than by a
 * table class, so a restyled table still parses. Columns are then read
 * positionally from that row's cells.
 */
export function parseTable(html: string): ParseResult {
  const $ = cheerio.load(html);
  const warnings: string[] = [];
  const entries: ParsedEntry[] = [];
  let decoysSkipped = 0;

  // Drop the honeypots from the DOM up front so nothing downstream can see them.
  $('a[style*="display:none"], a[style*="display: none"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (VAULT_HREF.test(href)) decoysSkipped += 1;
    $(el).remove();
  });

  const seen = new Set<number>();

  $('tr').each((_, tr) => {
    const row = $(tr);

    const link = row
      .find('a[href]')
      .filter((_i, a) => VAULT_HREF.test($(a).attr('href') ?? ''))
      .first();
    if (link.length === 0) return;

    const vaultId = Number.parseInt(VAULT_HREF.exec(link.attr('href') ?? '')?.[1] ?? '', 10);
    if (!Number.isFinite(vaultId) || vaultId === DECOY_VAULT_ID) {
      decoysSkipped += 1;
      return;
    }
    // A game can legitimately appear once per page only; a repeat means we are
    // looking at a nested or duplicated table.
    if (seen.has(vaultId)) return;

    const title = cleanText(link.text());
    if (!title) {
      warnings.push(`vault ${vaultId}: empty title, row skipped`);
      return;
    }

    const cells = row.find('> td');

    // Region comes from flag image titles, and there can be several
    // ('Samurai Shodown Anthology' is flagged USA and Canada).
    const regions: string[] = [];
    row.find('img[title]').each((_i, img) => {
      const src = $(img).attr('src') ?? '';
      if (!/\/flags\//i.test(src)) return; // skip the manual icon, which also has a title
      const t = cleanText($(img).attr('title'));
      if (t && !regions.includes(t)) regions.push(t);
    });

    // Columns are Title · Region · Version · Languages · Rating.
    const version = optional(cells.eq(2).text());
    const languages = optional(cells.eq(3).text());
    const rating = parseRating(cells.eq(4).text());

    seen.add(vaultId);
    entries.push({ vaultId, title, regions, version, languages, rating });
  });

  return {
    entries,
    strategy: 'table',
    columnsMissing: false,
    hasNextPage: detectNextPage($),
    decoysSkipped,
    warnings,
  };
}

/**
 * Fallback strategy: raw-HTML anchor scan.
 *
 * Loses every column except title and id, so results are flagged
 * `columnsMissing` and the UI warns. Better than returning nothing when the
 * table layout changes.
 */
export function parseAnchors(html: string): ParseResult {
  const warnings: string[] = [];
  const entries: ParsedEntry[] = [];
  const seen = new Set<number>();
  let decoysSkipped = 0;

  // Count then remove the honeypots before scanning.
  const hidden = html.match(HIDDEN_ANCHOR_RAW) ?? [];
  for (const h of hidden) {
    VAULT_HREF_RAW.lastIndex = 0;
    if (VAULT_HREF_RAW.test(h)) decoysSkipped += 1;
  }
  const stripped = html.replace(HIDDEN_ANCHOR_RAW, '');

  const anchor = /<a\b[^>]*href=\s*["']\/vault\/(\d+)\/?["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(stripped)) !== null) {
    const vaultId = Number.parseInt(m[1] ?? '', 10);
    if (!Number.isFinite(vaultId) || vaultId === DECOY_VAULT_ID) {
      decoysSkipped += 1;
      continue;
    }
    if (seen.has(vaultId)) continue;

    // Strip nested markup (the manual icon lives inside some anchors).
    const title = cleanText(decodeEntities((m[2] ?? '').replace(/<[^>]*>/g, ' ')));
    if (!title) continue;

    seen.add(vaultId);
    entries.push({ vaultId, title, regions: [], version: null, languages: null, rating: null });
  }

  if (entries.length > 0) {
    warnings.push(
      'listing parsed with the anchor fallback: region, version, language and rating columns are unavailable',
    );
  }

  const nextRaw = /<a\b([^>]*)>\s*Next\s*<\/a>/i.exec(stripped);
  const nextAttrs = nextRaw?.[1] ?? '';
  const hasNextPage =
    nextRaw !== null &&
    !/visibility:\s*hidden/i.test(nextAttrs) &&
    /href=\s*["'](?!#)/i.test(nextAttrs);

  return { entries, strategy: 'anchors', columnsMissing: true, hasNextPage, decoysSkipped, warnings };
}

/**
 * Parse a listing page, choosing the strategy that actually recovered the games.
 *
 * Both strategies always run, and the one with more entries wins. "Did the table
 * parser return anything?" is deliberately NOT the test, because the interesting
 * failure is partial, not total: strip the <tr> and <td> elements from a listing
 * and the HTML parser coalesces every orphaned cell into ONE implied row, so the
 * table path returns a single entry instead of 200. A truthiness check would
 * accept that and sync 1 game per page while reporting success — precisely the
 * quiet data loss this parser is meant to make impossible.
 *
 * The anchor scan is a cheap regex over the same string, so running both costs
 * little and gives us a continuous health signal rather than a binary one.
 */
export function parseListing(html: string): ParseResult {
  const table = parseTable(html);
  const anchors = parseAnchors(html);

  if (anchors.entries.length > table.entries.length) {
    anchors.warnings.unshift(
      `table parse recovered only ${table.entries.length} of ${anchors.entries.length} games ` +
        '— Vimm markup may have changed; parser fixtures need updating',
    );
    // The pager lives outside the table, so trust whichever strategy saw one.
    anchors.hasNextPage = anchors.hasNextPage || table.hasNextPage;
    return anchors;
  }

  return table;
}
