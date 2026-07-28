import { useEffect, useMemo, useState } from 'react';
import { TIER_LABELS, type Game, type LibraryFile, type ResolvedTier } from '@vl-collection-builder/shared';
import { api, type ExtractState } from '../api/client.js';

export function Library() {
  const [games, setGames] = useState<Game[]>([]);
  const [filter, setFilter] = useState('');
  const [platform, setPlatform] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [files, setFiles] = useState<(LibraryFile & { extractable: boolean })[]>([]);
  const [extract, setExtract] = useState<ExtractState | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [fileFilter, setFileFilter] = useState<'all' | 'on-disk' | 'zipped' | 'missing'>('all');

  const load = (): void => {
    void api
      .games()
      .then((r) => setGames(r.games))
      .catch((e) => setError((e as Error).message));
  };

  useEffect(load, []);

  const filesFor = (gameId: number): (LibraryFile & { extractable: boolean })[] =>
    files.filter((f) => f.gameId === gameId);

  const loadFiles = (): void => {
    void api
      .libraryFiles()
      .then((r) => setFiles(r.files))
      .catch(() => setFiles([]));
  };

  /** Archives among the current selection — what "unzip" would act on. */
  const selectedArchives = useMemo(
    () => files.filter((f) => f.extractable && f.gameId !== null && selected.has(f.gameId)),
    [files, selected],
  );

  useEffect(loadFiles, []);

  const runExtract = async (): Promise<void> => {
    try {
      const r = await api.extractFiles({ fileIds: selectedArchives.map((f) => f.id) });
      setExtract(r.state);
      setNotice(`Extracting ${r.queued} archive${r.queued === 1 ? '' : 's'}…`);
      setSelected(new Set());
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Poll only while a job is actually running.
  useEffect(() => {
    // Only after a job has actually been started. Polling on mount produced a
    // spurious "Extracted 0." the moment the page loaded.
    if (!extract) return;
    if (!extract.running && extract.queued === 0) return;
    const t = setInterval(() => {
      void api.extractStatus().then((s) => {
        setExtract(s);
        if (!s.running && s.queued === 0) {
          clearInterval(t);
          loadFiles();
          load();
          if (s.done > 0 || s.failed > 0) {
            setNotice(`Extracted ${s.done}${s.failed ? `, ${s.failed} failed` : ''}.`);
          }
        }
      });
    }, 1000);
    return () => clearInterval(t);
  }, [extract?.running, extract?.queued]);

  const platforms = useMemo(() => [...new Set(games.map((g) => g.platform))].sort(), [games]);

  const withFiles = useMemo(
    () => new Set(files.map((f) => f.gameId).filter((id): id is number => id !== null)),
    [files],
  );

  /** Games whose files include an archive that could still be extracted. */
  const zipped = useMemo(
    () =>
      new Set(
        files
          .filter((f) => f.extractable && f.gameId !== null)
          .map((f) => f.gameId as number),
      ),
    [files],
  );

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return games.filter((g) => {
      if (platform && g.platform !== platform) return false;
      if (q && !g.name.toLowerCase().includes(q) && !(g.inputName ?? '').toLowerCase().includes(q)) {
        return false;
      }
      // "Missing" is the useful one: matched and saved, but nothing organized on
      // disk — either never downloaded, or the files were moved or pruned.
      if (fileFilter === 'on-disk') return withFiles.has(g.id);
      if (fileFilter === 'missing') return !withFiles.has(g.id);
      if (fileFilter === 'zipped') return zipped.has(g.id);
      return true;
    });
  }, [games, filter, platform, fileFilter, withFiles, zipped]);

  const missingCount = useMemo(
    () => games.filter((g) => !withFiles.has(g.id)).length,
    [games, withFiles],
  );


  const toggle = (id: number): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // The queue is fed FROM the catalogue, which is the point of having built
  // matching first: these are verified vault URLs, not guesses.
  const enqueue = async (): Promise<void> => {
    try {
      const r = await api.enqueueDownloads({ gameIds: [...selected] });
      const parts = [`${r.queued.length} queued`];
      if (r.duplicates.length) parts.push(`${r.duplicates.length} already in the queue`);
      if (r.errors.length) parts.push(r.errors.join('; '));
      setNotice(parts.join(' · '));
      setSelected(new Set());
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (id: number): Promise<void> => {
    try {
      await api.deleteGame(id);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const exportUrl = (format: 'json' | 'csv' | 'minimal'): string => {
    const p = platform ? `platform=${platform}&` : '';
    if (format === 'csv') return `/api/games?${p}format=csv`;
    if (format === 'minimal') return `/api/games?${p}minimal=true`;
    return `/api/games?${p}`;
  };

  return (
    <>
      <h1>Library</h1>
      <p className="sub">{games.length} saved game{games.length === 1 ? '' : 's'}.</p>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}
      {extract && (extract.running || extract.queued > 0) && (
        <div className="banner info">
          Extracting {extract.current ?? '…'} — {extract.done} done
          {extract.queued > 0 && `, ${extract.queued} queued`}
          {extract.failed > 0 && `, ${extract.failed} failed`}
        </div>
      )}
      {extract?.errors.map((e) => (
        <div className="banner error" key={e.file}>
          {e.file}: {e.error}
        </div>
      ))}

      <div className="panel toolbar">
        <input
          className="toolbar-search"
          type="text"
          placeholder="Filter by name…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select
          value={fileFilter}
          onChange={(e) => setFileFilter(e.target.value as typeof fileFilter)}
          title="Filter by what is actually on disk"
        >
          <option value="all">All games ({games.length})</option>
          <option value="on-disk">On disk ({games.length - missingCount})</option>
          <option value="zipped">Still zipped ({zipped.size})</option>
          <option value="missing">No files ({missingCount})</option>
        </select>
        <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="">All platforms</option>
          {platforms.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        <div className="toolbar-spacer" />

        <div className="btn-group">
          <a className="btn" href={exportUrl('minimal')} target="_blank" rel="noreferrer">
            Export JSON
          </a>
          <a className="btn" href={exportUrl('csv')}>
            Export CSV
          </a>
        </div>
      </div>

      {/*
        A contextual bar rather than permanently-disabled buttons: actions that
        need a selection only appear once there is one, and they say what they
        will act on.
      */}
      {selected.size > 0 && (
        <div className="panel selection-bar">
          <strong>{selected.size} selected</strong>
          <button className="primary" onClick={() => void enqueue()}>
            Add to downloads
          </button>
          {selectedArchives.length > 0 && (
            <button
              onClick={() => void runExtract()}
              title="Extract in place, applying the naming template"
            >
              Unzip {selectedArchives.length}
            </button>
          )}
          <div className="toolbar-spacer" />
          <button onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {selected.size === 0 && shown.length > 0 && (fileFilter === 'zipped' || fileFilter === 'missing') && (
        <div className="panel selection-bar">
          <span className="muted">
            {fileFilter === 'zipped'
              ? `${shown.length} game${shown.length === 1 ? '' : 's'} still zipped`
              : `${shown.length} game${shown.length === 1 ? '' : 's'} with no files on disk`}
          </span>
          <button onClick={() => setSelected(new Set(shown.map((g) => g.id)))}>
            Select all {shown.length}
          </button>
        </div>
      )}

      <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 30 }}>
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={shown.length > 0 && shown.every((g) => selected.has(g.id))}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(shown.map((g) => g.id)) : new Set())
                  }
                  style={{ width: 'auto' }}
                />
              </th>
              <th>Name</th>
              <th style={{ width: 90 }}>Platform</th>
              <th style={{ width: 90 }} className="hide-sm">Region</th>
              <th style={{ width: 70 }} className="hide-sm">Version</th>
              <th style={{ width: 80 }} className="hide-sm">Matched</th>
              <th style={{ width: 80 }}>Files</th>
              <th style={{ width: 100 }}>Vault</th>
              <th style={{ width: 40 }} />
            </tr>
          </thead>
          <tbody>
            {shown.map((g) => (
              <tr key={g.id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${g.name}`}
                    checked={selected.has(g.id)}
                    onChange={() => toggle(g.id)}
                    style={{ width: 'auto' }}
                  />
                </td>
                <td>
                  {g.name}
                  {g.inputName && g.inputName !== g.name && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      typed “{g.inputName}”
                    </div>
                  )}
                </td>
                <td className="muted">{g.platform}</td>
                <td className="muted hide-sm">{g.region ?? '—'}</td>
                <td className="muted hide-sm">{g.version ?? '—'}</td>
                <td className="hide-sm">
                  {g.resolvedTier !== null ? (
                    <span className={`badge tier${g.resolvedTier}`}>
                      {TIER_LABELS[g.resolvedTier as ResolvedTier]}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  {filesFor(g.id).length > 0 ? (
                    <button
                      onClick={() => setExpanded(expanded === g.id ? null : g.id)}
                      style={{ padding: '2px 8px', fontSize: 12 }}
                    >
                      {filesFor(g.id).length} {expanded === g.id ? '▾' : '▸'}
                    </button>
                  ) : (
                    <span className="badge" title="Nothing organized on disk for this game">
                      none
                    </span>
                  )}
                </td>
                <td>
                  <a href={g.vaultUrl} target="_blank" rel="noreferrer">
                    {g.vaultId ? `vault/${g.vaultId}` : 'link'}
                  </a>
                </td>
                <td>
                  <button className="danger" onClick={() => void remove(g.id)} title="Remove">
                    ×
                  </button>
                </td>
              </tr>
            )).flatMap((row, i) => {
              const g = shown[i]!;
              if (expanded !== g.id) return [row];
              return [
                row,
                <tr key={`${g.id}-files`}>
                  <td colSpan={9} style={{ background: 'var(--panel-2)' }}>
                    <strong style={{ fontSize: 12 }}>On disk</strong>
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                      {filesFor(g.id).map((f) => (
                        <li key={f.id} className="muted" style={{ fontSize: 12 }}>
                          <code>{f.relPath}</code>
                          {f.bytes !== null && ` — ${(f.bytes / (1024 * 1024)).toFixed(1)} MB`}
                          {f.kind && ` (${f.kind})`}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>,
              ];
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={9} className="muted" style={{ padding: 20, textAlign: 'center' }}>
                  {games.length === 0
                    ? 'Nothing saved yet — run an import.'
                    : fileFilter === 'missing'
                      ? 'Every game has files on disk.'
                      : 'No games match that filter.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
