/**
 * Types shared by the server and the web client.
 *
 * Anything crossing the /api boundary is declared here so the two sides cannot
 * drift. Nothing in this file may import from server or web.
 */

// ---------------------------------------------------------------------------
// Platforms & sources
// ---------------------------------------------------------------------------

/** A platform as exposed by the source registry (packages/server/src/sources). */
export interface Platform {
  /** Our stable slug, used in URLs and folder names: 'ps2'. */
  slug: string;
  /** The value Vimm expects in its `system` query parameter: 'PS2'. */
  system: string;
  /** Human label for the UI: 'PlayStation 2'. */
  label: string;
  /** Disc-based systems need extraction and CHD conversion (phases 8-9). */
  discBased: boolean;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/** One row of the mirrored remote catalogue. */
export interface CatalogEntry {
  id: number;
  platform: string;
  vaultId: number;
  title: string;
  titleNorm: string;
  /** Primary region. Multi-region releases keep the full list in `regions`. */
  region: string | null;
  /** Every region flag on the row, in source order: ['USA', 'Canada']. */
  regions: string[];
  version: string | null;
  languages: string | null;
  rating: number | null;
  url: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** What the parser produces before it reaches the database. */
export interface ParsedEntry {
  vaultId: number;
  title: string;
  regions: string[];
  version: string | null;
  languages: string | null;
  rating: number | null;
}

export interface ParseResult {
  entries: ParsedEntry[];
  /** 'table' is the primary cheerio path; 'anchors' is the degraded fallback. */
  strategy: 'table' | 'anchors';
  /**
   * True when the fallback ran, so region/version/languages/rating are absent.
   * The UI surfaces this — a review queue without regions is much harder to use.
   */
  columnsMissing: boolean;
  /**
   * Listings are paginated at 200 rows. Missing this is silent data loss: the
   * catalogue looks populated while holding only the first page of each letter.
   */
  hasNextPage: boolean;
  /** Honeypot anchors skipped. Non-zero is expected and healthy — see parser.ts. */
  decoysSkipped: number;
  warnings: string[];
}

export type SyncStatus = 'idle' | 'running' | 'error';

export interface CatalogSyncState {
  platform: string;
  lastSyncedAt: string | null;
  entryCount: number;
  status: SyncStatus;
  error: string | null;
  /** Days since last sync; null when never synced. */
  ageDays: number | null;
  /** True past STALE_AFTER_DAYS — drives the Import screen banner. */
  stale: boolean;
}

/** SSE payload emitted during a catalogue sync. */
export interface SyncProgress {
  platform: string;
  section: string;
  sectionsDone: number;
  sectionsTotal: number;
  entriesSeen: number;
  status: SyncStatus;
  message?: string;
}

// ---------------------------------------------------------------------------
// Jobs & matching
// ---------------------------------------------------------------------------

export type JobStatus = 'resolving' | 'needs_review' | 'complete';

export type JobItemStatus =
  | 'pending'
  | 'auto_matched'
  | 'needs_review'
  | 'confirmed'
  | 'not_found'
  | 'skipped';

/**
 * How an item was resolved.
 * 0 alias · 1 exact · 2 fuzzy · 3 human
 */
export type ResolvedTier = 0 | 1 | 2 | 3;

export const TIER_LABELS: Record<ResolvedTier, string> = {
  0: 'alias',
  1: 'exact',
  2: 'fuzzy',
  3: 'manual',
};

export interface Job {
  id: number;
  platform: string;
  name: string | null;
  regionPreference: string[] | null;
  strictRegion: boolean;
  createdAt: string;
  status: JobStatus;
}

export interface JobCounts {
  byStatus: Record<JobItemStatus, number>;
  byTier: Partial<Record<ResolvedTier, number>>;
  total: number;
}

/**
 * Whether a candidate is something you already have.
 * Computed as the review queue is built so the client needs no second call.
 */
export type LibraryState =
  | 'none'
  /** In `game`. Once the organizer has run this reflects what is on disk. */
  | 'in_library';

export interface Candidate {
  entryId: number;
  vaultId: number;
  title: string;
  region: string | null;
  regions: string[];
  version: string | null;
  languages: string | null;
  rating: number | null;
  url: string;
  /** Final score, after the region bonus. */
  score: number;
  /** Score before the region bonus — kept for debugging threshold behaviour. */
  baseScore: number;
  rank: number;
  libraryState: LibraryState;
}

export interface JobItem {
  id: number;
  jobId: number;
  position: number;
  inputName: string;
  status: JobItemStatus;
  resolvedTier: ResolvedTier | null;
  chosenEntryId: number | null;
  manualUrl: string | null;
  confidence: number | null;
  resolvedAt: string | null;
  candidates: Candidate[];
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export interface Game {
  id: number;
  platform: string;
  name: string;
  inputName: string | null;
  vaultUrl: string;
  vaultId: number | null;
  region: string | null;
  version: string | null;
  sourceJob: number | null;
  resolvedTier: ResolvedTier | null;
  addedAt: string;
}

/** The minimal export shape: `GET /api/games?minimal=true`. */
export interface MinimalGame {
  name: string;
  vaultLink: string;
}

export interface LearnedAlias {
  id: number;
  platform: string;
  inputNorm: string;
  entryId: number;
  vaultId: number;
  source: 'user' | 'static';
  confirmedAt: string;
  /** Joined for display in Settings. */
  title?: string;
}

// ---------------------------------------------------------------------------
// Settings & setup
// ---------------------------------------------------------------------------

export interface AppSettings {
  regionPreference: string[];
  strictRegion: boolean;
  /** Tier 2 auto-accept floor. */
  fuzzyThreshold: number;
  /** Tier 2 required gap between the top two candidates. */
  fuzzyMargin: number;
  /** Max region bonus. Must stay below fuzzyMargin — see §4.2. */
  regionBonus: number;
  /** Candidates kept per item for review. */
  maxCandidates: number;
  crawlDelayMs: number;
  staleAfterDays: number;
  setupCompletedAt: string | null;
}

export interface SetupState {
  completed: boolean;
  /** Platforms that already have at least one synced entry. */
  syncedPlatforms: string[];
  /** Pre-fill for the wizard's region step, from REGION_PREFERENCE. */
  suggestedRegionPreference: string[];
}

export interface SourceHealth {
  score: number;
  failureStreak: number;
  circuitOpen: boolean;
  circuitOpenedAt: string | null;
  retryAfter: string | null;
  lastError: string | null;
  totalRequests: number;
  totalFailures: number;
}

/** Regions Vimm uses, in the order the wizard offers them. */
export const KNOWN_REGIONS = [
  'USA',
  'Europe',
  'Japan',
  'Australia',
  'Korea',
  'Asia',
  'Canada',
  'Brazil',
  'China',
  'France',
  'Germany',
  'Italy',
  'Netherlands',
  'Spain',
  'Sweden',
  'Russia',
  'World',
] as const;

// ---------------------------------------------------------------------------
// Downloads (plan §8)
// ---------------------------------------------------------------------------

export type DownloadStatus =
  | 'queued'
  | 'active'
  | 'paused'
  | 'completed'
  | 'error'
  | 'cancelled'
  /** Bytes are on disk; the organizer has not run yet (plan §9.5). */
  | 'downloaded'
  | 'organizing'
  | 'organized'
  | 'organize_error';

export interface DownloadItem {
  id: number;
  gameId: number | null;
  vaultId: number;
  vaultUrl: string;
  title: string;
  platform: string;
  status: DownloadStatus;
  position: number;
  mediaId: number | null;
  /** 1-based disc index for multi-disc releases. */
  disc: number | null;
  discTotal: number | null;
  fileName: string | null;
  destPath: string | null;
  totalBytes: number;
  receivedBytes: number;
  /** CRC32 of the ROM inside the archive, as published on the vault page. */
  expectCrc32: string | null;
  attempts: number;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** SSE payload from /api/downloads/stream. */
export interface DownloadProgress {
  id: number;
  status: DownloadStatus;
  receivedBytes: number;
  totalBytes: number;
  /** Bytes per second over the last sample window. */
  rate: number;
  title: string;
  fileName: string | null;
}

export interface LibraryFile {
  id: number;
  downloadId: number | null;
  gameId: number | null;
  platform: string;
  relPath: string;
  bytes: number | null;
  kind: string | null;
  createdAt: string;
}

export type ApiError = { error: string; detail?: string };
