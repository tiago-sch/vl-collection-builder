/**
 * Everything this project assumes about Vimm's *download* flow, isolated the
 * same way catalog/parser.ts isolates the listing markup (plan §8.1). Both are
 * equally exposed to site changes; keeping each in one file with fixtures means
 * a breakage is one file plus its test to fix.
 *
 * ## How a download actually works
 *
 * The vault page carries a form:
 *
 *     <form action="//dl3.vimm.net/" method="POST" id="dl_form"
 *           onsubmit="return submitDL(this, 'dialog3')">
 *       <input type="hidden" name="mediaId" value="983">
 *
 * ...but `submitDL` sets `theForm.method='GET'` before submitting. **The real
 * request is a GET**, despite the markup declaring POST. Implementing the form
 * as written does not work.
 *
 * The page also embeds a JSON media array that is far richer than the form:
 *
 *     let media=[{"ID":983,"GoodTitle":"<base64 filename>","Zipped":"1062",
 *                 "GoodMd5":"...","GoodSha1":"...","GoodHash":"<crc32>",
 *                 "SortOrder":1,"Version":"1.0", ...}];
 *
 * That gives us the real filename, the expected size *before* requesting
 * anything (so the free-disk precheck needs no extra round trip), per-disc
 * entries for multi-disc releases, and — most valuably — MD5/SHA1/CRC32.
 * Verifying against those is much stronger than the byte-count check the plan
 * specified, since it catches corruption as well as truncation.
 *
 * ## Two things that bite
 *
 * **1. The download host rejects non-browser User-Agents.** Our honest crawler
 * UA gets `400 Bad Request` with "Your browser is acting funny", even with a
 * complete set of standard headers — the UA itself is the trigger. Catalogue
 * crawling works fine with the honest UA and keeps using it; only this endpoint
 * needs a browser UA, which plan §1.1 anticipated as the documented fallback.
 * It is a separate, overridable setting so the choice stays visible.
 *
 * **2. Range requests starting at offset 0 return the WRONG BYTES.** Verified
 * against the live server:
 *
 *     Range: bytes=100-109  ->  Content-Range: bytes 100-109/1087083     correct
 *     Range: bytes=0-9      ->  Content-Range: bytes 1087073-1087082/... the LAST 10
 *
 * A resume implementation that sends `Range: bytes=0-` for a fresh or empty
 * `.part` would silently write the tail of the file into the head and produce a
 * corrupt archive with no error. So: never send a Range header at offset 0, and
 * always verify the finished file against the published checksum.
 */
import * as cheerio from 'cheerio';

/** One downloadable item — a game, or one disc of a multi-disc release. */
export interface MediaEntry {
  mediaId: number;
  /** Real filename, decoded from the base64 GoodTitle field. */
  fileName: string | null;
  /** Expected download size in bytes, derived from the KB-valued Zipped field. */
  expectedBytes: number | null;
  md5: string | null;
  sha1: string | null;
  crc32: string | null;
  version: string | null;
  serial: string | null;
  /** 1-based disc index for multi-disc releases. */
  sortOrder: number;
}

export interface VaultPage {
  /** Absolute origin of the download host, e.g. https://dl3.vimm.net */
  downloadHost: string | null;
  media: MediaEntry[];
  /** True when the page says the download is unavailable. */
  unavailable: boolean;
  warnings: string[];
}

/**
 * A browser User-Agent, required by the download host only.
 *
 * Not a default we reached for casually: the honest UA is used everywhere else
 * and is what the catalogue crawl runs on. This endpoint returns 400 without a
 * browser UA, which is the documented condition under which plan §1.1 permits
 * this fallback. Override with DOWNLOAD_USER_AGENT.
 */
