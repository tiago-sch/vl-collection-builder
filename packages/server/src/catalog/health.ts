/**
 * Per-source health with a circuit breaker (plan §1.1, changed decision #3,
 * adopted from gamarr).
 *
 * A 0-100 score decays on failure and recovers on success. After a streak of
 * consecutive failures the circuit opens and requests are refused locally until
 * a retry window elapses — so a site that is down, or that has started refusing
 * us, produces one clear error instead of hundreds of timeouts.
 */
import type { SourceHealth } from '@vault-lookup/shared';
import { getDb, nowIso } from '../db/client.js';
import { config } from '../config.js';

const FAILURE_PENALTY = 20;
const SUCCESS_REWARD = 5;

function ensureRow(source: string): void {
  getDb()
    .prepare(
      `INSERT INTO source_health (source, updated_at) VALUES (?, ?)
       ON CONFLICT(source) DO NOTHING`,
    )
    .run(source, nowIso());
}

export function getHealth(source: string): SourceHealth {
  ensureRow(source);
  const row = getDb()
    .prepare('SELECT * FROM source_health WHERE source = ?')
    .get(source) as Record<string, unknown>;

  return {
    score: Number(row.score ?? 100),
    failureStreak: Number(row.failure_streak ?? 0),
    circuitOpen: Number(row.circuit_open ?? 0) === 1,
    circuitOpenedAt: (row.circuit_opened_at as string) ?? null,
    retryAfter: (row.retry_after as string) ?? null,
    lastError: (row.last_error as string) ?? null,
    totalRequests: Number(row.total_requests ?? 0),
    totalFailures: Number(row.total_failures ?? 0),
  };
}

export class CircuitOpenError extends Error {
  constructor(public readonly retryAfter: string | null) {
    super(
      retryAfter
        ? `circuit is open for this source until ${retryAfter}`
        : 'circuit is open for this source',
    );
    this.name = 'CircuitOpenError';
  }
}

/**
 * Throws if the circuit is open and the retry window has not elapsed.
 * Once it has, the circuit half-opens: the next request is allowed through and
 * its result decides whether the circuit closes or re-opens.
 */
export function assertClosed(source: string): void {
  const h = getHealth(source);
  if (!h.circuitOpen) return;

  if (h.retryAfter && Date.parse(h.retryAfter) <= Date.now()) {
    getDb()
      .prepare('UPDATE source_health SET circuit_open = 0, updated_at = ? WHERE source = ?')
      .run(nowIso(), source);
    return;
  }
  throw new CircuitOpenError(h.retryAfter);
}

export function recordSuccess(source: string): void {
  ensureRow(source);
  getDb()
    .prepare(
      `UPDATE source_health
          SET score = MIN(100, score + ?),
              failure_streak = 0,
              circuit_open = 0,
              circuit_opened_at = NULL,
              retry_after = NULL,
              last_error = NULL,
              total_requests = total_requests + 1,
              updated_at = ?
        WHERE source = ?`,
    )
    .run(SUCCESS_REWARD, nowIso(), source);
}

export function recordFailure(source: string, error: string): SourceHealth {
  ensureRow(source);
  const now = nowIso();

  getDb()
    .prepare(
      `UPDATE source_health
          SET score = MAX(0, score - ?),
              failure_streak = failure_streak + 1,
              last_error = ?,
              total_requests = total_requests + 1,
              total_failures = total_failures + 1,
              updated_at = ?
        WHERE source = ?`,
    )
    .run(FAILURE_PENALTY, error.slice(0, 500), now, source);

  const h = getHealth(source);
  if (!h.circuitOpen && h.failureStreak >= config.circuitFailureThreshold) {
    const retryAfter = new Date(Date.now() + config.circuitResetMs).toISOString();
    getDb()
      .prepare(
        `UPDATE source_health
            SET circuit_open = 1, circuit_opened_at = ?, retry_after = ?, updated_at = ?
          WHERE source = ?`,
      )
      .run(now, retryAfter, now, source);
    return getHealth(source);
  }
  return h;
}

/** Settings action: clear a tripped breaker without waiting out the window. */
export function resetHealth(source: string): void {
  getDb()
    .prepare(
      `UPDATE source_health
          SET score = 100, failure_streak = 0, circuit_open = 0,
              circuit_opened_at = NULL, retry_after = NULL, last_error = NULL, updated_at = ?
        WHERE source = ?`,
    )
    .run(nowIso(), source);
}
