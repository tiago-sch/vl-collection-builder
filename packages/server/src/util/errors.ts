/**
 * Turning errors into something an operator can act on.
 *
 * Node's `fetch` reports every transport failure as the literal string
 * `fetch failed`. The real reason — DNS, connection reset, TLS, timeout — lives
 * on `error.cause`, often nested another level down. Recording only `.message`
 * therefore produces a log line that tells you a download failed and nothing
 * whatsoever about why, which is the least useful possible outcome.
 */

interface ErrnoLike {
  code?: string;
  errno?: number;
  syscall?: string;
  hostname?: string;
  address?: string;
  port?: number;
}

/** Human-readable explanations for the codes that actually show up here. */
const EXPLANATIONS: Record<string, string> = {
  ENOTFOUND: 'DNS lookup failed — the host could not be resolved',
  EAI_AGAIN: 'DNS lookup timed out — usually a transient resolver problem',
  ECONNREFUSED: 'the host refused the connection',
  ECONNRESET: 'the connection was reset by the peer mid-transfer',
  EPIPE: 'the connection closed while data was still being written',
  ETIMEDOUT: 'the connection timed out',
  UND_ERR_CONNECT_TIMEOUT: 'timed out establishing the connection',
  UND_ERR_HEADERS_TIMEOUT: 'the server accepted the connection but sent no response headers in time',
  UND_ERR_BODY_TIMEOUT: 'the response body stalled — the transfer stopped partway',
  UND_ERR_SOCKET: 'the socket closed unexpectedly',
  CERT_HAS_EXPIRED: "the server's TLS certificate has expired",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the TLS certificate chain could not be verified',
  ENOSPC: 'no space left on the device',
  EACCES: 'permission denied — check the uid the container runs as against the mount owner',
  EROFS: 'the filesystem is read-only',
};

/**
 * Flatten an error and its `cause` chain into one line.
 *
 * `fetch failed` becomes
 * `fetch failed: ECONNRESET — the connection was reset by the peer mid-transfer`.
 */
export function describeError(err: unknown, maxDepth = 4): string {
  const parts: string[] = [];
  let current: unknown = err;
  let depth = 0;

  while (current && depth < maxDepth) {
    const e = current as Error & ErrnoLike;
    const detail: string[] = [];

    if (e.code) {
      const explanation = EXPLANATIONS[e.code];
      detail.push(explanation ? `${e.code} — ${explanation}` : e.code);
    }
    if (e.hostname) detail.push(`host ${e.hostname}`);
    else if (e.address) detail.push(`address ${e.address}${e.port ? `:${e.port}` : ''}`);
    if (e.syscall && !e.code) detail.push(`syscall ${e.syscall}`);

    const message = typeof e.message === 'string' && e.message ? e.message : String(current);
    // Skip a cause whose message just repeats the layer above it.
    const line = detail.length > 0 ? `${message} (${detail.join(', ')})` : message;
    if (!parts.some((p) => p === line)) parts.push(line);

    current = (e as { cause?: unknown }).cause;
    depth += 1;
  }

  return parts.join(': ');
}

/** The full object for the log, where there is room for a stack. */
export function errorContext(err: unknown): Record<string, unknown> {
  const e = err as Error & ErrnoLike;
  return {
    message: e?.message,
    code: e?.code,
    syscall: e?.syscall,
    hostname: e?.hostname,
    cause: (e as { cause?: unknown })?.cause
      ? describeError((e as { cause?: unknown }).cause)
      : undefined,
    stack: e?.stack,
  };
}
