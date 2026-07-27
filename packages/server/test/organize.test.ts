import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  discName,
  parseFolderMap,
  platformFolder,
  renderTemplate,
  sanitizeSegment,
  validateFolderMap,
} from '../src/organize/naming.js';
import { cueReferences, rewriteCcd, rewriteCue, rewriteGdi } from '../src/organize/cue.js';
import {
  extractZip,
  isSafeEntryPath,
  shouldExtract,
  UnsafeArchiveError,
} from '../src/organize/extract.js';
import { baseTitle, buildM3u, discNumber, playlistCandidates, sortDiscs } from '../src/organize/m3u.js';
import { chdCommandFor, shouldConvert } from '../src/organize/chd.js';
import { isSafeWorkDir } from '../src/organize/pipeline.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'vault-org-test-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('naming', () => {
  const ctx = {
    title: 'Silent Hill 2',
    region: 'USA',
    version: '2.01',
    platform: 'ps2',
    vaultId: 9250,
    disc: null,
  };

  it('renders the No-Intro style default', () => {
    expect(renderTemplate('{title} ({region})', ctx)).toBe('Silent Hill 2 (USA)');
  });

  it('supports every documented token', () => {
    expect(renderTemplate('{title} ({region}) ({version}) [{platform}] [{vaultId}]', ctx)).toBe(
      'Silent Hill 2 (USA) (2.01) [ps2] [9250]',
    );
  });

  it('drops bracket groups left empty by a missing token', () => {
    // A game with no region must not become 'Okami ()'.
    expect(
      renderTemplate('{title} ({region})', { ...ctx, title: 'Okami', region: null }),
    ).toBe('Okami');
  });

  it('replaces illegal characters rather than stripping them', () => {
    // 'Ratchet & Clank: Up Your Arsenal' must stay readable.
    expect(sanitizeSegment('Ratchet & Clank: Up Your Arsenal')).toBe(
      'Ratchet & Clank - Up Your Arsenal',
    );
    expect(sanitizeSegment('Where/When?')).toBe('Where-When');
  });

  it('avoids names Windows silently mangles', () => {
    // A trailing dot is legal on POSIX and dropped on Windows, which makes a
    // library non-portable in a way that is hard to notice.
    expect(sanitizeSegment('Game.')).toBe('Game');
    expect(sanitizeSegment('Game ')).toBe('Game');
    expect(sanitizeSegment('con')).toBe('_con');
  });

  it('names discs consistently', () => {
    expect(discName('Final Fantasy VII (USA)', 2)).toBe('Final Fantasy VII (USA) (Disc 2)');
  });
});

describe('platform folder style', () => {
  const registry = {
    folderStyles: {
      slug: {},
      esde: { ngc: 'gc', dc: 'dreamcast' },
      batocera: { ngc: 'gamecube', dc: 'dreamcast', genesis: 'megadrive' },
    },
  };

  it('defaults to the raw slug', () => {
    expect(platformFolder('ps2', 'slug', {}, registry)).toEqual({ folder: 'ps2', source: 'slug' });
  });

  it('applies a preset', () => {
    expect(platformFolder('ngc', 'esde', {}, registry).folder).toBe('gc');
    expect(platformFolder('genesis', 'batocera', {}, registry).folder).toBe('megadrive');
  });

  it('lets an explicit map override the preset', () => {
    const map = parseFolderMap('genesis=megadrive,xbox=microsoft-xbox');
    expect(platformFolder('xbox', 'esde', map, registry)).toEqual({
      folder: 'microsoft-xbox',
      source: 'map',
    });
  });

  it('warns about an unknown slug instead of silently mis-filing games', () => {
    // 'gamecube=gc' is the classic typo — our slug is 'ngc'.
    const warnings = validateFolderMap(parseFolderMap('gamecube=gc'), ['ngc', 'ps2', 'snes']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not a known platform slug/);
  });
});

