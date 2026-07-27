/**
 * Import jobs: turn a pasted list of names into resolved items (plan §5, §6).
 */
import type {
  Candidate,
  Job,
  JobCounts,
  JobItem,
  JobItemStatus,
  ResolvedTier,
} from '@vault-lookup/shared';
import { getDb, nowIso, transaction } from '../db/client.js';
import { allEntries, entryById } from '../db/catalog.js';
import { addGame, ownedVaultIds } from '../db/games.js';
import { effectiveRegionBonus, getSettings } from '../db/settings.js';
import { normalize } from '../matching/normalize.js';
import { recordLearnedAlias } from '../matching/aliases.js';
import { resolveItem, type ResolveContext } from '../matching/resolve.js';

export interface CreateJobInput {
  platform: string;
  names: string[];
  name?: string | null;
  regionPreference?: string[] | null;
  strictRegion?: boolean | null;
  useResolver?: boolean;
}

function buildContext(platform: string, job: Job): ResolveContext {
  const settings = getSettings();
  return {
    platform,
    entries: allEntries(platform),
    settings,
    // Both region fields are resolved and frozen at job creation, so these are
    // already the effective values — see createJob.
    regionPreference: job.regionPreference ?? settings.regionPreference,
    strictRegion: job.strictRegion,
    regionBonus: effectiveRegionBonus(settings),
  };
}

export async function createJob(input: CreateJobInput): Promise<Job> {
  // Deduplicate while preserving the order you pasted.
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of input.names) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (names.length === 0) throw new Error('no game names supplied');

  const db = getDb();
  const createdAt = nowIso();
  const globals = getSettings();

  /**
   * Resolve the region policy against the global defaults now and store the
   * result, rather than leaving nulls to be interpreted later. Plan §4.2 wants
   * re-running an old job to reproduce its original behaviour, which only holds
   * if the settings in force at the time are recorded with it.
   *
   * This also fixes the subtler half: `strict_region` is NOT NULL DEFAULT 0, so
   * reading only the job column silently ignored the global strictRegion setting.
   */
  const regionPreference = input.regionPreference?.length
    ? input.regionPreference
    : globals.regionPreference;
  const strictRegion = input.strictRegion ?? globals.strictRegion;

  const jobId = transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO job (platform, name, region_preference, strict_region, resolver_used, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'resolving')`,
      )
      .run(
        input.platform,
        input.name ?? null,
        JSON.stringify(regionPreference),
        strictRegion ? 1 : 0,
        null, // tier 3 is phase 8
        createdAt,
      );

    const id = Number(info.lastInsertRowid);
    const insertItem = db.prepare(
      `INSERT INTO job_item (job_id, position, input_name, input_norm, status)
       VALUES (?, ?, ?, ?, 'pending')`,
    );
    names.forEach((n, i) => {
      insertItem.run(id, i, n, normalize(n).norm);
    });
    return id;
  });

  await runResolution(jobId);
  return getJob(jobId)!;
}

/** Run the tier cascade over every pending item in a job. */
export async function runResolution(jobId: number): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);

  const ctx = buildContext(job.platform, job);
  const db = getDb();

  const items = db
    .prepare("SELECT id, input_name FROM job_item WHERE job_id = ? AND status = 'pending' ORDER BY position")
    .all(jobId) as unknown as Array<{ id: number; input_name: string }>;

  const updateItem = db.prepare(
    `UPDATE job_item SET status = ?, resolved_tier = ?, chosen_entry = ?, confidence = ?, resolved_at = ?
      WHERE id = ?`,
  );
  const clearCandidates = db.prepare('DELETE FROM match_candidate WHERE job_item_id = ?');
  const insertCandidate = db.prepare(
    `INSERT INTO match_candidate (job_item_id, entry_id, score, base_score, rank, llm_note)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  );

  for (const item of items) {
    const outcome = await resolveItem(item.input_name, ctx);

    transaction(() => {
      clearCandidates.run(item.id);
      outcome.candidates.forEach((c, i) => {
        insertCandidate.run(item.id, c.entry.id, c.score, c.baseScore, i);
      });
      updateItem.run(
        outcome.status,
        outcome.tier,
        outcome.chosen?.id ?? null,
        outcome.confidence,
        outcome.status === 'auto_matched' ? nowIso() : null,
        item.id,
      );
    });
  }

  refreshJobStatus(jobId);
}

