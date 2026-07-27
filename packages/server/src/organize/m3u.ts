/**
 * Multi-disc handling (plan §9.4).
 *
 * The convention emulators expect is one folder per game containing each disc,
 * plus a plain-text `.m3u` listing the disc images in order. That is what lets
 * an emulator swap discs mid-game.
 *
 * Multi-disc sets are detectable because the catalogue titles carry the disc
 * marker, so this needs no guessing at file contents.
 *
 * Single-file games stay flat and multi-file games get their own subfolder —
 * mixing the two is what makes a library annoying to browse.
 */

/** Disc number from a No-Intro style title, or null for a single-disc game. */
export function discNumber(title: string): number | null {
  const m = /[([]\s*(?:disc|disk|cd)\s*(\d+)\s*[)\]]/i.exec(title);
  return m?.[1] ? Number.parseInt(m[1], 10) : null;
}

/** Title with the disc marker removed, used to group discs of one game. */
export function baseTitle(title: string): string {
  return title
    .replace(/[([]\s*(?:disc|disk|cd)\s*\d+\s*[)\]]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function isMultiDisc(titles: string[]): boolean {
  const discs = titles.map(discNumber).filter((d): d is number => d !== null);
  return discs.length > 1 || new Set(titles.map(baseTitle)).size < titles.length;
}

/**
 * Build an .m3u body.
 *
 * Plain relative filenames, one per line, in disc order. Emulators resolve them
 * against the playlist's own directory, so absolute paths would break the moment
 * the library moved.
 */
export function buildM3u(fileNames: string[]): string {
  return `${fileNames.join('\n')}\n`;
}

/** Sort disc files by disc number, falling back to name order. */
export function sortDiscs(fileNames: string[]): string[] {
  return [...fileNames].sort((a, b) => {
    const da = discNumber(a);
    const db = discNumber(b);
    if (da !== null && db !== null) return da - db;
    return a.localeCompare(b);
  });
}

/**
 * Which files belong in a playlist.
 *
 * After CHD conversion the m3u lists .chd files rather than .cue files, which is
 * why this looks at what is actually on disk rather than at the source format.
 */
export function playlistCandidates(fileNames: string[]): string[] {
  const chd = fileNames.filter((f) => /\.chd$/i.test(f));
  if (chd.length > 0) return sortDiscs(chd);
  const cue = fileNames.filter((f) => /\.(cue|gdi)$/i.test(f));
  if (cue.length > 0) return sortDiscs(cue);
  return sortDiscs(fileNames.filter((f) => /\.(iso|img)$/i.test(f)));
}
