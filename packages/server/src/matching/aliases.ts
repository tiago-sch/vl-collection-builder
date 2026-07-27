/**
 * Alias lookup, tier 0 of the cascade (plan §4.3).
 *
 * Two sources, both local and both free:
 *   - static  — data/aliases.json, hand-reviewed and committed
 *   - learned — every confirmation you make in the review queue
 *
 * Learned aliases win over static ones: your own corrections should always
 * outrank a generic table, and they are the reason the tool needs the expensive
 * tiers less the more you use it.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogEntry, LearnedAlias } from '@vault-lookup/shared';
import { getDb, nowIso } from '../db/client.js';
import { entriesByNorm, entryById } from '../db/catalog.js';
import { normalizeTitle } from './normalize.js';

const here = dirname(fileURLToPath(import.meta.url));

interface StaticAlias {
  from: string;
  to: string;
  platforms?: string[];
}

/** normalised `from` -> entries. Loaded once. */
let staticAliases: Map<string, StaticAlias[]> | null = null;
let staticAliasError: string | null = null;

/**
 * Built output lives in dist/matching, so the copied asset sits at ../data.
 * Running from source puts this file in src/matching, where the committed file
 * is at ../../data. Both are tried rather than assuming one layout — getting
 * this wrong silently disables tier 0, which looks like bad matching rather
 * than a missing file.
 */
const ALIAS_PATHS = ['../data/aliases.json', '../../data/aliases.json'];

export async function loadStaticAliases(): Promise<Map<string, StaticAlias[]>> {
  if (staticAliases) return staticAliases;

  const map = new Map<string, StaticAlias[]>();
  const errors: string[] = [];
  let loaded = false;

  for (const candidate of ALIAS_PATHS) {
    try {
      const text = await readFile(resolve(here, candidate), 'utf8');
      const parsed = JSON.parse(text) as { aliases?: StaticAlias[] };
      for (const a of parsed.aliases ?? []) {
        if (typeof a.from !== 'string' || typeof a.to !== 'string') continue;
        const key = normalizeTitle(a.from);
        if (!key) continue;
        const list = map.get(key) ?? [];
        list.push(a);
        map.set(key, list);
      }
      loaded = true;
      break;
    } catch (err) {
      errors.push(`${candidate}: ${(err as Error).message}`);
    }
  }

  // A missing alias file costs accuracy, not availability — the tool still runs,
  // more items just reach the review queue. But it must not be silent.
  if (!loaded) {
    staticAliasError = `static alias table could not be loaded (${errors.join('; ')})`;
    console.warn(staticAliasError);
  }

  staticAliases = map;
  return map;
}

/** Surfaced by /api/health so a broken alias table is visible, not guessed at. */
export function staticAliasStatus(): { loaded: number; error: string | null } {
  return { loaded: staticAliases?.size ?? 0, error: staticAliasError };
}

export function resetAliasCache(): void {
  staticAliases = null;
  staticAliasError = null;
}

/**
 * Resolve an alias to catalogue entries.
 *
 * A static alias maps one string to another STRING, which is then looked up in
 * the local catalogue — it never carries an id. So an alias pointing at a game
 * this platform does not have simply finds nothing, rather than inventing a row.
 */
export async function resolveAlias(
  platform: string,
  inputNorm: string,
): Promise<{ entries: CatalogEntry[]; source: 'user' | 'static' } | null> {
  // Learned first — your confirmations outrank the shipped table.
  const learned = getDb()
    .prepare('SELECT entry_id, vault_id FROM learned_alias WHERE platform = ? AND input_norm = ?')
    .get(platform, inputNorm) as { entry_id: number; vault_id: number } | undefined;

  if (learned) {
    const entry = entryById(learned.entry_id);
    if (entry) return { entries: [entry], source: 'user' };
    // The entry was removed by a re-sync; the alias row is stale. Drop it so it
    // stops shadowing a working match.
    getDb()
      .prepare('DELETE FROM learned_alias WHERE platform = ? AND input_norm = ?')
      .run(platform, inputNorm);
  }

  const map = await loadStaticAliases();
  const hits = map.get(inputNorm);
  if (!hits) return null;

  for (const hit of hits) {
    if (hit.platforms && !hit.platforms.includes(platform)) continue;
    const entries = entriesByNorm(platform, normalizeTitle(hit.to));
    if (entries.length > 0) return { entries, source: 'static' };
  }
  return null;
}

export function recordLearnedAlias(
  platform: string,
  inputNorm: string,
  entry: CatalogEntry,
  source: 'user' | 'static' | 'llm' = 'user',
): void {
  if (!inputNorm) return;
  getDb()
    .prepare(
      `INSERT INTO learned_alias (platform, input_norm, entry_id, vault_id, source, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (platform, input_norm) DO UPDATE SET
         entry_id = excluded.entry_id,
         vault_id = excluded.vault_id,
         source   = excluded.source,
         confirmed_at = excluded.confirmed_at`,
    )
    .run(platform, inputNorm, entry.id, entry.vaultId, source, nowIso());
}

export function listLearnedAliases(platform?: string): LearnedAlias[] {
  const sql = `
    SELECT la.*, ce.title
      FROM learned_alias la
      LEFT JOIN catalog_entry ce ON ce.id = la.entry_id
     ${platform ? 'WHERE la.platform = ?' : ''}
     ORDER BY la.confirmed_at DESC`;
  const stmt = getDb().prepare(sql);
  const rows = (platform ? stmt.all(platform) : stmt.all()) as unknown as Array<{
    id: number;
    platform: string;
    input_norm: string;
    entry_id: number;
    vault_id: number;
    source: string;
    confirmed_at: string;
    title: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    platform: r.platform,
    inputNorm: r.input_norm,
    entryId: r.entry_id,
    vaultId: r.vault_id,
    source: r.source as LearnedAlias['source'],
    confirmedAt: r.confirmed_at,
    title: r.title ?? undefined,
  }));
}

/** Settings action: delete an alias you confirmed by mistake. */
export function deleteLearnedAlias(id: number): boolean {
  const info = getDb().prepare('DELETE FROM learned_alias WHERE id = ?').run(id);
  return Number(info.changes) > 0;
}
