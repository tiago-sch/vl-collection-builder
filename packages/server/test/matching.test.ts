/**
 * Plan §10 phase 4: "this test set should be written before the scorer".
 * These are the cases where naive matching breaks.
 */
import { describe, expect, it } from 'vitest';
import { normalize, normalizeTitle } from '../src/matching/normalize.js';
import { diceSimilarity, scoreTitle, tokenOverlap } from '../src/matching/score.js';
import {
  differOnlyByRegion,
  filterStrict,
  hasPreferredRegion,
  regionBonusFor,
  regionRank,
} from '../src/matching/region.js';
import type { CatalogEntry } from '@vl-collection-builder/shared';

const score = (input: string, candidate: string): number =>
  scoreTitle(normalize(input), normalize(candidate));

describe('normalisation', () => {
  it('converts roman numerals so X and 10 agree', () => {
    // The case plan §4 calls out explicitly.
    expect(normalizeTitle('Final Fantasy X')).toBe(normalizeTitle('Final Fantasy 10'));
    expect(normalizeTitle('Final Fantasy XII')).toBe('final fantasy 12');
    expect(normalizeTitle('Devil May Cry III')).toBe('devil may cry 3');
  });

  it('strips diacritics', () => {
    expect(normalizeTitle('Pokémon Colosseum')).toBe('pokemon colosseum');
  });

  it('expands & and +', () => {
    expect(normalizeTitle('Ratchet & Clank')).toBe(normalizeTitle('Ratchet and Clank'));
    expect(normalizeTitle('Rock Band 2 +')).toContain('plus');
  });

  it('handles the leading article', () => {
    expect(normalizeTitle('The Legend of Zelda')).toBe('legend of zelda');
  });

  it('handles the TRAILING article form Vimm actually uses', () => {
    // '7th Saga, The' is in the SNES fixture. Plan §4 only anticipated the
    // leading form, so both must collapse to the same string.
    expect(normalizeTitle('7th Saga, The')).toBe(normalizeTitle('The 7th Saga'));
    expect(normalizeTitle('Legend of Zelda, The')).toBe(normalizeTitle('The Legend of Zelda'));
  });

  it('strips region, platform and disc markers', () => {
    expect(normalizeTitle('Okami (USA)')).toBe('okami');
    // Unfiltered Vimm searches append the system — plan §1.1.
    expect(normalizeTitle('Okami (PS2)')).toBe('okami');
    expect(normalizeTitle('Final Fantasy VII (USA) (Disc 1)')).toBe('final fantasy 7');
  });

  it('makes punctuation irrelevant', () => {
    expect(normalizeTitle('Marvel vs. Capcom')).toBe(normalizeTitle('Marvel vs Capcom'));
    expect(normalizeTitle('S.L.A.I.')).toBe('s l a i');
  });
});

describe('scoring — the cases naive matching gets wrong', () => {
  it('scores an exact match at 1.0', () => {
    expect(score('Okami', 'Okami')).toBe(1);
    expect(score('okami', 'Okami')).toBe(1);
  });

  it('keeps sequels apart', () => {
    // The failure that matters most: these must NOT be near-identical.
    const wrong = score('Final Fantasy X', 'Final Fantasy XII');
    expect(wrong).toBeLessThan(0.95);
    expect(score('Final Fantasy X', 'Final Fantasy X')).toBe(1);
  });

  it('ranks a subtitle match above an unrelated one', () => {
    const subtitle = score('Silent Hill 2', 'Silent Hill 2: Restless Dreams');
    const sequel = score('Silent Hill 2', 'Silent Hill 4: The Room');
    expect(subtitle).toBeGreaterThan(sequel);
    expect(subtitle).toBeGreaterThan(0.8);
  });

  it('ranks the vanilla edition above the special edition for a bare input', () => {
    const vanilla = score('Devil May Cry 3', 'Devil May Cry 3');
    const special = score('Devil May Cry 3', 'Devil May Cry 3: Special Edition');
    expect(vanilla).toBe(1);
    expect(vanilla).toBeGreaterThan(special);
  });

  it('matches Greatest Hits re-releases to the base title', () => {
    expect(score('Silent Hill 2', 'Silent Hill 2 (Greatest Hits)')).toBeGreaterThan(0.9);
  });

  it('handles a long subtitle without collapsing', () => {
    const right = score('Shin Megami Tensei: Nocturne', 'Shin Megami Tensei: Nocturne');
    const wrong = score('Shin Megami Tensei: Nocturne', 'Shin Megami Tensei: Digital Devil Saga');
    expect(right).toBe(1);
    expect(wrong).toBeLessThan(0.9);
  });

  it('scores a short distinctive title cleanly', () => {
    expect(score('Katamari Damacy', 'Katamari Damacy')).toBe(1);
    expect(score('Katamari Damacy', 'We Love Katamari')).toBeLessThan(0.7);
  });

  it('does not treat an abbreviation as a fuzzy match — that is tier 0 work', () => {
    // 're4' must NOT fuzzy-match; it is the alias table's job (plan §4.3).
    expect(score('re4', 'Resident Evil 4')).toBeLessThan(0.5);
    expect(score('biohazard 4', 'Resident Evil 4')).toBeLessThan(0.6);
  });
});

