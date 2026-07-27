import { useEffect, useMemo, useState } from 'react';
import { TIER_LABELS, type Game, type ResolvedTier } from '@vault-lookup/shared';
import { api } from '../api/client.js';

export function Library() {
  const [games, setGames] = useState<Game[]>([]);
  const [filter, setFilter] = useState('');
  const [platform, setPlatform] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    void api
      .games()
      .then((r) => setGames(r.games))
      .catch((e) => setError((e as Error).message));
  };

  useEffect(load, []);

  const platforms = useMemo(() => [...new Set(games.map((g) => g.platform))].sort(), [games]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return games.filter(
      (g) =>
        (!platform || g.platform === platform) &&
        (!q || g.name.toLowerCase().includes(q) || (g.inputName ?? '').toLowerCase().includes(q)),
    );
  }, [games, filter, platform]);

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
              <th>Name</th>
              <th style={{ width: 90 }}>Platform</th>
              <th style={{ width: 90 }}>Region</th>
              <th style={{ width: 70 }}>Version</th>
              <th style={{ width: 80 }}>Matched</th>
              <th style={{ width: 100 }}>Vault</th>
              <th style={{ width: 40 }} />
            </tr>
          </thead>
          <tbody>
            {shown.map((g) => (
              <tr key={g.id}>
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
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ padding: 20, textAlign: 'center' }}>
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
