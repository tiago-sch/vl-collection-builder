import { useEffect, useMemo, useState } from 'react';
import type { CatalogSyncState, Platform } from '@vl-collection-builder/shared';
import { api, syncCatalog } from '../api/client.js';
import { RegionPicker } from '../components/RegionPicker.js';

type CatalogRow = CatalogSyncState & { label: string; syncing: boolean };

export function Import({ onJobCreated }: { onJobCreated: (jobId: number) => void }) {
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [platform, setPlatform] = useState('ps2');
  const [text, setText] = useState('');
  const [regions, setRegions] = useState<string[]>([]);
  const [strict, setStrict] = useState(false);
  const [showRegions, setShowRegions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<string | null>(null);

  const refresh = (): void => {
    void api.catalogStatus().then((r) => setCatalog(r.platforms));
  };

  useEffect(() => {
    void api.platforms().then((r) => setPlatforms(r.platforms));
    void api.settings().then((r) => {
      setRegions(r.settings.regionPreference);
      setStrict(r.settings.strictRegion);
    });
    refresh();
  }, []);

  const names = useMemo(
    () => text.split('\n').map((l) => l.trim()).filter(Boolean),
    [text],
  );
  const uniqueCount = useMemo(
    () => new Set(names.map((n) => n.toLowerCase())).size,
    [names],
  );

  const state = catalog.find((c) => c.platform === platform);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { job } = await api.createJob({
        platform,
        names,
        regionPreference: regions,
        strictRegion: strict,
      });
      onJobCreated(job.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runSync = (): void => {
    setSyncProgress('starting…');
    syncCatalog(platform, {
      onProgress: (p) => setSyncProgress(`${p.section} — ${p.entriesSeen.toLocaleString()} games`),
      onDone: (r) => {
        setSyncProgress(null);
        refresh();
        if (r.warnings.length) setError(r.warnings.join(' · '));
      },
      onError: (m) => {
        setSyncProgress(null);
        setError(m);
      },
    });
  };

  return (
    <>
      <h1>Import</h1>
      <p className="sub">Paste a list of game names, one per line.</p>

      {error && <div className="banner error">{error}</div>}

      {state && state.entryCount === 0 && (
        <div className="banner warn">
          No catalogue for {state.label} yet — matching needs one.{' '}
          <button onClick={runSync} disabled={syncProgress !== null}>
            {syncProgress ?? 'Sync now'}
          </button>
        </div>
      )}

      {state && state.entryCount > 0 && state.stale && (
        <div className="banner warn">
          The {state.label} catalogue was last synced{' '}
          {state.ageDays === null ? 'never' : `${Math.floor(state.ageDays)} days ago`} — new
          releases may be missing.{' '}
          <button onClick={runSync} disabled={syncProgress !== null}>
            {syncProgress ?? 'Refresh'}
          </button>
        </div>
      )}

      {syncProgress && <div className="banner info">Syncing: {syncProgress}</div>}

      <div className="panel">
        <div className="row" style={{ marginBottom: 14 }}>
          <label style={{ flex: '0 0 220px' }}>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              {platforms.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <span className="muted">
            {state ? `${state.entryCount.toLocaleString()} games mirrored` : 'loading…'}
          </span>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div className="spread" style={{ marginBottom: showRegions ? 12 : 0 }}>
            <span className="muted">
              Region preference: <strong>{regions.join(' › ') || 'none'}</strong>
              {strict && ' · strict'}
            </span>
            <button onClick={() => setShowRegions((v) => !v)}>
              {showRegions ? 'Done' : 'Change for this import'}
            </button>
          </div>
          {showRegions && (
            <RegionPicker
              value={regions}
              onChange={setRegions}
              strict={strict}
              onStrictChange={setStrict}
            />
          )}
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'Silent Hill 2\nOkami\nbiohazard 4\nmgs3'}
          spellCheck={false}
        />

        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="primary"
            disabled={busy || names.length === 0 || regions.length === 0}
            onClick={() => void submit()}
          >
            {busy ? 'Matching…' : `Match ${uniqueCount} game${uniqueCount === 1 ? '' : 's'}`}
          </button>
          <span className="muted">
            {names.length} line{names.length === 1 ? '' : 's'}
            {names.length !== uniqueCount && ` · ${names.length - uniqueCount} duplicate removed`}
          </span>
          {regions.length === 0 && <span className="muted">Pick at least one region first.</span>}
        </div>
      </div>
    </>
  );
}