export const DEFAULT_DOWNLOAD_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function decodeBase64(value: string): string | null {
  try {
    const out = Buffer.from(value, 'base64').toString('utf8');
    return out.trim() ? out : null;
  } catch {
    return null;
  }
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Parse a vault game page into everything needed to download it. */
export function parseVaultPage(html: string): VaultPage {
  const warnings: string[] = [];
  const $ = cheerio.load(html);

  // --- download host, from the form action ---------------------------------
  let downloadHost: string | null = null;
  const action = $('form#dl_form').attr('action') ?? '';
  if (action) {
    // Protocol-relative: //dl3.vimm.net/
    const normalized = action.startsWith('//') ? `https:${action}` : action;
    try {
      downloadHost = new URL(normalized, 'https://vimm.net').origin;
    } catch {
      warnings.push(`could not parse download form action '${action}'`);
    }
  }

  const unavailable = /download\s+unavailable/i.test($('body').text()) && downloadHost === null;

  // --- media array, from the inline script ---------------------------------
  const media: MediaEntry[] = [];
  const scriptMatch = /let\s+media\s*=\s*(\[[\s\S]*?\])\s*;/.exec(html);

  if (scriptMatch?.[1]) {
    try {
      const parsed = JSON.parse(scriptMatch[1]) as unknown;
      if (Array.isArray(parsed)) {
        for (const raw of parsed) {
          if (typeof raw !== 'object' || raw === null) continue;
          const m = raw as Record<string, unknown>;
          const mediaId = num(m.ID);
          if (mediaId === null) continue;

          const goodTitle = str(m.GoodTitle);
          // `Zipped` is in KB; the site's own ZippedText renders it as MB.
          const zippedKb = num(m.Zipped);

          media.push({
            mediaId,
            fileName: goodTitle ? decodeBase64(goodTitle) : null,
            expectedBytes: zippedKb !== null && zippedKb > 0 ? zippedKb * 1024 : null,
            md5: str(m.GoodMd5)?.toLowerCase() ?? null,
            sha1: str(m.GoodSha1)?.toLowerCase() ?? null,
            crc32: str(m.GoodHash)?.toLowerCase() ?? null,
            version: str(m.Version),
            serial: str(m.Serial),
            sortOrder: num(m.SortOrder) ?? 1,
          });
        }
      }
    } catch (err) {
      warnings.push(`could not parse the embedded media JSON: ${(err as Error).message}`);
    }
  }

  // Fall back to the form's hidden mediaId. Loses the filename, size and
  // checksums, so the download still works but is verified only by byte count.
  if (media.length === 0) {
    const formMediaId = num($('form#dl_form input[name="mediaId"]').attr('value'));
    if (formMediaId !== null) {
      media.push({
        mediaId: formMediaId,
        fileName: null,
        expectedBytes: null,
        md5: null,
        sha1: null,
        crc32: null,
        version: null,
        serial: null,
        sortOrder: 1,
      });
      warnings.push(
        'embedded media JSON not found — falling back to the form mediaId; filename and checksums are unavailable',
      );
    }
  }

  media.sort((a, b) => a.sortOrder - b.sortOrder);

  return { downloadHost, media, unavailable, warnings };
}

/** The GET URL for one media item. */
export function downloadUrl(host: string, mediaId: number): string {
  return `${host}/?mediaId=${encodeURIComponent(String(mediaId))}`;
}

/**
 * Headers for a download request.
 *
 * `offset` of 0 deliberately produces NO Range header — see the module comment;
 * the server returns the tail of the file for ranges beginning at 0.
 */
export function downloadHeaders(opts: {
  referer: string;
  userAgent: string;
  offset: number;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': opts.userAgent,
    referer: opts.referer,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
  };
  if (opts.offset > 0) headers.range = `bytes=${opts.offset}-`;
  return headers;
}

/** Should a partially downloaded file be resumed from `offset`? */
export function canResumeFrom(offset: number): boolean {
  return offset > 0;
}

/**
 * Filename from Content-Disposition, sanitised.
 *
 * gamarr rejects unsafe names outright rather than trying to repair them and we
 * do the same: a name that needs repairing is a name we do not understand.
 */
export function fileNameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition);
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(disposition);
  const raw = star?.[1] ?? plain?.[1] ?? plain?.[2];
  if (!raw) return null;
  let name = raw.trim();
  try {
    name = decodeURIComponent(name);
  } catch {
    /* not percent-encoded */
  }
  return sanitizeFileName(name);
}

/** Reject anything that could escape the destination directory. */
export function sanitizeFileName(name: string): string | null {
  const trimmed = name.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return null;
  // No separators, no traversal, no absolute paths, no control characters, no
  // NUL. A legitimate Content-Disposition filename contains none of these.
  if (/[/\\]/.test(trimmed)) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  // Control characters and DEL, written as escapes so the source stays plain
  // ASCII — a literal NUL in a regex literal is too easy to mangle in transit.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (trimmed.length > 255) return null;
  return trimmed;
}