describe('scoring primitives', () => {
  it('dice similarity is symmetric and bounded', () => {
    expect(diceSimilarity('abc', 'abc')).toBe(1);
    expect(diceSimilarity('abc', 'xyz')).toBe(0);
    expect(diceSimilarity('night', 'nacht')).toBeCloseTo(diceSimilarity('nacht', 'night'));
  });

  it('token overlap normalises by the shorter set, so subtitles are not punished', () => {
    // Jaccard would give 2/4 here; we want 2/2, because every input word matched.
    expect(tokenOverlap(['silent', 'hill'], ['silent', 'hill', 'restless', 'dreams'])).toBe(1);
  });
});

// ---------------------------------------------------------------------------

const entry = (id: number, title: string, regions: string[]): CatalogEntry => ({
  id,
  platform: 'ps2',
  vaultId: 1000 + id,
  title,
  titleNorm: normalizeTitle(title),
  region: regions[0] ?? null,
  regions,
  version: '1.0',
  languages: null,
  rating: null,
  url: `https://vimm.net/vault/${1000 + id}`,
  firstSeenAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
});

describe('region policy', () => {
  const preference = ['USA', 'Europe', 'Japan'];

  it('ranks by position in the preference list', () => {
    expect(regionRank(['USA'], preference)).toBe(0);
    expect(regionRank(['Japan'], preference)).toBe(2);
    expect(regionRank(['Korea'], preference)).toBe(-1);
    expect(regionRank([], preference)).toBe(-1);
  });

  it('takes the best region on a multi-region row', () => {
    // 'Samurai Shodown Anthology' is flagged USA+Canada in the real fixture.
    expect(regionRank(['Canada', 'USA'], preference)).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(regionRank(['usa'], preference)).toBe(0);
  });

  it('gives the largest bonus to the first preference and none to unlisted', () => {
    const max = 0.05;
    const usa = regionBonusFor(['USA'], preference, max);
    const japan = regionBonusFor(['Japan'], preference, max);
    expect(usa).toBe(max);
    expect(usa).toBeGreaterThan(japan);
    expect(japan).toBeGreaterThan(0);
    expect(regionBonusFor(['Korea'], preference, max)).toBe(0);
  });

  it('NEVER lets region promote a worse title match', () => {
    // The invariant plan §4.2 rests on: the bonus must stay below the tier-2
    // margin, so a preferred-region near-miss cannot overtake a better title.
    const margin = 0.08;
    const maxBonus = 0.05;
    expect(maxBonus).toBeLessThan(margin);

    const betterTitleWrongRegion = score('Okami', 'Okami'); // 1.0, Japan
    const worseTitleRightRegion =
      score('Okami', 'Okami Den') + regionBonusFor(['USA'], preference, maxBonus);
    expect(betterTitleWrongRegion).toBeGreaterThan(worseTitleRightRegion);
  });

  it('detects candidates differing only by region', () => {
    const variants = [
      entry(1, 'Silent Hill 2', ['USA']),
      entry(2, 'Silent Hill 2', ['Europe']),
      entry(3, 'Silent Hill 2', ['Japan']),
    ];
    expect(differOnlyByRegion(variants)).toBe(true);
    expect(hasPreferredRegion(variants, preference)).toBe(true);

    const mixed = [entry(1, 'Silent Hill 2', ['USA']), entry(2, 'Silent Hill 4', ['USA'])];
    expect(differOnlyByRegion(mixed)).toBe(false);
  });

  it('strict mode excludes non-preferred regions outright', () => {
    const all = [
      entry(1, 'Silent Hill 2', ['USA']),
      entry(2, 'Silent Hill 2', ['Korea']),
      entry(3, 'Silent Hill 2', ['Japan']),
    ];
    const kept = filterStrict(all, ['USA', 'Japan']);
    expect(kept.map((e) => e.id)).toEqual([1, 3]);
  });

  it('reports when the preferred region is simply absent', () => {
    // Plan §4.2: fall through to review rather than silently taking a Japanese release.
    const onlyJapan = [entry(1, 'Some Game', ['Japan'])];
    expect(hasPreferredRegion(onlyJapan, ['USA', 'Europe'])).toBe(false);
  });
});
