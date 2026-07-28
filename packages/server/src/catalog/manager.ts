/**
 * Background catalogue syncs.
 *
 * A sync is a server-side job, not a request. It used to be driven directly by
 * the SSE request handler, which tied a multi-minute crawl to the life of one
 * HTTP connection: changing tab or refreshing the page closed the connection,
 * which aborted the crawl partway through. You lost the progress display *and*
 * the sync.
 *
 * Now the run lives here. Clients attach to watch it and detach freely; the only
 * things that stop a sync are finishing, failing, or an explicit cancel. This is
 * the same shape the download worker already had — the catalogue sync was the
 * odd one out.
 */
import type { Platform, SyncProgress } from '@vl-collection-builder/shared';
import { syncPlatform, type SyncResult } from './sync.js';
import { setSyncStatus } from '../db/catalog.js';
import { describeError, errorContext } from '../util/errors.js';

export interface SyncRun {
  platform: string;
  startedAt: string;
  progress: SyncProgress;
  /** Set once the run ends, so a late subscriber still learns the outcome. */
  finishedAt: string | null;
  result: SyncResult | null;
  error: string | null;
}

interface InternalRun extends SyncRun {
  listeners: Set<(p: SyncProgress) => void>;
  controller: AbortController;
}

const runs = new Map<string, InternalRun>();

/** Completed runs are kept briefly so a page loaded just after the end still sees it. */
const KEEP_FINISHED_MS = 60_000;

function publish(run: InternalRun, progress: SyncProgress): void {
  run.progress = progress;
  for (const fn of run.listeners) {
    try {
      fn(progress);
    } catch {
      /* a broken client must not stop the crawl */
    }
  }
}

export function isSyncing(platform: string): boolean {
  const run = runs.get(platform);
  return run !== undefined && run.finishedAt === null;
}

export function getRun(platform: string): SyncRun | undefined {
  const run = runs.get(platform);
  if (!run) return undefined;
  const { listeners: _l, controller: _c, ...rest } = run;
  return rest;
}

export function listRuns(): SyncRun[] {
  return [...runs.keys()].map((p) => getRun(p)!).filter(Boolean);
}

/**
 * Start a sync, or return the one already running.
 *
 * Deliberately idempotent: two browser tabs both hitting "sync" should watch one
 * crawl, not start two against the same site.
 */
export function startSync(platform: Platform): SyncRun {
  const existing = runs.get(platform.slug);
  if (existing && existing.finishedAt === null) return getRun(platform.slug)!;

  const run: InternalRun = {
    platform: platform.slug,
    startedAt: new Date().toISOString(),
    progress: {
      platform: platform.slug,
      section: 'starting',
      sectionsDone: 0,
      sectionsTotal: 27,
      entriesSeen: 0,
      status: 'running',
    },
    finishedAt: null,
    result: null,
    error: null,
    listeners: new Set(),
    controller: new AbortController(),
  };
  runs.set(platform.slug, run);

  // Detached on purpose: the crawl outlives whatever request asked for it.
  void (async () => {
    try {
      const result = await syncPlatform(platform, {
        signal: run.controller.signal,
        onProgress: (p) => publish(run, p),
      });
      run.result = result;
      publish(run, { ...run.progress, section: 'done', status: 'idle', entriesSeen: result.entriesSeen });
    } catch (err) {
      const message = describeError(err);
      const cancelled = run.controller.signal.aborted;

      if (cancelled) {
        // Stopping on purpose is not a failure. Whatever was fetched is kept —
        // the crawl resumes from the start next time but re-upserts are cheap.
        setSyncStatus(platform.slug, 'idle', null);
        publish(run, { ...run.progress, section: 'cancelled', status: 'idle', message: 'sync cancelled' });
      } else {
        console.warn(`catalogue sync for ${platform.slug} failed: ${message}`, errorContext(err));
        run.error = message;
        setSyncStatus(platform.slug, 'error', message);
        publish(run, { ...run.progress, section: 'error', status: 'error', message });
      }
    } finally {
      run.finishedAt = new Date().toISOString();
      run.listeners.clear();
      setTimeout(() => {
        // Only drop it if nothing newer took its place.
        if (runs.get(platform.slug) === run) runs.delete(platform.slug);
      }, KEEP_FINISHED_MS).unref?.();
    }
  })();

  return getRun(platform.slug)!;
}

/** Watch a run. Detaching does NOT stop the crawl. */
export function subscribe(platform: string, fn: (p: SyncProgress) => void): () => void {
  const run = runs.get(platform);
  if (!run) return () => undefined;
  run.listeners.add(fn);
  return () => run.listeners.delete(fn);
}

/** The only way a client stops a sync, and it has to be deliberate. */
export function cancelSync(platform: string): boolean {
  const run = runs.get(platform);
  if (!run || run.finishedAt !== null) return false;
  run.controller.abort();
  return true;
}
