/**
 * Runtime-loadable source registry (plan §1.1, changed decision #1).
 *
 * Resolution order: SOURCES_PATH -> SOURCES_URL -> embedded defaults.json.
 * The contract adopted from gamarr is that a bad registry must never stop the
 * container booting — a typo in a mounted file degrades to the embedded copy
 * with a warning, rather than taking the whole tool down.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Platform } from '@vault-lookup/shared';
import { config } from '../config.js';

export interface SourceRegistry {
  baseUrl: string;
  listPath: string;
  platforms: Platform[];
  /**
   * Query parameters appended to every listing request to defeat the site's
   * default filters. Without these the mirror is USA-only and newest-version-only
   * — see the comment in defaults.json.
   */
  listFilters: Record<string, string | string[]>;
  folderStyles: Record<string, Record<string, string>>;
}

const here = dirname(fileURLToPath(import.meta.url));

let cached: SourceRegistry | null = null;
let loadWarnings: string[] = [];

function validate(raw: unknown): SourceRegistry {
  if (typeof raw !== 'object' || raw === null) throw new Error('registry is not an object');
  const r = raw as Record<string, unknown>;

  if (typeof r.baseUrl !== 'string' || !r.baseUrl.startsWith('http')) {
    throw new Error('baseUrl missing or not an http(s) URL');
  }
  if (!Array.isArray(r.platforms) || r.platforms.length === 0) {
    throw new Error('platforms missing or empty');
  }

  const platforms: Platform[] = r.platforms.map((p, i) => {
    if (typeof p !== 'object' || p === null) throw new Error(`platform[${i}] is not an object`);
    const q = p as Record<string, unknown>;
    if (typeof q.slug !== 'string' || !q.slug) throw new Error(`platform[${i}].slug missing`);
    if (typeof q.system !== 'string' || !q.system) throw new Error(`platform[${i}].system missing`);
    return {
      slug: q.slug,
      system: q.system,
      label: typeof q.label === 'string' && q.label ? q.label : q.slug,
      discBased: q.discBased === true,
    };
  });

  const seen = new Set<string>();
  for (const p of platforms) {
    if (seen.has(p.slug)) throw new Error(`duplicate platform slug '${p.slug}'`);
    seen.add(p.slug);
  }

  return {
    baseUrl: r.baseUrl.replace(/\/+$/, ''),
    listPath: typeof r.listPath === 'string' && r.listPath ? r.listPath : '/vault/',
    platforms,
    listFilters:
      typeof r.listFilters === 'object' && r.listFilters !== null
        ? (r.listFilters as Record<string, string | string[]>)
        : {},
    folderStyles:
      typeof r.folderStyles === 'object' && r.folderStyles !== null
        ? (r.folderStyles as Record<string, Record<string, string>>)
        : {},
  };
}

async function loadEmbedded(): Promise<SourceRegistry> {
  const text = await readFile(resolve(here, 'defaults.json'), 'utf8');
  return validate(JSON.parse(text));
}

export async function loadRegistry(): Promise<{ registry: SourceRegistry; warnings: string[] }> {
  if (cached) return { registry: cached, warnings: loadWarnings };

  const warnings: string[] = [];

  if (config.sourcesPath) {
    try {
      const text = await readFile(config.sourcesPath, 'utf8');
      cached = validate(JSON.parse(text));
      loadWarnings = warnings;
      return { registry: cached, warnings };
    } catch (err) {
      warnings.push(`SOURCES_PATH could not be used (${(err as Error).message}); trying next source`);
    }
  }

  if (config.sourcesUrl) {
    try {
      const res = await fetch(config.sourcesUrl, {
        headers: { 'user-agent': config.userAgent },
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      cached = validate(await res.json());
      loadWarnings = warnings;
      return { registry: cached, warnings };
    } catch (err) {
      warnings.push(`SOURCES_URL could not be used (${(err as Error).message}); falling back to embedded registry`);
    }
  }

  cached = await loadEmbedded();
  loadWarnings = warnings;
  return { registry: cached, warnings };
}

/** Test seam — drops the memoized registry. */
export function resetRegistryCache(): void {
  cached = null;
  loadWarnings = [];
}

export async function getPlatform(slug: string): Promise<Platform | undefined> {
  const { registry } = await loadRegistry();
  return registry.platforms.find((p) => p.slug === slug);
}

/** Accepts either our slug ('ps2') or Vimm's system value ('PS2'), case-insensitively. */
export async function resolvePlatform(input: string): Promise<Platform | undefined> {
  const { registry } = await loadRegistry();
  const needle = input.toLowerCase();
  return registry.platforms.find(
    (p) => p.slug.toLowerCase() === needle || p.system.toLowerCase() === needle,
  );
}
