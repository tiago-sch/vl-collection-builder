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
import { getSettings } from '../db/settings.js';
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
    /** Server-requested wait before trying again, from Retry-After. */
    public readonly retryAfterMs: number | null = null,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

/**
 * Vimm fronts every game page with a Cloudflare Turnstile "are you human"
 * check (September 2026) and serves the challenge with a 404 status. There is
 * no media JSON on that page, so a download cannot proceed. The check is tied
 * to the PHPSESSID cookie: pass it once in a browser and paste the cookie into
 * Settings, and the same session is accepted here.
 */
export class HumanCheckError extends Error {
  constructor(public readonly url: string) {
    super(
      'the source site is asking for a human check on this page — open it in your browser, ' +
        'pass the check, then paste your PHPSESSID cookie into Settings → Source session',
    );
    this.name = 'HumanCheckError';
  }
}

/** The challenge page is recognisable by its Turnstile widget. */
export function isHumanCheckPage(html: string): boolean {
  return /class=["']cf-turnstile["']|challenges\.cloudflare\.com\/turnstile/i.test(html);
}

/**
 * Retry-After is either delta-seconds or an HTTP-date. Vimm sends `60`.
 * Anything unparseable is treated as absent so a garbage header cannot stall
 * the crawl.
 */
export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  // Date.parse is lenient enough to accept "-3"; an HTTP-date always names a
  // weekday and month, so demand a letter before treating it as one.
  if (!/[A-Za-z]/.test(header)) return null;
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return null;
}

/**
 * Vimm rate-limits listing requests to roughly 20 per minute per IP
 * (September 2026: a 429 with `Retry-After: 60` after ~20 pages). A retry
 * that ignores the header and comes back in seconds lands inside the ban and
 * extends it, so a 429 is waited out for at least the advertised window.
 * Capped so a hostile or broken header cannot hang a sync for an hour.
 */
const MAX_RETRY_AFTER_MS = 5 * 60_000;
/** Padding on top of Retry-After: the window is measured server-side. */
const RETRY_AFTER_GRACE_MS = 2_000;

/** 4xx other than 429 will not fix themselves — retrying is just noise. */
function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  if (err instanceof HumanCheckError) return false;
  return true; // network error, timeout, aborted read
}

/** The user's verified session, if they pasted one. Empty means no header. */
export function sourceCookieHeader(): Record<string, string> {
  const cookie = getSettings().sourceCookie;
  return cookie ? { cookie } : {};
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
        ...sourceCookieHeader(),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } finally {
    lastRequestAt = Date.now();
  }

  // Read the body before judging the status: the human-check page comes back
  // as a 404, and a bare "404" would send someone hunting for a dead link.
  const body = await res.text();
  if (isHumanCheckPage(body)) throw new HumanCheckError(url);
  if (!res.ok) {
    throw new HttpError(res.status, url, parseRetryAfter(res.headers.get('retry-after')));
  }
  return body;
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
        // Exponential backoff on top of the base delay, but never shorter than
        // what the server asked for — a 429 retried in 2.4s just re-trips it.
        const backoffMs = delayMs * 2 ** attempt;
        const askedMs =
          err instanceof HttpError && err.retryAfterMs !== null
            ? Math.min(err.retryAfterMs + RETRY_AFTER_GRACE_MS, MAX_RETRY_AFTER_MS)
            : 0;
        const waitMs = Math.max(backoffMs, askedMs);
        opts.onRetry?.(attempt, lastError, waitMs);
        await sleep(waitMs);
      }
    }

    // A 404 is the site answering, not failing: Vimm returns it for a letter
    // section with no titles (3DS has no "Q"). It must not count toward the
    // circuit breaker, or a small platform trips it on empty letters alone.
    if (lastError instanceof HttpError && lastError.status === 404) throw lastError;
    // Likewise a human check: the site is up, it just wants a person. Counting
    // it would open the circuit and hide the actionable message.
    if (lastError instanceof HumanCheckError) throw lastError;

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
