/**
 * End-to-end organize pipeline against real archives on disk.
 *
 * The unit tests cover each stage; this covers the thing that only shows up when
 * they run together — most importantly that a multi-track disc survives renaming
 * with its cue still pointing at files that exist.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cueReferences } from '../src/organize/cue.js';

let dir: string;
let organize: typeof import('../src/organize/pipeline.js').organize;

const PSX = { slug: 'psx', system: 'PS1', label: 'PlayStation', discBased: true };
const SNES = { slug: 'snes', system: 'SNES', label: 'Super Nintendo', discBased: false };

function makeZip(name: string, files: Record<string, string>): string {
  const staging = join(dir, `src-${name}`);
  mkdirSync(staging, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(staging, file)), { recursive: true });
    writeFileSync(join(staging, file), content);
  }
  const zipPath = join(dir, 'dl', `${name}.zip`);
  mkdirSync(dirname(zipPath), { recursive: true });
  execFileSync('zip', ['-q', '-r', zipPath, '.'], { cwd: staging });
  return zipPath;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vault-pipe-test-'));
  process.env.LIBRARY_PATH = join(dir, 'lib');
  process.env.DOWNLOADS_PATH = join(dir, 'dl');
  process.env.NAMING_TEMPLATE = '{title} ({region})';
  process.env.EXTRACT_POLICY = 'disc-only';
  process.env.CHD_POLICY = 'never'; // exercise the cue-rewriting path
  process.env.KEEP_ARCHIVE = 'true';
  process.env.ORGANIZE_MIN_FREE_DISK_MB = '0';
  ({ organize } = await import('../src/organize/pipeline.js'));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('multi-track disc images', () => {
  it('gives each track a distinct name and keeps the cue pointing at real files', async () => {
    // The regression this locks down: a CD rip is `Track 01.bin` + `Track 02.bin`
    // + one `.cue`. Treating "several files" as "several discs" named both bins
    // after the game, so the second silently overwrote the first — two tracks
    // became one file and the cue referenced it twice. Multi-TRACK is not
    // multi-DISC.
    const zip = makeZip('ff7', {
      'Track 01.bin': 'TRACK1DATA',
      'Track 02.bin': 'TRACK2DATA',
      'game.cue':
        'FILE "Track 01.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n' +
        'FILE "Track 02.bin" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n',
    });

    const result = await organize({
      downloadId: 1,
      gameId: null,
      platform: PSX,
      archivePath: zip,
      title: 'Final Fantasy VII',
      region: 'USA',
      version: '1.1',
      vaultId: 1234,
      disc: null,
    });

    const names = result.files.map((f) => f.relPath.split('/').pop()!).sort();
    expect(names).toEqual([
      'Final Fantasy VII (USA) (Track 1).bin',
      'Final Fantasy VII (USA) (Track 2).bin',
      'Final Fantasy VII (USA).cue',
    ]);

    // Both bins survived with their own contents — nothing was overwritten.
    const bin1 = result.files.find((f) => f.relPath.includes('(Track 1).bin'))!;
    const bin2 = result.files.find((f) => f.relPath.includes('(Track 2).bin'))!;
    expect(readFileSync(join(result.destDir, bin1.relPath.split('/').pop()!), 'utf8')).toBe('TRACK1DATA');
    expect(readFileSync(join(result.destDir, bin2.relPath.split('/').pop()!), 'utf8')).toBe('TRACK2DATA');

    // Every cue reference resolves. This is the check that would have caught the
    // bug: the game boots or it does not, and nothing errors at extract time.
    const cuePath = join(result.destDir, 'Final Fantasy VII (USA).cue');
    for (const ref of cueReferences(readFileSync(cuePath, 'utf8'))) {
      expect(existsSync(join(result.destDir, ref))).toBe(true);
    }
  });

  it('puts a multi-file game in its own subfolder', async () => {
    const listing = readdirSync(join(dir, 'lib', 'psx'));
    expect(listing).toContain('Final Fantasy VII (USA)');
  });
});

describe('single-file games', () => {
  it('stays flat rather than making a folder per game', async () => {
    // Mixing flat files and per-game folders is what makes a library annoying
    // to browse, so single-file games are not given a subfolder.
    const zip = makeZip('okami', { 'Okami.iso': 'ISODATA' });

    const result = await organize({
      downloadId: 2,
      gameId: null,
      platform: PSX,
      archivePath: zip,
      title: 'Okami',
      region: 'USA',
      version: '1.01',
      vaultId: 8993,
      disc: null,
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.relPath).toBe('psx/Okami (USA).iso');
    expect(result.files[0]!.kind).toBe('iso');
  });
});

describe('cartridge systems', () => {
  it('is left zipped and only renamed', async () => {
    // RetroArch reads zipped ROMs natively, so a zipped SNES library is a
    // fraction of the size and works identically (plan §9.3).
    const zip = makeZip('chrono', { 'Chrono Trigger (USA).sfc': 'ROMDATA' });

    const result = await organize({
      downloadId: 3,
      gameId: null,
      platform: SNES,
      archivePath: zip,
      title: 'Chrono Trigger',
      region: 'USA',
      version: '1.0',
      vaultId: 1234,
      disc: null,
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.relPath).toBe('snes/Chrono Trigger (USA).zip');
    expect(result.files[0]!.kind).toBe('archive');
  });
});

describe('staging', () => {
  it('keeps the archive when KEEP_ARCHIVE is set, so re-organizing is free', () => {
    expect(existsSync(join(dir, 'dl', 'okami.zip'))).toBe(true);
  });
});
