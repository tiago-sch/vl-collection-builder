import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canResumeFrom,
  downloadHeaders,
  downloadUrl,
  fileNameFromDisposition,
  parseVaultPage,
  sanitizeFileName,
} from '../src/download/vimm.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const vaultPage = readFileSync(resolve(fixtures, 'vault-1001-snes.html'), 'utf8');

describe('parseVaultPage', () => {
  const page = parseVaultPage(vaultPage);

  it('finds the download host from the protocol-relative form action', () => {
    expect(page.downloadHost).toBe('https://dl3.vimm.net');
    expect(page.unavailable).toBe(false);
  });

  it('reads the embedded media JSON rather than just the form field', () => {
    expect(page.media).toHaveLength(1);
    expect(page.media[0]!.mediaId).toBe(983);
  });

  it('decodes the real filename from base64', () => {
    expect(page.media[0]!.fileName).toBe('3 Ninjas Kick Back (USA).sfc');
  });

  it('exposes checksums, which is what makes resume safe to trust', () => {
    const m = page.media[0]!;
    expect(m.md5).toBe('c638c1175840c6640d897951daa73637');
    expect(m.sha1).toBe('b619576a51a3968e243028a830a455d40cf92e78');
    expect(m.crc32).toBe('f2ee11f9');
  });

  it('gives an expected size up front, so the disk precheck needs no round trip', () => {
    // Zipped is in KB; the real Content-Length was 1,087,083.
    expect(page.media[0]!.expectedBytes).toBe(1062 * 1024);
    expect(page.media[0]!.expectedBytes).toBeGreaterThan(1_000_000);
  });

  it('carries the version and serial', () => {
    expect(page.media[0]!.version).toBe('1.0');
    expect(page.media[0]!.serial).toBe('SNS-A3NE-USA');
  });

  it('falls back to the form mediaId when the JSON is gone', () => {
    const noJson = vaultPage.replace(/let\s+media\s*=\s*\[[\s\S]*?\]\s*;/, 'let media=undefined;');
    const page2 = parseVaultPage(noJson);
    expect(page2.media).toHaveLength(1);
    expect(page2.media[0]!.mediaId).toBe(983);
    expect(page2.media[0]!.fileName).toBeNull();
    expect(page2.warnings.join(' ')).toMatch(/falling back to the form mediaId/);
  });

  it('sorts multi-disc media by SortOrder', () => {
    const multi = vaultPage.replace(
      /let\s+media\s*=\s*\[[\s\S]*?\]\s*;/,
      'let media=[{"ID":2,"SortOrder":2,"GoodTitle":"","Zipped":"10"},{"ID":1,"SortOrder":1,"GoodTitle":"","Zipped":"10"}];',
    );
    expect(parseVaultPage(multi).media.map((m) => m.mediaId)).toEqual([1, 2]);
  });

  it('does not crash on a page that is not a vault page', () => {
    const page3 = parseVaultPage('<html><body>nope</body></html>');
    expect(page3.media).toEqual([]);
    expect(page3.downloadHost).toBeNull();
  });
});

describe('request construction', () => {
  it('builds the GET url', () => {
    // The form markup says method="POST", but submitDL() rewrites it to GET
    // before submitting. Implementing the form as written does not work.
    expect(downloadUrl('https://dl3.vimm.net', 983)).toBe('https://dl3.vimm.net/?mediaId=983');
  });

  it('sends NO Range header at offset 0', () => {
    // The server returns the TAIL of the file for ranges starting at 0:
    //   Range: bytes=0-9 -> Content-Range: bytes 1087073-1087082/1087083
    // Sending one here would silently corrupt the download.
    const headers = downloadHeaders({
      referer: 'https://vimm.net/vault/1001',
      userAgent: 'x',
      offset: 0,
    });
    expect(headers.range).toBeUndefined();
    expect(canResumeFrom(0)).toBe(false);
  });

  it('sends a Range header when genuinely resuming', () => {
    const headers = downloadHeaders({
      referer: 'https://vimm.net/vault/1001',
      userAgent: 'x',
      offset: 4096,
    });
    expect(headers.range).toBe('bytes=4096-');
    expect(canResumeFrom(4096)).toBe(true);
  });

  it('always sends a Referer, which the host requires', () => {
    const headers = downloadHeaders({
      referer: 'https://vimm.net/vault/1001',
      userAgent: 'x',
      offset: 0,
    });
    expect(headers.referer).toBe('https://vimm.net/vault/1001');
  });
});

describe('filenames', () => {
  it('reads the real Content-Disposition the server sends', () => {
    expect(
      fileNameFromDisposition('attachment; filename="3 Ninjas Kick Back (USA).zip"'),
    ).toBe('3 Ninjas Kick Back (USA).zip');
  });

  it('handles the RFC 5987 form', () => {
    expect(fileNameFromDisposition("attachment; filename*=UTF-8''Okami%20(USA).zip")).toBe(
      'Okami (USA).zip',
    );
  });

  it('rejects traversal outright rather than repairing it', () => {
    // gamarr rejects unsafe names; a name needing repair is one we do not
    // understand, and guessing at intent is how files land outside the volume.
    expect(sanitizeFileName('../../etc/passwd')).toBeNull();
    expect(sanitizeFileName('..')).toBeNull();
    expect(sanitizeFileName('/etc/passwd')).toBeNull();
    expect(sanitizeFileName('sub\\dir.zip')).toBeNull();
    expect(fileNameFromDisposition('attachment; filename="../../evil.zip"')).toBeNull();
  });

  it('rejects control characters and NUL', () => {
    expect(sanitizeFileName('bad\u0000name.zip')).toBeNull();
    expect(sanitizeFileName('bad\u007fname.zip')).toBeNull();
    expect(sanitizeFileName('bad\nname.zip')).toBeNull();
  });

  it('keeps ordinary names with spaces, parentheses and dots', () => {
    expect(sanitizeFileName('Final Fantasy VII (USA) (Disc 1).bin')).toBe(
      'Final Fantasy VII (USA) (Disc 1).bin',
    );
  });

  it('returns null for missing or unparseable headers', () => {
    expect(fileNameFromDisposition(null)).toBeNull();
    expect(fileNameFromDisposition('attachment')).toBeNull();
  });
});
