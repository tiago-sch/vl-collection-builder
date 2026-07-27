/**
 * The tier cascade (plan §4.1).
 *
 *   0  learned or static alias        free, instant
 *   1  exact normalised match         free, instant
 *   2  fuzzy >= threshold with margin free, instant
 *   3  human review                   your attention
 *
 * Each tier only sees what the tier above could not settle. The margin rule in
 * tier 2 is what makes this behave: two regional variants of one game both score
 * ~0.99, so the margin between them is ~0, so it declines to auto-accept and
 * passes the item down rather than guessing.
 */
import type {
  AppSettings,
  CatalogEntry,
  JobItemStatus,
  ResolvedTier,
} from '@vl-collection-builder/shared';
import { normalize } from './normalize.js';
import { scoreTitle } from './score.js';
import {
  differOnlyByRegion,
  filterStrict,
  hasPreferredRegion,
  regionBonusFor,
  regionRank,
} from './region.js';
import { resolveAlias } from './aliases.js';

export interface ScoredCandidate {
  entry: CatalogEntry;
  score: number;
  baseScore: number;
}

export interface ResolveOutcome {
  status: JobItemStatus;
  tier: ResolvedTier | null;
  chosen: CatalogEntry | null;
  confidence: number | null;
  candidates: ScoredCandidate[];
}

export interface ResolveContext {
  platform: string;
  entries: CatalogEntry[];
  settings: AppSettings;
  /** Per-job override; falls back to the global preference. */
  regionPreference: string[];
  strictRegion: boolean;
  /** Clamped to stay below the tier-2 margin (see db/settings.ts). */
  regionBonus: number;
}

/** Score every catalogue entry for the platform and keep the best few. */
export function scoreAll(input: string, ctx: ResolveContext): ScoredCandidate[] {
  const normalized = normalize(input);
  const pool = ctx.strictRegion ? filterStrict(ctx.entries, ctx.regionPreference) : ctx.entries;

  const scored: ScoredCandidate[] = [];
  for (const entry of pool) {
    const baseScore = scoreTitle(normalized, { norm: entry.titleNorm, tokens: entry.titleNorm.split(' ') });
    if (baseScore < 0.3) continue; // nothing below this is ever worth showing
    const bonus = regionBonusFor(entry.regions, ctx.regionPreference, ctx.regionBonus);
    scored.push({ entry, baseScore, score: Math.min(1, baseScore + bonus) });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Deterministic tie-break: preferred region, then lowest vault id, so the
    // same input always produces the same ordering.
    const ra = regionRank(a.entry.regions, ctx.regionPreference);
    const rb = regionRank(b.entry.regions, ctx.regionPreference);
    const na = ra === -1 ? Number.MAX_SAFE_INTEGER : ra;
    const nb = rb === -1 ? Number.MAX_SAFE_INTEGER : rb;
    if (na !== nb) return na - nb;
    return a.entry.vaultId - b.entry.vaultId;
  });

  return scored.slice(0, Math.max(1, ctx.settings.maxCandidates));
}

/**
 * Tier 1 and the region auto-accept rule.
 *
 * When several entries tie on an exact title match they are, by definition, the
 * same game in different regions or versions. If the preferred region is among
 * them we take it; if it is not, we fall through to review rather than silently
 * taking whatever came first — plan §4.2 is explicit that this must not become a
 * quiet default.
 */
function settleExactMatches(
  exact: CatalogEntry[],
  ctx: ResolveContext,
): { chosen: CatalogEntry | null; tier: ResolvedTier } {
  if (exact.length === 1) {
    const only = exact[0]!;
    // A single exact match still has to clear the region policy. If the sole
    // release is outside your preference list, plan §4.2 says fall through to
    // review rather than silently handing you a Japanese release.
    //
    // Two cases are NOT rejections:
    //   - the entry has no region data (a gap in the listing, not a policy
    //     question — blocking would just punish parser noise)
    //   - no preference is configured at all, which means "no region policy",
    //     not "reject everything". The UI never allows an empty list, but this
    //     must degrade to permissive rather than sending an entire import to
    //     review with no explanation.
    const noPolicy = ctx.regionPreference.length === 0;
    if (noPolicy || only.regions.length === 0 || regionRank(only.regions, ctx.regionPreference) !== -1) {
      return { chosen: only, tier: 1 };
    }
    return { chosen: null, tier: 1 };
  }

  if (differOnlyByRegion(exact) && hasPreferredRegion(exact, ctx.regionPreference)) {
    const best = [...exact].sort((a, b) => {
      const ra = regionRank(a.regions, ctx.regionPreference);
      const rb = regionRank(b.regions, ctx.regionPreference);
      const na = ra === -1 ? Number.MAX_SAFE_INTEGER : ra;
      const nb = rb === -1 ? Number.MAX_SAFE_INTEGER : rb;
      if (na !== nb) return na - nb;
      return a.vaultId - b.vaultId;
    })[0]!;
    return { chosen: best, tier: 1 };
  }

  return { chosen: null, tier: 1 };
}

