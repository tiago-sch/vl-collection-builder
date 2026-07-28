/**
 * Throttled, single-concurrency HTTP client for the source site.
 *
 * Politeness is the point (plan §11): one request at a time, a configurable
 * delay between them, an honest self-identifying User-Agent, bounded retries
 * with backoff, and the circuit breaker in health.ts on top.
 *
 * TLS verification is left on. gamarr disables it on its Vimm client; the plan
 * calls that out as the one thing not to copy.
 */
import { config } from '../config.js';
import { assertClosed, recordFailure, recordSuccess } from './health.js';
import { describeError } from '../util/errors.js';

const SOURCE = 'vimm';

let lastRequestAt = 0;
/** Serialises every request through one promise chain — no parallel fetches. */
let chain: Promise<unknown> = Promise.resolve();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

/** 4xx other than 429 will not fix themselves — retrying is just noise. */
function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  return true; // network error, timeout, aborted read
}

async function fetchOnce(url: string, delayMs: number): Promise<string> {
  const since = Date.now() - lastRequestAt;
  if (since < delayMs) await sleep(delayMs - since);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        'user-agent': config.userAgent,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } finally {
    lastRequestAt = Date.now();
  }

  if (!res.ok) throw new HttpError(res.status, url);
  return await res.text();
}

export interface FetchOptions {
  /** Overrides CRAWL_DELAY_MS; sync passes the value from Settings. */
  delayMs?: number;
  onRetry?: (attempt: number, error: Error, waitMs: number) => void;
}

/**
 * Fetch one page as text. Calls are queued, so concurrent callers still result
 * in strictly serial requests to the site.
 */
export function fetchPage(url: string, opts: FetchOptions = {}): Promise<string> {
  const delayMs = opts.delayMs ?? config.crawlDelayMs;

  const run = async (): Promise<string> => {
    assertClosed(SOURCE);

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
      try {
        const body = await fetchOnce(url, delayMs);
        recordSuccess(SOURCE);
        return body;
      } catch (err) {
        lastError = err as Error;
        if (!isRetryable(err) || attempt === config.maxRetries) break;
        // Exponential backoff on top of the base delay.
        const waitMs = delayMs * 2 ** attempt;
        opts.onRetry?.(attempt, lastError, waitMs);
        await sleep(waitMs);
      }
    }

    const described = lastError ? describeError(lastError) : 'unknown error';
    const health = recordFailure(SOURCE, described);
    if (health.circuitOpen) {
      throw new Error(
        `${described} — circuit opened after ${health.failureStreak} consecutive failures, retrying after ${health.retryAfter}`,
      );
    }
    // Preserve the original as the cause so nothing upstream loses detail.
    throw new Error(described, { cause: lastError });
  };

  // Queue on the shared chain; a rejection must not break the chain for others.
  const queued = chain.then(run, run);
  chain = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

export const SOURCE_NAME = SOURCE;
