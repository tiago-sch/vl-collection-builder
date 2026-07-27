import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DECOY_VAULT_ID,
  parseAnchors,
  parseListing,
  parseTable,
} from '../src/catalog/parser.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (name: string): string => readFileSync(resolve(fixtures, name), 'utf8');

const ps2ListS = load('ps2-list-S.html');
const ps2ListSPage2 = load('ps2-list-S-p2.html');
const ps2Search = load('ps2-search-silenthill.html');
const snesList = load('snes-list-hash.html');

describe('parseTable — PS2 letter listing', () => {
  const result = parseTable(ps2ListS);

  it('returns a full page of games', () => {
    expect(result.entries).toHaveLength(200);
    expect(result.strategy).toBe('table');
    expect(result.columnsMissing).toBe(false);
  });

  it('extracts all five columns', () => {
    const first = result.entries[0]!;
    expect(first).toEqual({
      vaultId: 9170,
      title: 'S.L.A.I.: Steel Lancer Arena International',
      regions: ['USA'],
      version: '1.02',
      languages: null, // '-' in the source
      rating: 8.3,
    });
  });

  it('keeps every region on multi-region rows', () => {
    const multi = result.entries.find((e) => e.vaultId === 9175)!;
    expect(multi.title).toBe('Samurai Shodown Anthology');
    expect(multi.regions).toEqual(['USA', 'Canada']);
  });

  it('reads a real language list', () => {
    const withLangs = result.entries.find((e) => e.languages !== null);
    expect(withLangs?.languages).toMatch(/^[a-z]{2}( [a-z]{2})*$/);
  });

  it('detects that another page follows', () => {
    expect(result.hasNextPage).toBe(true);
  });
});