/**
 * Guarantee the chosen entry appears in the candidate list.
 *
 * An alias hit is found by lookup, not by scoring, so its target need not be
 * anywhere in the fuzzy candidates — 'gta sa' resolves to San Andreas while the
 * top-scoring fuzzy candidate is 'GTA Cheat Master'. Without this, the review
 * card and the library row would display a candidate that is not the one
 * actually chosen.
 */
function withChosen(candidates: ScoredCandidate[], chosen: CatalogEntry | null): ScoredCandidate[] {
  if (!chosen) return candidates;
  if (candidates.some((c) => c.entry.id === chosen.id)) return candidates;
  return [{ entry: chosen, score: 1, baseScore: 1 }, ...candidates];
}

export async function resolveItem(input: string, ctx: ResolveContext): Promise<ResolveOutcome> {
  const { norm } = normalize(input);
  const candidates = scoreAll(input, ctx);

  // --- tier 0: alias -------------------------------------------------------
  const alias = await resolveAlias(ctx.platform, norm);
  if (alias) {
    const pool = ctx.strictRegion
      ? filterStrict(alias.entries, ctx.regionPreference)
      : alias.entries;

    if (pool.length > 0) {
      // The region policy applies here too. An alias tells us WHICH game you
      // meant; it does not license skipping the region check, so a single
      // alias hit outside your preference list still goes to review.
      const settled = settleExactMatches(pool, ctx);
      if (settled.chosen) {
        return {
          status: 'auto_matched',
          tier: 0,
          chosen: settled.chosen,
          confidence: 1,
          candidates: withChosen(candidates, settled.chosen),
        };
      }
      // Alias is right but the region is not settled: show only the alias targets.
      return {
        status: 'needs_review',
        tier: null,
        chosen: null,
        confidence: null,
        candidates: pool.map((entry) => ({ entry, score: 1, baseScore: 1 })),
      };
    }
  }

  if (candidates.length === 0) {
    return { status: 'not_found', tier: null, chosen: null, confidence: null, candidates: [] };
  }

  // --- tier 1: exact normalised match --------------------------------------
  const exact = candidates.filter((c) => c.entry.titleNorm === norm).map((c) => c.entry);
  if (exact.length > 0) {
    const settled = settleExactMatches(exact, ctx);
    if (settled.chosen) {
      return {
        status: 'auto_matched',
        tier: 1,
        chosen: settled.chosen,
        confidence: 1,
        candidates: withChosen(candidates, settled.chosen),
      };
    }
    return { status: 'needs_review', tier: null, chosen: null, confidence: null, candidates };
  }

  // --- tier 2: fuzzy, with the margin rule ---------------------------------
  const top = candidates[0]!;
  const runnerUp = candidates[1];
  const margin = runnerUp ? top.score - runnerUp.score : 1;

  if (top.score >= ctx.settings.fuzzyThreshold && margin >= ctx.settings.fuzzyMargin) {
    return {
      status: 'auto_matched',
      tier: 2,
      chosen: top.entry,
      confidence: top.score,
      candidates: withChosen(candidates, top.entry),
    };
  }

  // If the leaders are the same title in different regions, the region policy
  // can still settle it — the tie is about region, which is exactly what the
  // preference list is for.
  const leaders = candidates
    .filter((c) => c.score >= ctx.settings.fuzzyThreshold)
    .map((c) => c.entry);
  if (
    leaders.length > 1 &&
    differOnlyByRegion(leaders) &&
    hasPreferredRegion(leaders, ctx.regionPreference)
  ) {
    const settled = settleExactMatches(leaders, ctx);
    if (settled.chosen) {
      return {
        status: 'auto_matched',
        tier: 2,
        chosen: settled.chosen,
        confidence: top.score,
        candidates: withChosen(candidates, settled.chosen),
      };
    }
  }

  // --- tier 3: you ---------------------------------------------------------
  // Everything the free tiers could not settle goes to the review queue, where
  // confirming it writes a learned alias so the same input never needs asking
  // about twice.
  return { status: 'needs_review', tier: null, chosen: null, confidence: top.score, candidates };
}
