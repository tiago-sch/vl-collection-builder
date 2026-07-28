import { describe, expect, it } from 'vitest';
import { describeError } from '../src/util/errors.js';

/** How Node actually reports a transport failure: a wrapper plus a cause. */
const fetchFailure = (message: string, props: Record<string, unknown>): Error => {
  const err = new Error('fetch failed');
  (err as { cause?: unknown }).cause = Object.assign(new Error(message), props);
  return err;
};

describe('describeError', () => {
  it('unwraps the cause behind a bare "fetch failed"', () => {
    // This is the whole point: `fetch failed` alone tells an operator nothing,
    // and it is exactly what a download error used to record.
    const out = describeError(
      fetchFailure('getaddrinfo ENOTFOUND dl3.vimm.net', {
        code: 'ENOTFOUND',
        syscall: 'getaddrinfo',
        hostname: 'dl3.vimm.net',
      }),
    );
    expect(out).toContain('fetch failed');
    expect(out).toContain('ENOTFOUND');
    expect(out).toContain('dl3.vimm.net');
    expect(out).toMatch(/DNS lookup failed/);
  });

  it('explains the codes that actually show up on long transfers', () => {
    expect(describeError(fetchFailure('read ECONNRESET', { code: 'ECONNRESET' }))).toMatch(
      /reset by the peer/,
    );
    expect(
      describeError(fetchFailure('Body Timeout Error', { code: 'UND_ERR_BODY_TIMEOUT' })),
    ).toMatch(/stopped partway/);
  });

  it('handles a plain error without inventing detail', () => {
    expect(describeError(new Error('something ordinary'))).toBe('something ordinary');
  });

  it('describes filesystem failures, which read as cryptic codes otherwise', () => {
    const enospc = Object.assign(new Error('ENOSPC: no space left on device, write'), {
      code: 'ENOSPC',
    });
    expect(describeError(enospc)).toMatch(/no space left/);

    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    expect(describeError(eacces)).toMatch(/uid the container runs as/);
  });

  it('does not repeat an identical message twice down the chain', () => {
    const err = new Error('same');
    (err as { cause?: unknown }).cause = new Error('same');
    expect(describeError(err)).toBe('same');
  });

  it('stops rather than looping on a circular cause', () => {
    const a = new Error('a');
    const b = new Error('b');
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;
    expect(describeError(a).length).toBeLessThan(100);
  });
});
