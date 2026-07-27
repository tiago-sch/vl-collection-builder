import { useEffect, useMemo, useState } from 'react';
import { TIER_LABELS, type Game, type LibraryFile, type ResolvedTier } from '@vault-lookup/shared';
import { api } from '../api/client.js';

export function Library() {
  const [games, setGames] = useState<Game[]>([]);
  const [filter, setFilter] = useState('');
  const [platform, setPlatform] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = (): void => {
    void api
      .games()
      .then((r) => setGames(r.games))
      .catch((e) => setError((e as Error).message));
  };

  useEffect(load, []);
  useEffect(() => {
    void api
      .libraryFiles()
      .then((r) => setFiles(r.files))
      .catch(() => setFiles([]));
  }, []);

  const filesFor = (gameId: number): LibraryFile[] => files.filter((f) => f.gameId === gameId);

  const platforms = useMemo(() => [...new Set(games.map((g) => g.platform))].sort(), [games]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return games.filter(
      (g) =>
        (!platform || g.platform === platform) &&
        (!q || g.name.toLowerCase().includes(q) || (g.inputName ?? '').toLowerCase().includes(q)),
    );
  }, [games, filter, platform]);

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

      <div className="panel">
        <div className="row">
          <input
            type="text"
            placeholder="Filter by name…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ flex: 1, minWidth: 180 }}
          />
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            style={{ width: 160 }}
          >
            <option value="">All platforms</option>
            {platforms.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button
            className="primary"
            disabled={selected.size === 0}
            onClick={() => void enqueue()}
          >
            Add {selected.size || ''} to downloads
          </button>
          <a className="btn" href={exportUrl('minimal')} target="_blank" rel="noreferrer">
            Export JSON
          </a>
          <a className="btn" href={exportUrl('csv')}>
            Export CSV
          </a>
        </div>
      </div>

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
              <th style={{ width: 90 }}>Region</th>
              <th style={{ width: 70 }}>Version</th>
              <th style={{ width: 80 }}>Matched</th>
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
                <td className="muted">{g.region ?? '—'}</td>
                <td className="muted">{g.version ?? '—'}</td>
                <td>
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
