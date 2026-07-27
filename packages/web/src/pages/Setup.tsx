import { useEffect, useState } from 'react';
import type { Platform } from '@vl-collection-builder/shared';
import { api, syncCatalog } from '../api/client.js';
import { RegionPicker } from '../components/RegionPicker.js';

/**
 * First-run wizard (plan §6.0).
 *
 * Step 2 has no skip and no pre-selected default beyond REGION_PREFERENCE.
 * Silently defaulting to USA and quietly mismatching a Japan-focused collection
 * is the failure this screen exists to prevent, so `Finish` stays disabled until
 * a region is chosen.
 */
export function Setup({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(1);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [platform, setPlatform] = useState('ps2');
  const [synced, setSynced] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [strict, setStrict] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; seen: number } | null>(null);
  const [syncDone, setSyncDone] = useState<string | null>(null);

  useEffect(() => {
    void api.platforms().then((r) => setPlatforms(r.platforms));
    void api.setupState().then((s) => {
      setRegions(s.suggestedRegionPreference);
      setSynced(s.syncedPlatforms);
    });
  }, []);

  // A catalogue can already exist on first run — a restored volume, or setup
  // re-run from Settings. Re-crawling it would cost minutes and hit the source
  // site for nothing, so offer to skip.
  const alreadySynced = synced.includes(platform);

  /**
   * The sync runs in the background through steps 2-3, so the wait costs
   * nothing — by the time the region choice is made, the catalogue is filling.
   */
  const startSync = (): void => {
    setSyncing(true);
    setProgress(null);
    setSyncDone(null);
    syncCatalog(platform, {
      onProgress: (p) =>
        setProgress({ done: p.sectionsDone, total: p.sectionsTotal, seen: p.entriesSeen }),
      onDone: (r) => {
        setSyncing(false);
        if (r) setSyncDone(`${r.entryCount.toLocaleString()} games mirrored in ${r.pagesFetched} requests`);
      },
      onError: (m) => {
        setSyncing(false);
        setError(m);
      },
    });
    setStep(2);
  };

  const finish = async (): Promise<void> => {
    try {
      await api.completeSetup({ platform, regionPreference: regions, strictRegion: strict });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="app" style={{ maxWidth: 620 }}>
      <div style={{ padding: '32px 0 20px' }}>
        <h1>VL Collection Builder — first run</h1>
        <p className="sub">Two steps. Everything here can be changed later in Settings.</p>
      </div>

      <div className="steps">
        {[1, 2].map((n) => (
          <div key={n} className={n <= step ? 'done' : ''} />
        ))}
      </div>

      {error && <div className="banner error">{error}</div>}

      {step === 1 && (
        <div className="panel">
          <h2>Step 1 of 2 — Pick a platform</h2>
          <p className="muted">
            Its catalogue is mirrored locally so matching runs against a full copy instead of
            hitting the site once per game. This takes a few minutes and continues in the
            background while you finish setup.
          </p>
          <label className="field" style={{ marginTop: 14 }}>
            <span>Platform</span>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              {platforms.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {alreadySynced ? (
            <>
              <div className="banner info">
                This platform is already mirrored locally — no need to sync it again.
              </div>
              <div className="row">
                <button className="primary" onClick={() => setStep(2)}>
                  Continue without re-syncing
                </button>
                <button onClick={startSync}>Re-sync anyway</button>
              </div>
            </>
          ) : (
            <button className="primary" onClick={startSync}>
              Start sync and continue
            </button>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="panel">
          <h2>Step 2 of 2 — Which regions do you prefer?</h2>
          <p className="muted">
            Ranked, highest first. When the same game exists in several regions, matching prefers
            the highest entry — and it will never pick a worse title match just to satisfy a region.
          </p>
          <div style={{ marginTop: 14 }}>
            <RegionPicker
              value={regions}
              onChange={setRegions}
              strict={strict}
              onStrictChange={setStrict}
            />
          </div>
          <div className="row" style={{ marginTop: 18 }}>
            <button onClick={() => setStep(1)}>Back</button>
            <button
              className="primary"
              disabled={regions.length === 0}
              onClick={() => void finish()}
            >
              Finish setup
            </button>
            {regions.length === 0 && (
              <span className="muted">Pick at least one region — there is no default.</span>
            )}
          </div>
        </div>
      )}

      {(syncing || syncDone) && (
        <div className="panel">
          <div className="spread">
            <strong>Catalogue sync — {platform}</strong>
            <span className="muted">
              {syncDone ?? (progress ? `${progress.seen.toLocaleString()} games` : 'starting…')}
            </span>
          </div>
          {syncing && progress && (
            <div style={{ marginTop: 10 }}>
              <div className="progress">
                <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
              </div>
              <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
                section {progress.done} of {progress.total}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
