/**
 * Environment-derived configuration.
 *
 * Everything here is read once at boot. Values that a user should be able to
 * change without a restart live in the `settings` table instead (see db/settings.ts);
 * this file holds only what shapes the process itself.
 */
import { resolve } from 'node:path';

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

/** REGION_PREFERENCE accepts 'USA,Europe,Japan'. Empty means "ask in the wizard". */
function regionList(name: string): string[] {
  const v = process.env[name];
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  port: int('PORT', 8080),
  /**
   * Binds to loopback by default so a stray `docker run` doesn't put this on the
   * LAN (plan §12 q4). In a container you need 0.0.0.0 for published ports to
   * work, so the Dockerfile sets HOST explicitly.
   */
  host: str('HOST', '127.0.0.1'),

  databasePath: resolve(str('DATABASE_PATH', './data/vault.db')),

  /** Where the built web client lives. Empty disables static serving (dev mode). */
  webRoot: str('WEB_ROOT', ''),

  // --- source registry (plan §1.1) ---
  sourcesPath: str('SOURCES_PATH', ''),
  sourcesUrl: str('SOURCES_URL', ''),

  // --- crawler politeness ---
  crawlDelayMs: int('CRAWL_DELAY_MS', 1200),
  userAgent: str('USER_AGENT', 'vl-collection-builder/0.1 (personal catalogue tool)'),
  requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 30_000),
  maxRetries: int('CRAWL_MAX_RETRIES', 3),

  // --- circuit breaker (plan §1.1, adopted from gamarr) ---
  circuitFailureThreshold: int('CIRCUIT_FAILURE_THRESHOLD', 5),
  circuitResetMs: int('CIRCUIT_RESET_MS', 5 * 60_000),

  // --- setup ---
  regionPreference: regionList('REGION_PREFERENCE'),
  setupSkip: bool('SETUP_SKIP', false),

  // --- resolver (phase 8; absent key means tier 3 never runs) ---
  resolver: str('RESOLVER', ''),
  resolverModel: str('RESOLVER_MODEL', ''),
  resolverMaxItems: int('RESOLVER_MAX_ITEMS', 50),

  // --- downloads (plan §8) ---
  downloadsPath: resolve(str('DOWNLOADS_PATH', './downloads')),
  /**
   * Pause between files. There is deliberately NO concurrency setting: the site
   * operator has stated downloads are one at a time, and vl-downloader's author
   * asks the same. The worker is a single loop by construction, not a pool sized
   * to 1 — see plan §8.0.
   */
  interDownloadDelayMs: int('INTER_DOWNLOAD_DELAY_MS', 3000),
  downloadRetryLimit: int('DOWNLOAD_RETRY_LIMIT', 3),
  /** 0 means no timeout. ROMs are large and links can be slow. */
  downloadTimeoutMs: int('DOWNLOAD_TIMEOUT_MS', 0),
  minFreeDiskMb: int('MIN_FREE_DISK_MB', 2048),
  /**
   * The download host rejects our honest crawler UA with 400. Only this endpoint
   * needs a browser UA; crawling keeps the honest one. Kept as its own setting so
   * the choice is visible and overridable rather than buried in the client.
   */
  downloadUserAgent: str('DOWNLOAD_USER_AGENT', ''),
  /** Off by default: the worker only runs when you ask for it. */
  downloadsEnabled: bool('DOWNLOADS_ENABLED', true),

  // --- organizing (plan §9) ---
  libraryPath: resolve(str('LIBRARY_PATH', './library')),
  workPath: str('WORK_PATH', ''),
  organizeEnabled: bool('ORGANIZE_ENABLED', true),
  extractPolicy: str('EXTRACT_POLICY', 'disc-only'),
  keepArchive: bool('KEEP_ARCHIVE', false),
  namingTemplate: str('NAMING_TEMPLATE', '{title} ({region})'),
  platformFolderStyle: str('PLATFORM_FOLDER_STYLE', 'slug'),
  platformFolderMap: str('PLATFORM_FOLDER_MAP', ''),
  generateM3u: bool('GENERATE_M3U', true),
  rewriteCuePaths: bool('REWRITE_CUE_PATHS', true),
  chdPolicy: str('CHD_POLICY', 'disc-only'),
  chdKeepSource: bool('CHD_KEEP_SOURCE', false),
  organizeMinFreeDiskMb: int('ORGANIZE_MIN_FREE_DISK_MB', 4096),

  logLevel: str('LOG_LEVEL', 'info'),
} as const;

/** WORK_PATH defaults inside the library volume so the final move is a rename. */
export function workPath(): string {
  return config.workPath ? resolve(config.workPath) : resolve(config.libraryPath, '.tmp');
}

/** Defaults for the `settings` table, applied on first boot only. */
export const settingDefaults = {
  region_preference: JSON.stringify(config.regionPreference),
  strict_region: 'false',
  /** Tier 2 auto-accept floor (plan §4.1). */
  fuzzy_threshold: '0.95',
  /**
   * Required gap between the top two candidates. This is the rule that stops
   * two regional variants scoring ~0.99 from being auto-accepted (plan §4.1).
   */
  fuzzy_margin: '0.08',
  /**
   * Max region bonus. MUST stay below fuzzy_margin, or region preference could
   * promote a worse title match instead of merely breaking ties (plan §4.2).
   */
  region_bonus: '0.05',
  max_candidates: '8',
  stale_after_days: '30',
  crawl_delay_ms: String(config.crawlDelayMs),
  resolver_provider: config.resolver,
} as const;

export type SettingKey = keyof typeof settingDefaults | 'setup_completed_at';
