/**
 * Typed accessors over the key/value `settings` table.
 *
 * Values are stored as text; this module owns the parsing so no route has to
 * remember that region_preference is JSON and strict_region is a string boolean.
 */
import type { AppSettings } from '@vault-lookup/shared';
import { getDb, nowIso } from './client.js';
import { settingDefaults } from '../config.js';

export function getRaw(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setRaw(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, nowIso());
}

function num(key: string, fallback: number): number {
  const raw = getRaw(key);
  if (raw === null) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function flag(key: string, fallback: boolean): boolean {
  const raw = getRaw(key);
  if (raw === null) return fallback;
  return raw === 'true' || raw === '1';
}

function jsonArray(key: string): string[] {
  const raw = getRaw(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function getSettings(): AppSettings {
  return {
    regionPreference: jsonArray('region_preference'),
    strictRegion: flag('strict_region', false),
    fuzzyThreshold: num('fuzzy_threshold', Number(settingDefaults.fuzzy_threshold)),
    fuzzyMargin: num('fuzzy_margin', Number(settingDefaults.fuzzy_margin)),
    regionBonus: num('region_bonus', Number(settingDefaults.region_bonus)),
    maxCandidates: num('max_candidates', Number(settingDefaults.max_candidates)),
    crawlDelayMs: num('crawl_delay_ms', Number(settingDefaults.crawl_delay_ms)),
    staleAfterDays: num('stale_after_days', Number(settingDefaults.stale_after_days)),
    resolverProvider: getRaw('resolver_provider') || null,
    setupCompletedAt: getRaw('setup_completed_at'),
  };
}

/**
 * Region bonus must stay strictly below the tier-2 margin (plan §4.2), or a
 * preferred region could outrank a genuinely better title match. Callers get a
 * clamped value rather than an error so a bad Settings edit degrades safely.
 */
export function effectiveRegionBonus(s: AppSettings): number {
  const ceiling = Math.max(0, s.fuzzyMargin - 0.005);
  return Math.min(s.regionBonus, ceiling);
}

export interface SettingsPatch {
  regionPreference?: string[];
  strictRegion?: boolean;
  fuzzyThreshold?: number;
  fuzzyMargin?: number;
  regionBonus?: number;
  maxCandidates?: number;
  crawlDelayMs?: number;
  staleAfterDays?: number;
  resolverProvider?: string | null;
}

export function updateSettings(patch: SettingsPatch): AppSettings {
  if (patch.regionPreference !== undefined) {
    setRaw('region_preference', JSON.stringify(patch.regionPreference));
  }
  if (patch.strictRegion !== undefined) setRaw('strict_region', String(patch.strictRegion));
  if (patch.fuzzyThreshold !== undefined) setRaw('fuzzy_threshold', String(patch.fuzzyThreshold));
  if (patch.fuzzyMargin !== undefined) setRaw('fuzzy_margin', String(patch.fuzzyMargin));
  if (patch.regionBonus !== undefined) setRaw('region_bonus', String(patch.regionBonus));
  if (patch.maxCandidates !== undefined) setRaw('max_candidates', String(patch.maxCandidates));
  if (patch.crawlDelayMs !== undefined) setRaw('crawl_delay_ms', String(patch.crawlDelayMs));
  if (patch.staleAfterDays !== undefined) setRaw('stale_after_days', String(patch.staleAfterDays));
  if (patch.resolverProvider !== undefined) setRaw('resolver_provider', patch.resolverProvider ?? '');
  return getSettings();
}

export function isSetupComplete(): boolean {
  return getRaw('setup_completed_at') !== null;
}

export function markSetupComplete(): void {
  setRaw('setup_completed_at', nowIso());
}
