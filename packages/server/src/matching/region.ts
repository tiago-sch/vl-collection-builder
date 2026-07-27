/**
 * Region policy (plan §4.2).
 *
 * Region is a policy you set, not something the matcher guesses. It is applied
 * deterministically, after title scoring, and never delegated to fuzzy matching
 * or to a model.
 *
 * The load-bearing constraint: the bonus is always smaller than the tier-2
 * margin, so region preference breaks ties between equally good title matches
 * but can never promote a worse one. `effectiveRegionBonus` in db/settings.ts
 * clamps it, so even a bad Settings edit cannot violate this.
 */
import type { CatalogEntry } from '@vault-lookup/shared';

/** Case-insensitive index of a candidate's best region in the preference list. */
export function regionRank(regions: string[], preference: string[]): number {
  if (preference.length === 0) return -1;
  const lower = preference.map((r) => r.toLowerCase());
  let best = -1;
  for (const r of regions) {
    const i = lower.indexOf(r.toLowerCase());
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  return best;
}

/**
 * Bonus for a candidate's region, scaled by position in the preference list:
 * first place gets the full bonus, later places proportionally less, anything
 * unlisted gets nothing.
 */
export function regionBonusFor(
  regions: string[],
  preference: string[],
  maxBonus: number,
): number {
  const rank = regionRank(regions, preference);
  if (rank === -1) return 0;
  if (preference.length === 1) return maxBonus;
  return maxBonus * (1 - rank / preference.length);
}

/** strictRegion: drop anything outside the preference list entirely. */
export function filterStrict(entries: CatalogEntry[], preference: string[]): CatalogEntry[] {
  if (preference.length === 0) return entries;
  return entries.filter((e) => regionRank(e.regions, preference) !== -1);
}

/**
 * Do these candidates differ only by region?
 *
 * When they do and the preferred region is present, the top one can be
 * auto-accepted — the plan calls this the single biggest reduction in review
 * volume, and it is safe precisely because you set the policy explicitly.
 */
export function differOnlyByRegion(entries: CatalogEntry[]): boolean {
  if (entries.length < 2) return false;
  const first = entries[0]!;
  return entries.every((e) => e.titleNorm === first.titleNorm);
}

/** True when at least one candidate sits in the preference list. */
export function hasPreferredRegion(entries: CatalogEntry[], preference: string[]): boolean {
  return entries.some((e) => regionRank(e.regions, preference) !== -1);
}
