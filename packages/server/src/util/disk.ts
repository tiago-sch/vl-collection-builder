/**
 * Free-space checks.
 *
 * `statfs` is available on Linux and macOS in Node 18.15+. Where it is not, we
 * return null and callers skip the precheck rather than refusing to run — a
 * missing check should not be a hard failure, but a silently skipped one should
 * be visible, so callers log it.
 */
import { statfs } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';

export async function freeDiskMb(path: string): Promise<number | null> {
  try {
    // The path must exist for statfs to report on the right filesystem.
    await mkdir(path, { recursive: true });
    const s = await statfs(path);
    return Math.floor((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
  } catch {
    return null;
  }
}

export async function isWritable(path: string): Promise<boolean> {
  const { access, constants } = await import('node:fs/promises');
  try {
    await mkdir(path, { recursive: true });
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