describe('cue rewriting — the silent library corrupter', () => {
  it('rewrites FILE references to match renamed bins', () => {
    // Without this the cue points at a file that no longer exists: nothing
    // errors, and the game simply will not boot.
    const cue = 'FILE "Track 01.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n';
    const out = rewriteCue(cue, { 'Track 01.bin': 'Silent Hill (USA).bin' });
    expect(out).toContain('FILE "Silent Hill (USA).bin" BINARY');
    // Track and index lines must be untouched.
    expect(out).toContain('TRACK 01 MODE2/2352');
    expect(out).toContain('INDEX 01 00:00:00');
  });

  it('handles unquoted filenames', () => {
    const out = rewriteCue('FILE game.bin BINARY\n', { 'game.bin': 'New Name.bin' });
    expect(out).toContain('FILE "New Name.bin" BINARY');
  });

  it('rewrites every track of a multi-track set', () => {
    const cue = [
      'FILE "a.bin" BINARY',
      '  TRACK 01 MODE1/2352',
      'FILE "b.bin" BINARY',
      '  TRACK 02 AUDIO',
      '',
    ].join('\n');
    const out = rewriteCue(cue, { 'a.bin': 'X (Track 1).bin', 'b.bin': 'X (Track 2).bin' });
    expect(cueReferences(out)).toEqual(['X (Track 1).bin', 'X (Track 2).bin']);
  });

  it('leaves references alone when there is no rename for them', () => {
    const cue = 'FILE "keep.bin" BINARY\n';
    expect(rewriteCue(cue, { 'other.bin': 'x.bin' })).toBe(cue);
  });

  it('rewrites gdi track lines but not the track count', () => {
    const gdi = '3\n1 0 4 2352 "track01.bin" 0\n2 600 0 2352 "track02.raw" 0\n';
    const out = rewriteGdi(gdi, { 'track01.bin': 'DC Game (Track 1).bin' });
    expect(out.split('\n')[0]).toBe('3');
    expect(out).toContain('"DC Game (Track 1).bin"');
    expect(out).toContain('"track02.raw"');
  });

  it('rewrites ccd sidecars', () => {
    const ccd = 'DataFile=old.img\nSubFile=old.sub\n';
    const out = rewriteCcd(ccd, { 'old.img': 'new.img', 'old.sub': 'new.sub' });
    expect(out).toContain('DataFile=new.img');
    expect(out).toContain('SubFile=new.sub');
  });
});

describe('zip-slip', () => {
  const root = '/library/.tmp/1';

  it('rejects traversal entries', () => {
    expect(isSafeEntryPath(root, '../../etc/passwd')).toBe(false);
    expect(isSafeEntryPath(root, 'a/../../../etc/passwd')).toBe(false);
    expect(isSafeEntryPath(root, '/etc/passwd')).toBe(false);
    expect(isSafeEntryPath(root, 'C:\\Windows\\System32')).toBe(false);
    expect(isSafeEntryPath(root, '..\\..\\evil.exe')).toBe(false);
  });

  it('accepts ordinary entries, including nested ones', () => {
    expect(isSafeEntryPath(root, 'game.bin')).toBe(true);
    expect(isSafeEntryPath(root, 'Disc 1/game.bin')).toBe(true);
  });

  it('rejects a real archive containing a traversal entry, without extracting it', async () => {
    const zipPath = join(dir, 'evil.zip');
    const staging = join(dir, 'evil-src');
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'innocent.txt'), 'hello');
    execFileSync('zip', ['-q', zipPath, 'innocent.txt'], { cwd: staging });

    // Patch the stored entry name to a traversal path. The replacement is
    // exactly the same length as the original, so every offset in the zip's
    // local header and central directory stays valid.
    const original = 'innocent.txt';
    const traversal = '../evil2.txt';
    expect(traversal).toHaveLength(original.length);
    const buf = readFileSync(zipPath);
    writeFileSync(
      zipPath,
      Buffer.from(buf.toString('binary').replaceAll(original, traversal), 'binary'),
    );

    const dest = join(dir, 'evil-out');
    // Two independent layers reject this: yauzl refuses the relative path when
    // reading the central directory, and our own isSafeEntryPath check (unit
    // tested above) refuses it before any byte is written. Either is fine — the
    // property under test is that the archive is refused and nothing lands.
    await expect(extractZip(zipPath, dest)).rejects.toThrow(
      /invalid relative path|would escape the extraction directory/,
    );
    // The archive is rejected whole: nothing is written, not even safe entries.
    expect(existsSync(join(dir, 'evil2.txt'))).toBe(false);
    expect(existsSync(join(dest, 'innocent.txt'))).toBe(false);
  });

  it('extracts a normal archive', async () => {
    const zipPath = join(dir, 'good.zip');
    const staging = join(dir, 'good-src');
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'Track 01.bin'), 'BINDATA');
    writeFileSync(join(staging, 'game.cue'), 'FILE "Track 01.bin" BINARY\n');
    execFileSync('zip', ['-q', '-r', zipPath, '.'], { cwd: staging });

    const dest = join(dir, 'good-out');
    const result = await extractZip(zipPath, dest);
    expect(result.files.length).toBe(2);
    expect(readFileSync(join(dest, 'Track 01.bin'), 'utf8')).toBe('BINDATA');
  });
});