export function refreshJobStatus(jobId: number): void {
  const db = getDb();
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS n FROM job_item
        WHERE job_id = ? AND status IN ('pending', 'needs_review')`,
    )
    .get(jobId) as { n: number };

  db.prepare('UPDATE job SET status = ? WHERE id = ?').run(
    pending.n > 0 ? 'needs_review' : 'complete',
    jobId,
  );
}

// ---------------------------------------------------------------------------

interface JobRow {
  id: number;
  platform: string;
  name: string | null;
  region_preference: string | null;
  strict_region: number;
  resolver_used: string | null;
  created_at: string;
  status: Job['status'];
}

function toJob(r: JobRow): Job {
  let regionPreference: string[] | null = null;
  if (r.region_preference) {
    try {
      const parsed = JSON.parse(r.region_preference);
      if (Array.isArray(parsed)) regionPreference = parsed;
    } catch {
      regionPreference = null;
    }
  }
  return {
    id: r.id,
    platform: r.platform,
    name: r.name,
    regionPreference,
    strictRegion: r.strict_region === 1,
    resolverUsed: r.resolver_used,
    createdAt: r.created_at,
    status: r.status,
  };
}

export function getJob(id: number): Job | null {
  const row = getDb().prepare('SELECT * FROM job WHERE id = ?').get(id) as JobRow | undefined;
  return row ? toJob(row) : null;
}

export function listJobs(): Job[] {
  const rows = getDb()
    .prepare('SELECT * FROM job ORDER BY created_at DESC')
    .all() as unknown as JobRow[];
  return rows.map(toJob);
}

export function getCounts(jobId: number): JobCounts {
  const db = getDb();
  const byStatus: Record<JobItemStatus, number> = {
    pending: 0, auto_matched: 0, needs_review: 0, confirmed: 0, not_found: 0, skipped: 0,
  };
  const statusRows = db
    .prepare('SELECT status, COUNT(*) AS n FROM job_item WHERE job_id = ? GROUP BY status')
    .all(jobId) as unknown as Array<{ status: JobItemStatus; n: number }>;
  for (const r of statusRows) byStatus[r.status] = r.n;

  const byTier: Partial<Record<ResolvedTier, number>> = {};
  const tierRows = db
    .prepare(
      'SELECT resolved_tier AS t, COUNT(*) AS n FROM job_item WHERE job_id = ? AND resolved_tier IS NOT NULL GROUP BY resolved_tier',
    )
    .all(jobId) as unknown as Array<{ t: ResolvedTier; n: number }>;
  for (const r of tierRows) byTier[r.t] = r.n;

  return {
    byStatus,
    byTier,
    total: Object.values(byStatus).reduce((a, b) => a + b, 0),
  };
}

/**
 * Items with their candidates.
 *
 * `libraryState` is computed here so the review screen renders duplicate badges
 * without a second round-trip (plan §6.1).
 */
export function listItems(jobId: number, status?: JobItemStatus): JobItem[] {
  const job = getJob(jobId);
  if (!job) return [];

  const db = getDb();
  const owned = ownedVaultIds(job.platform);

  const rows = (
    status
      ? db
          .prepare('SELECT * FROM job_item WHERE job_id = ? AND status = ? ORDER BY position')
          .all(jobId, status)
      : db.prepare('SELECT * FROM job_item WHERE job_id = ? ORDER BY position').all(jobId)
  ) as unknown as Array<{
    id: number;
    job_id: number;
    position: number;
    input_name: string;
    status: JobItemStatus;
    resolved_tier: number | null;
    chosen_entry: number | null;
    manual_url: string | null;
    confidence: number | null;
    resolved_at: string | null;
  }>;

  const candStmt = db.prepare(
    `SELECT mc.*, ce.vault_id, ce.title, ce.region, ce.regions, ce.version, ce.languages, ce.rating, ce.url
       FROM match_candidate mc
       JOIN catalog_entry ce ON ce.id = mc.entry_id
      WHERE mc.job_item_id = ?
      ORDER BY mc.rank`,
  );

  return rows.map((r) => {
    const candRows = candStmt.all(r.id) as unknown as Array<{
      entry_id: number; score: number; base_score: number; rank: number; llm_note: string | null;
      vault_id: number; title: string; region: string | null; regions: string;
      version: string | null; languages: string | null; rating: number | null; url: string;
    }>;

    const candidates: Candidate[] = candRows.map((c) => {
      let regions: string[] = [];
      try {
        const parsed = JSON.parse(c.regions);
        if (Array.isArray(parsed)) regions = parsed;
      } catch {
        regions = [];
      }
      return {
        entryId: c.entry_id,
        vaultId: c.vault_id,
        title: c.title,
        region: c.region,
        regions,
        version: c.version,
        languages: c.languages,
        rating: c.rating,
        url: c.url,
        score: c.score,
        baseScore: c.base_score,
        rank: c.rank,
        llmNote: c.llm_note,
        libraryState: owned.has(c.vault_id) ? 'in_library' : 'none',
      };
    });

    return {
      id: r.id,
      jobId: r.job_id,
      position: r.position,
      inputName: r.input_name,
      status: r.status,
      resolvedTier: (r.resolved_tier as ResolvedTier) ?? null,
      chosenEntryId: r.chosen_entry,
      manualUrl: r.manual_url,
      confidence: r.confidence,
      resolvedAt: r.resolved_at,
      candidates,
    };
  });
}

// ---------------------------------------------------------------------------

export type ResolveAction =
  | { entryId: number }
  | { manualUrl: string }
  | { skip: true };

/**
 * Record your decision on one item.
 *
 * Choosing a catalogue entry writes a learned alias — the confirmation is ground
 * truth, so the same input resolves instantly and for free next time (plan §4.3),
 * and the accumulated pairs are the eval set for §4.5.
 */
export function resolveJobItem(jobId: number, itemId: number, action: ResolveAction): JobItem | null {
  const job = getJob(jobId);
  if (!job) return null;

  const db = getDb();
  const item = db
    .prepare('SELECT * FROM job_item WHERE id = ? AND job_id = ?')
    .get(itemId, jobId) as { id: number; input_norm: string } | undefined;
  if (!item) return null;

  if ('skip' in action) {
    db.prepare("UPDATE job_item SET status = 'skipped', resolved_at = ? WHERE id = ?").run(
      nowIso(),
      itemId,
    );
  } else if ('manualUrl' in action) {
    const url = action.manualUrl.trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('manualUrl must be an http(s) URL');
    db.prepare(
      "UPDATE job_item SET status = 'confirmed', resolved_tier = 4, manual_url = ?, chosen_entry = NULL, resolved_at = ? WHERE id = ?",
    ).run(url, nowIso(), itemId);
  } else {
    const entry = entryById(action.entryId);
    if (!entry) throw new Error(`catalogue entry ${action.entryId} not found`);
    if (entry.platform !== job.platform) {
      throw new Error('that entry belongs to a different platform');
    }
    db.prepare(
      "UPDATE job_item SET status = 'confirmed', resolved_tier = 4, chosen_entry = ?, manual_url = NULL, confidence = 1, resolved_at = ? WHERE id = ?",
    ).run(entry.id, nowIso(), itemId);
    recordLearnedAlias(job.platform, item.input_norm, entry, 'user');
  }

  refreshJobStatus(jobId);
  return listItems(jobId).find((i) => i.id === itemId) ?? null;
}

export interface CommitResult {
  inserted: number;
  existing: number;
  skipped: number;
}

/** Write every settled item into `game`. */
export function commitJob(jobId: number): CommitResult {
  const job = getJob(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);

  const items = listItems(jobId);
  const result: CommitResult = { inserted: 0, existing: 0, skipped: 0 };

  transaction(() => {
    for (const item of items) {
      const settled = item.status === 'auto_matched' || item.status === 'confirmed';
      if (!settled) {
        result.skipped += 1;
        continue;
      }
      const entry = item.chosenEntryId ? entryById(item.chosenEntryId) : null;
      if (!entry && !item.manualUrl) {
        result.skipped += 1;
        continue;
      }
      const outcome = addGame({
        platform: job.platform,
        entry,
        manualUrl: item.manualUrl,
        inputName: item.inputName,
        sourceJob: jobId,
        resolvedTier: item.resolvedTier,
      });
      if (outcome === 'inserted') result.inserted += 1;
      else result.existing += 1;
    }
  });

  return result;
}
