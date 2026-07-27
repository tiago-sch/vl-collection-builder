/**
 * Rewriting disc-image sidecar files (plan §9.4).
 *
 * A `.cue` references its `.bin` files **by name**. Rename `Track 01.bin` to
 * match your template and the cue silently points at a file that no longer
 * exists: nothing errors at extract time, nothing errors at scan time, and the
 * game simply refuses to boot. The plan calls this the single most common way
 * homemade organizers corrupt a library, and it is why every rename here is
 * paired with a rewrite.
 *
 * `.gdi` (Dreamcast) and `.ccd`/`.sub` sets have the same problem in a different
 * syntax, so they are handled too.
 */

/** A rename that has to be reflected inside sidecar files. */
export interface RenameMap {
  /** old basename -> new basename */
  [oldName: string]: string;
}

/**
 * Rewrite the FILE lines of a cue sheet.
 *
 * Cue syntax is `FILE "name.bin" BINARY`, with the quotes optional when the name
 * has no spaces. Only the filename is touched; track and index lines are left
 * exactly as they are, because we have no business reinterpreting them.
 */
export function rewriteCue(content: string, renames: RenameMap): string {
  return content.replace(
    /^(\s*FILE\s+)(?:"([^"]+)"|(\S+))(\s+\w+\s*)$/gim,
    (match, prefix: string, quoted: string | undefined, bare: string | undefined, suffix: string) => {
      const original = quoted ?? bare ?? '';
      const replacement = renames[original] ?? renames[basename(original)];
      if (!replacement) return match;
      // Always re-quote: names produced by our templates contain spaces.
      return `${prefix}"${replacement}"${suffix}`;
    },
  );
}

/**
 * Rewrite a GDI track list.
 *
 * Lines are `<track> <lba> <type> <sectorSize> <filename> <offset>`, with the
 * filename optionally quoted.
 */
export function rewriteGdi(content: string, renames: RenameMap): string {
  const lines = content.split(/\r?\n/);
  return lines
    .map((line, index) => {
      // The first line is the track count, not a track.
      if (index === 0 || !line.trim()) return line;
      return line.replace(/"([^"]+)"|(\S+\.(?:bin|raw|iso))/i, (match, quoted, bare) => {
        const original = (quoted ?? bare ?? '') as string;
        const replacement = renames[original] ?? renames[basename(original)];
        if (!replacement) return match;
        return `"${replacement}"`;
      });
    })
    .join('\n');
}

/** CCD sidecars reference an IMG/SUB pair by name in `[CloneCD]`-style keys. */
export function rewriteCcd(content: string, renames: RenameMap): string {
  return content.replace(/^(\s*(?:DataFile|SubFile)\s*=\s*)(.+)$/gim, (match, prefix: string, name: string) => {
    const trimmed = name.trim();
    const replacement = renames[trimmed] ?? renames[basename(trimmed)];
    return replacement ? `${prefix}${replacement}` : match;
  });
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] ?? p;
}

/** Which files a cue sheet points at, so we can check they all exist. */
export function cueReferences(content: string): string[] {
  const out: string[] = [];
  const re = /^\s*FILE\s+(?:"([^"]+)"|(\S+))\s+\w+\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const name = m[1] ?? m[2];
    if (name) out.push(name);
  }
  return out;
}

export function isSidecar(fileName: string): boolean {
  return /\.(cue|gdi|ccd)$/i.test(fileName);
}

/** Apply the right rewriter for the sidecar's type. */
export function rewriteSidecar(fileName: string, content: string, renames: RenameMap): string {
  if (/\.cue$/i.test(fileName)) return rewriteCue(content, renames);
  if (/\.gdi$/i.test(fileName)) return rewriteGdi(content, renames);
  if (/\.ccd$/i.test(fileName)) return rewriteCcd(content, renames);
  return content;
}
