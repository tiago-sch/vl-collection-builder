/**
 * Title normalisation (plan §4).
 *
 * The same function is applied to catalogue titles and to your pasted input, so
 * the two only need to agree with each other — absolute "correctness" matters
 * less than being consistent on both sides.
 */

/**
 * Roman numerals worth converting. Beyond XX, titles use digits anyway.
 *
 * A bare 'i' is deliberately absent. It is far more often an initial or the
 * pronoun than the numeral one — 'S.L.A.I.' normalises to 's l a i', and mapping
 * it would give 's l a 1'. The numeral reading is rare enough not to be worth
 * corrupting every title containing a lone I.
 *
 * 'x' IS converted, because 'Final Fantasy X' vs 'Final Fantasy 10' is the case
 * plan §4 calls critical. The known cost is 'Mega Man X', where the X is a name
 * rather than a ten: it then normalises the same as 'Mega Man 10'. That collision
 * is handled correctly downstream rather than here — two candidates scoring 1.0
 * leaves no margin, so the tier-2 rule refuses to auto-accept and the item goes
 * to review, which is exactly what an ambiguous title deserves.
 */
const ROMAN: Record<string, string> = {
  ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8',
  ix: '9', x: '10', xi: '11', xii: '12', xiii: '13', xiv: '14', xv: '15',
  xvi: '16', xvii: '17', xviii: '18', xix: '19', xx: '20',
};

const LEADING_ARTICLES = /^(the|a|an)\s+/;

/**
 * Trailing bracketed markers: region, platform, disc, and the release tags
 * Vimm and No-Intro style listings carry.
 *
 * The platform case comes from unfiltered searches, where Vimm appends the
 * system in parentheses — 'Okami (PS2)' (plan §1.1).
 */
const TRAILING_MARKERS =
  /[([{](?:usa|europe|japan|australia|korea|asia|canada|brazil|china|france|germany|italy|netherlands|spain|sweden|russia|world|united kingdom|latin america|[a-z]{2,3}(?:,\s*[a-z]{2,3})*|nes|snes|n64|gamecube|gc|wii|gb|gbc|gba|ds|genesis|megadrive|saturn|dreamcast|dc|ps1|psx|ps2|ps3|psp|xbox|xbox360|disc\s*\d+|disk\s*\d+|cd\s*\d+|rev\s*[a-z0-9.]+|v[\d.]+|beta|proto|prototype|demo|sample|unl|pirate|greatest hits|platinum|player'?s choice|best seller|classics|the best|en|ja|fr|de|es|it|pt|nl|sv|ko|zh|ru)[)\]}]/g;

/**
 * Titles stored the library way: 'Legend of Zelda, The' rather than
 * 'The Legend of Zelda'. Vimm uses this form — '7th Saga, The' is in the SNES
 * fixture — so the comma variant has to be handled as well as the leading one.
 * Plan §4 only anticipated the leading form.
 */
function unswapTrailingArticle(s: string): string {
  return s.replace(/,\s*(the|a|an)\s*$/i, '');
}

/**
 * Full normalisation. Returns the normalised string; use `tokenize` for the
 * token array the set-overlap half of the scorer needs.
 */
export function normalizeTitle(input: string): string {
  let s = input.normalize('NFKD');

  // Strip combining marks: 'Pokémon' -> 'Pokemon'.
  s = s.replace(/[̀-ͯ]/g, '');
  s = s.toLowerCase();

  // Symbols that carry meaning, before punctuation is stripped.
  s = s.replace(/&/g, ' and ').replace(/\+/g, ' plus ');

  // Bracketed markers, repeatedly — titles can carry several: '(USA) (Disc 1)'.
  let previous: string;
  do {
    previous = s;
    s = s.replace(TRAILING_MARKERS, ' ');
  } while (s !== previous);

  s = unswapTrailingArticle(s.trim());

  // Punctuation to spaces so 'Marvel vs. Capcom' and 'Marvel vs Capcom' agree.
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();

  s = s.replace(LEADING_ARTICLES, '');

  // Roman numerals, token by token: 'Final Fantasy X' -> 'final fantasy 10',
  // which is what makes it match an input typed as 'Final Fantasy 10'.
  s = s
    .split(' ')
    .map((t) => ROMAN[t] ?? t)
    .join(' ');

  return s.replace(/\s+/g, ' ').trim();
}

export function tokenize(normalized: string): string[] {
  return normalized ? normalized.split(' ') : [];
}

/** Convenience: normalised string plus its tokens, computed once. */
export interface NormalizedTitle {
  norm: string;
  tokens: string[];
}

export function normalize(input: string): NormalizedTitle {
  const norm = normalizeTitle(input);
  return { norm, tokens: tokenize(norm) };
}
