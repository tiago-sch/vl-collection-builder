/**
 * Title similarity scoring (plan §4).
 *
 *   exact normalised equality            -> 1.0
 *   otherwise 0.6 * Dice bigram + 0.4 * token-set overlap
 *   plus a small bonus when the input is a strict prefix of the candidate
 *
 * The blend matters: bigram similarity alone punishes word order and subtitles,
 * while token overlap alone treats 'Final Fantasy 7' and 'Final Fantasy 8' as
 * near-identical. Together they disagree in useful ways.
 */
import type { NormalizedTitle } from './normalize.js';

/** Bonus for 'Silent Hill 2' matching 'Silent Hill 2: Restless Dreams'. */
const PREFIX_BONUS = 0.05;

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const clean = s.replace(/\s+/g, ' ');
  for (let i = 0; i < clean.length - 1; i += 1) {
    const g = clean.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Dice-Sørensen coefficient over character bigrams, counting multiplicity. */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const ga = bigrams(a);
  const gb = bigrams(b);

  let intersection = 0;
  let sizeA = 0;
  let sizeB = 0;
  for (const n of ga.values()) sizeA += n;
  for (const n of gb.values()) sizeB += n;
  for (const [g, n] of ga) {
    const m = gb.get(g);
    if (m !== undefined) intersection += Math.min(n, m);
  }

  return sizeA + sizeB === 0 ? 0 : (2 * intersection) / (sizeA + sizeB);
}

/**
 * Token-set overlap, normalised by the SHORTER token set.
 *
 * Dividing by the union (Jaccard) would penalise a candidate merely for having a
 * subtitle, which is the single most common shape in this catalogue.
 */
export function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let hits = 0;
  for (const t of new Set(a)) if (setB.has(t)) hits += 1;
  return hits / Math.min(new Set(a).size, setB.size);
}

/** Similarity of an input title to a candidate title, both already normalised. */
export function scoreTitle(input: NormalizedTitle, candidate: NormalizedTitle): number {
  if (input.norm === candidate.norm) return 1;
  if (!input.norm || !candidate.norm) return 0;

  const base =
    0.6 * diceSimilarity(input.norm, candidate.norm) +
    0.4 * tokenOverlap(input.tokens, candidate.tokens);

  // Strict prefix on a token boundary, so 'mario' does not "prefix" 'mariokart'.
  const isPrefix =
    candidate.norm.length > input.norm.length && candidate.norm.startsWith(`${input.norm} `);

  return Math.min(1, isPrefix ? base + PREFIX_BONUS : base);
}
