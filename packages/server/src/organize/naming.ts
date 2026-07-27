/**
 * Library naming (plan §9.2, §9.2b).
 *
 * The convention is No-Intro / Redump style — `Title (Region) (Version).ext` —
 * because that is what the scraper ecosystem (EmulationStation, Skraper,
 * RetroArch playlists, LaunchBox) matches against. Inventing our own would mean
 * every front-end fails to identify the library.
 *
 * We already hold title, region and version from the catalogue, captured at
 * match time rather than guessed from a filename afterwards — a quiet payoff
 * from having built matching first.
 */
import type { SourceRegistry } from '../sources/load.js';

export interface NamingContext {
  title: string;
  region: string | null;
  version: string | null;
  platform: string;
  vaultId: number | null;
  disc: number | null;
}

/**
 * Characters no common filesystem accepts.
 *
 * Replaced, not stripped, so `Ratchet & Clank: Up Your Arsenal` stays readable
 * as `Ratchet & Clank - Up Your Arsenal` rather than collapsing into
 * `Ratchet & Clank Up Your Arsenal`.
 */
const REPLACEMENTS: Array<[RegExp, string]> = [
  [/\s*:\s*/g, ' - '],
  [/[/\\]/g, '-'],
  [/[<>]/g, ''],
  [/\|/g, '-'],
  [/"/g, "'"],
  [/\?/g, ''],
  [/\*/g, ''],
];

/** Windows refuses these regardless of extension. */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

export function sanitizeSegment(input: string): string {
  let s = input;
  for (const [pattern, to] of REPLACEMENTS) s = s.replace(pattern, to);
  // Control characters, written as escapes so the source stays plain ASCII.
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  // A trailing dot or space is legal on POSIX and silently dropped on Windows,
  // which makes a library non-portable in a way that is hard to notice.
  s = s.replace(/[. ]+$/, '');
  if (RESERVED.has(s.toLowerCase())) s = `_${s}`;
  return s.slice(0, 180);
}

/**
 * Render a naming template.
 *
 * Empty tokens collapse cleanly: a game with no region must not become
 * `Okami ().iso`, so an empty bracket group is removed rather than left behind.
 */
export function renderTemplate(template: string, ctx: NamingContext): string {
  const values: Record<string, string> = {
    title: ctx.title,
    region: ctx.region ?? '',
    version: ctx.version ?? '',
    platform: ctx.platform,
    vaultId: ctx.vaultId === null ? '' : String(ctx.vaultId),
    disc: ctx.disc === null ? '' : String(ctx.disc),
  };

  let out = template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');

  // Drop bracket groups left empty by a missing token.
  out = out.replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '');
  return sanitizeSegment(out);
}

/** `Title (USA) (Disc 1)` for one disc of a multi-disc set. */
export function discName(base: string, disc: number): string {
  return sanitizeSegment(`${base} (Disc ${disc})`);
}

// ---------------------------------------------------------------------------
// Platform folder naming (plan §9.2b)
// ---------------------------------------------------------------------------

export interface FolderStyleResult {
  folder: string;
  /** Where the name came from, so Settings can explain it. */
  source: 'map' | 'preset' | 'slug';
}

/** Parse `PLATFORM_FOLDER_MAP` — `genesis=megadrive,ngc=gc`. */
export function parseFolderMap(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split('=').map((s) => s.trim());
    if (k && v) out[k.toLowerCase()] = v;
  }
  return out;
}

/**
 * Resolve a platform's folder name.
 *
 * Precedence is override -> preset -> raw slug (plan §9.2b). A front-end that
 * cannot find its system shows an empty console rather than an error, so
 * getting this wrong looks like missing games.
 */
export function platformFolder(
  slug: string,
  style: string,
  map: Record<string, string>,
  registry: Pick<SourceRegistry, 'folderStyles'>,
): FolderStyleResult {
  const override = map[slug.toLowerCase()];
  if (override) return { folder: sanitizeSegment(override), source: 'map' };

  const preset = registry.folderStyles?.[style]?.[slug];
  if (preset) return { folder: sanitizeSegment(preset), source: 'preset' };

  return { folder: sanitizeSegment(slug), source: 'slug' };
}

/**
 * Validate a folder map against the registry at boot.
 *
 * An unknown slug on the left-hand side — `gamecube=gc` when our slug is `ngc` —
 * is logged and surfaced in Settings, then ignored. It must not crash the
 * container, but it must not silently mis-file 400 games either.
 */
export function validateFolderMap(
  map: Record<string, string>,
  knownSlugs: string[],
): string[] {
  const known = new Set(knownSlugs.map((s) => s.toLowerCase()));
  return Object.keys(map)
    .filter((k) => !known.has(k))
    .map(
      (k) =>
        `PLATFORM_FOLDER_MAP: '${k}' is not a known platform slug and will be ignored (did you mean one of: ${knownSlugs.slice(0, 6).join(', ')}…?)`,
    );
}