describe('extract policy', () => {
  it('leaves cartridge systems zipped by default', () => {
    // RetroArch reads zipped ROMs natively; unzipping everything is the obvious
    // default and it is wrong.
    expect(shouldExtract('disc-only', false)).toBe(false);
    expect(shouldExtract('disc-only', true)).toBe(true);
  });

  it('honours the overrides', () => {
    expect(shouldExtract('always', false)).toBe(true);
    expect(shouldExtract('never', true)).toBe(false);
  });
});

describe('multi-disc and m3u', () => {
  it('reads the disc number from a title', () => {
    expect(discNumber('Final Fantasy VII (USA) (Disc 2)')).toBe(2);
    expect(discNumber('Metal Gear Solid (USA) [CD 1]')).toBe(1);
    expect(discNumber('Okami (USA)')).toBeNull();
  });

  it('groups discs of one game by base title', () => {
    expect(baseTitle('Final Fantasy VII (USA) (Disc 2)')).toBe('Final Fantasy VII (USA)');
  });

  it('sorts discs numerically, not lexically', () => {
    const sorted = sortDiscs([
      'X (Disc 10).chd',
      'X (Disc 2).chd',
      'X (Disc 1).chd',
    ]);
    expect(sorted).toEqual(['X (Disc 1).chd', 'X (Disc 2).chd', 'X (Disc 10).chd']);
  });

  it('lists chd files in the playlist once conversion has happened', () => {
    // After CHD conversion the m3u must reference .chd, not the .cue that is gone.
    expect(
      playlistCandidates(['X (Disc 1).chd', 'X (Disc 2).chd', 'X (Disc 1).cue']),
    ).toEqual(['X (Disc 1).chd', 'X (Disc 2).chd']);
  });

  it('builds a relative playlist', () => {
    // Absolute paths would break the moment the library moved.
    const body = buildM3u(['X (Disc 1).chd', 'X (Disc 2).chd']);
    expect(body).toBe('X (Disc 1).chd\nX (Disc 2).chd\n');
    expect(body).not.toContain('/');
  });
});

describe('chd', () => {
  it('picks createcd for track-based images and createdvd for ISOs', () => {
    expect(chdCommandFor('game.cue')).toBe('createcd');
    expect(chdCommandFor('game.gdi')).toBe('createcd');
    expect(chdCommandFor('game.iso')).toBe('createdvd');
    expect(chdCommandFor('game.sfc')).toBeNull();
  });

  it('only converts disc-based platforms, and never when disabled', () => {
    expect(shouldConvert('disc-only', true)).toBe(true);
    expect(shouldConvert('disc-only', false)).toBe(false);
    expect(shouldConvert('never', true)).toBe(false);
  });
});

describe('work directory safety', () => {
  // cleanWorkDir empties WORK_PATH on every boot. That is correct for a scratch
  // directory and catastrophic for anything else: one misconfigured
  // WORK_PATH=/library would erase a whole ROM library on the next restart.
  it('accepts a scratch subdirectory', () => {
    expect(isSafeWorkDir('/library/.tmp', '/library', '/downloads')).toBe(true);
    expect(isSafeWorkDir('/downloads/.work', '/library', '/downloads')).toBe(true);
    expect(isSafeWorkDir('/mnt/fast/scratch', '/library', '/downloads')).toBe(true);
  });

  it('refuses the library or downloads root itself', () => {
    expect(isSafeWorkDir('/library', '/library', '/downloads')).toBe(false);
    expect(isSafeWorkDir('/downloads', '/library', '/downloads')).toBe(false);
    // Trailing slash and relative forms must not sneak past.
    expect(isSafeWorkDir('/library/', '/library', '/downloads')).toBe(false);
  });

  it('refuses a parent of a protected root, which would take it along', () => {
    expect(isSafeWorkDir('/mnt/media', '/mnt/media/library', '/mnt/media/staging')).toBe(false);
  });

  it('refuses paths too close to the filesystem root', () => {
    expect(isSafeWorkDir('/', '/library', '/downloads')).toBe(false);
    expect(isSafeWorkDir('/tmp', '/library', '/downloads')).toBe(false);
  });
});
