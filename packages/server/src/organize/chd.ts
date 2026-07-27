/**
 * CHD conversion via chdman (plan §9.5b).
 *
 * `chdman` packs .bin/.cue and .iso into a single compressed .chd, typically
 * 40-60% smaller with no data loss, read natively by the major disc emulators.
 * For a PS2 or PS1 library that is the difference between 400 GB and roughly 200.
 *
 * It also makes most of §9.4 disappear: a .chd is ONE file, so there are no .bin
 * references to rewrite and no multi-file subfolder to manage. The cue-rewriting
 * code still ships — it is needed for anything CHD cannot take, and for
 * CHD_POLICY=never — but the default path stops depending on it.
 *
 * **Verify before discarding.** `chdman verify` runs on the output and the
 * source is deleted only if it passes. An unverified conversion that silently
 * truncated is worse than no conversion, because you find out years later when
 * the disc you wanted to play does not boot.
 */
import { execFile } from 'node:child_process';
import { stat, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type ChdPolicy = 'disc-only' | 'never';

export interface ChdResult {
  ok: boolean;
  outputPath: string | null;
  /** Set when conversion was skipped or failed; the caller falls back. */
  reason: string | null;
  sourceBytes: number;
  outputBytes: number;
}

let available: boolean | null = null;

/**
 * Is chdman on PATH? Cached — the answer cannot change within a process.
 *
 * Exit status is NOT a usable signal here. chdman 0.251 exits 1 for `--version`,
 * for `help`, and for a bare invocation, while still printing its banner:
 *
 *     chdman - MAME Compressed Hunks of Data (CHD) manager 0.251
 *     Usage: ...
 *
 * Probing on exit code alone reports "not installed" for a perfectly good
 * binary, which silently disables CHD conversion — the feature that halves the
 * size of a disc library. So we look at the output instead, and only treat
 * "the command could not be run at all" as unavailable.
 */
export async function chdmanAvailable(): Promise<boolean> {
  if (available !== null) return available;

  const looksLikeChdman = (text: string): boolean => /chdman|compressed hunks/i.test(text);

  try {
    const { stdout, stderr } = await run('chdman', ['--version'], { timeout: 10_000 });
    available = looksLikeChdman(`${stdout}${stderr}`);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: string };
    if (e.code === 'ENOENT') {
      available = false;
    } else {
      // Ran, but exited non-zero: judge it by what it printed.
      available = looksLikeChdman(`${e.stdout ?? ''}${e.stderr ?? ''}`);
    }
  }
  return available;
}

export function resetChdmanCache(): void {
  available = null;
}

/** Which chdman subcommand suits this image. */
export function chdCommandFor(inputPath: string): 'createcd' | 'createdvd' | null {
  if (/\.(cue|gdi|toc)$/i.test(inputPath)) return 'createcd';
  // DVD-based systems (PS2, GameCube, Wii) ship a single large ISO.
  if (/\.(iso|img)$/i.test(inputPath)) return 'createdvd';
  return null;
}

export function shouldConvert(policy: ChdPolicy, discBased: boolean): boolean {
  return policy === 'disc-only' && discBased;
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Convert one image to CHD.
 *
 * Runs inside the caller's temp directory, so a failed conversion never leaves a
 * half-written .chd in the library. CPU-bound and slow — minutes per disc — and
 * deliberately part of the same serial pipeline, so it never competes with a
 * download for bandwidth or with itself for cores.
 */
export async function convertToChd(
  inputPath: string,
  outputPath: string,
  opts: { keepSource?: boolean; timeoutMs?: number } = {},
): Promise<ChdResult> {
  const sourceBytes = await sizeOf(inputPath);

  if (!(await chdmanAvailable())) {
    return {
      ok: false,
      outputPath: null,
      reason: 'chdman is not installed in this image',
      sourceBytes,
      outputBytes: 0,
    };
  }

  const command = chdCommandFor(inputPath);
  if (!command) {
    return {
      ok: false,
      outputPath: null,
      reason: `no chdman command handles ${inputPath.split('.').pop()}`,
      sourceBytes,
      outputBytes: 0,
    };
  }

  try {
    await run('chdman', [command, '-i', inputPath, '-o', outputPath, '-f'], {
      timeout: opts.timeoutMs ?? 0,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    await unlink(outputPath).catch(() => undefined);
    return {
      ok: false,
      outputPath: null,
      reason: `chdman ${command} failed: ${(err as Error).message.split('\n')[0]}`,
      sourceBytes,
      outputBytes: 0,
    };
  }

  // Verify BEFORE anything is deleted.
  try {
    await run('chdman', ['verify', '-i', outputPath], {
      timeout: opts.timeoutMs ?? 0,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    await unlink(outputPath).catch(() => undefined);
    return {
      ok: false,
      outputPath: null,
      reason: `chdman verify failed, source kept: ${(err as Error).message.split('\n')[0]}`,
      sourceBytes,
      outputBytes: 0,
    };
  }

  const outputBytes = await sizeOf(outputPath);
  return { ok: true, outputPath, reason: null, sourceBytes, outputBytes };
}