describe('the honeypot anchors', () => {
  it('never yields the decoy id from the table parser', () => {
    const result = parseTable(ps2ListS);
    expect(result.entries.some((e) => e.vaultId === DECOY_VAULT_ID)).toBe(false);
    expect(result.decoysSkipped).toBe(200);
  });

  it('never yields the decoy id from the anchor fallback either', () => {
    // This is the regression that matters: a naive /vault/(\d+) scan collects the
    // hidden <a href="/vault/999999" style="display:none">9</a> that precedes
    // every row, and picks it FIRST because it comes first in the markup.
    const result = parseAnchors(ps2ListS);
    expect(result.entries.some((e) => e.vaultId === DECOY_VAULT_ID)).toBe(false);
    expect(result.entries.some((e) => e.title === '9')).toBe(false);
  });

  it('a naive scan really would have been poisoned', () => {
    // Guards the premise: if Vimm ever drops the honeypot this test fails and
    // tells us the defence above is now dead code rather than load-bearing.
    const naive = [...ps2ListS.matchAll(/href=\s*["']\/vault\/(\d+)["']/gi)].map((m) => m[1]);
    expect(naive.filter((id) => id === String(DECOY_VAULT_ID))).toHaveLength(200);
  });

  it('ignores the rating links, which also sit under /vault/', () => {
    const result = parseAnchors(ps2ListS);
    // /vault/?p=rating&id=9170 must not be read as game 9170 a second time.
    const ids = result.entries.map((e) => e.vaultId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('parseAnchors — degraded fallback', () => {
  const result = parseAnchors(ps2ListS);

  it('recovers every title and id the table parser found', () => {
    const table = parseTable(ps2ListS);
    expect(result.entries.map((e) => e.vaultId)).toEqual(table.entries.map((e) => e.vaultId));
    expect(result.entries.map((e) => e.title)).toEqual(table.entries.map((e) => e.title));
  });

  it('flags that the columns are gone', () => {
    expect(result.columnsMissing).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/region, version, language and rating/);
    expect(result.entries.every((e) => e.regions.length === 0 && e.version === null)).toBe(true);
  });
});

describe('pagination', () => {
  it('recognises the last page by its hidden Next link', () => {
    const page2 = parseTable(ps2ListSPage2);
    expect(page2.entries).toHaveLength(39);
    expect(page2.hasNextPage).toBe(false);
  });

  it('page 2 continues where page 1 stopped, with no overlap', () => {
    const p1 = parseTable(ps2ListS).entries.map((e) => e.vaultId);
    const p2 = parseTable(ps2ListSPage2).entries.map((e) => e.vaultId);
    expect(p1.filter((id) => p2.includes(id))).toEqual([]);
  });

  it('the fallback reads the pager too', () => {
    expect(parseAnchors(ps2ListS).hasNextPage).toBe(true);
    expect(parseAnchors(ps2ListSPage2).hasNextPage).toBe(false);
  });
});

describe('search results', () => {
  const result = parseTable(ps2Search);

  it('parses the same table shape as a letter listing', () => {
    expect(result.entries).toHaveLength(24);
    expect(result.columnsMissing).toBe(false);
  });

  it('surfaces the regional variants that make review necessary', () => {
    const sh2 = result.entries.filter((e) => e.title === 'Silent Hill 2');
    expect(sh2.length).toBeGreaterThanOrEqual(5);
    // Distinct vault ids per region — this is exactly the case the tier-2 margin
    // rule must refuse to auto-accept.
    expect(new Set(sh2.map((e) => e.vaultId)).size).toBe(sh2.length);
    expect(sh2.flatMap((e) => e.regions)).toEqual(
      expect.arrayContaining(['USA', 'Europe', 'Japan', 'Korea']),
    );
  });

  it('handles an unrated entry', () => {
    const unrated = result.entries.find((e) => e.rating === null);
    expect(unrated).toBeDefined();
  });
});

describe('a non-PS2 platform parses identically', () => {
  // Plan §11 asks for a spot-check on platforms other than PS2, since a per-console
  // markup difference would otherwise only show up during a real sync.
  const result = parseTable(snesList);

  it('uses one code path for SNES', () => {
    expect(result.entries).toHaveLength(3);
    expect(result.strategy).toBe('table');
    expect(result.entries[1]).toEqual({
      vaultId: 1001,
      title: '3 Ninjas Kick Back',
      regions: ['USA'],
      version: '1.0',
      languages: null,
      rating: 6.0,
    });
  });

  it('carries the trailing-article title form that normalisation must handle', () => {
    // Vimm writes 'The 7th Saga' as '7th Saga, The'. Plan §4 only anticipated a
    // LEADING article, so normalize.ts has to handle the comma form too.
    expect(result.entries.map((e) => e.title)).toContain('7th Saga, The');
  });
});

describe('parseListing — strategy selection', () => {
  it('prefers the table parser when it works', () => {
    expect(parseListing(ps2ListS).strategy).toBe('table');
  });

  it('detects PARTIAL table breakage, not just total breakage', () => {
    // Dropping <tr> does not empty the table parser — the HTML parsing algorithm
    // coalesces the orphaned <td>s into one implied row, so it returns exactly 1
    // game. A "did the table parser return anything?" check would accept that and
    // sync 1 game per page while reporting success. Comparing the two strategies
    // is what catches it.
    const noRows = ps2ListS.replace(/<tr\b/gi, '<div').replace(/<\/tr>/gi, '</div>');
    expect(parseTable(noRows).entries).toHaveLength(1);

    const result = parseListing(noRows);
    expect(result.strategy).toBe('anchors');
    expect(result.entries).toHaveLength(200);
    expect(result.warnings[0]).toMatch(/recovered only 1 of 200/);
  });

  it('falls back to anchors when the layout stops being a table at all', () => {
    // The realistic break: Vimm moves the listing to a div/flex layout. Anchors
    // survive, table structure does not.
    const noTable = ps2ListS
      .replace(/<\/?(table|tbody|thead|caption)\b[^>]*>/gi, '')
      .replace(/<tr\b[^>]*>/gi, '<div>')
      .replace(/<\/tr>/gi, '</div>')
      .replace(/<td\b[^>]*>/gi, '<span>')
      .replace(/<\/td>/gi, '</span>');
    const result = parseListing(noTable);
    expect(result.strategy).toBe('anchors');
    expect(result.entries.length).toBeGreaterThan(100);
    expect(result.columnsMissing).toBe(true);
    expect(result.warnings[0]).toMatch(/markup may have changed/);
  });

  it('returns empty without crashing on a page that is not a listing', () => {
    const result = parseListing('<html><body><p>Nothing here</p></body></html>');
    expect(result.entries).toEqual([]);
    expect(result.hasNextPage).toBe(false);
  });
});
