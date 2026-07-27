import { useEffect, useState } from 'react';
import type {
  AppSettings,
  CatalogSyncState,
  LearnedAlias,
  SourceHealth,
  SyncProgress,
} from '@vl-collection-builder/shared';
import { api, syncCatalog } from '../api/client.js';
import { RegionPicker } from '../components/RegionPicker.js';

type CatalogRow = CatalogSyncState & {
  label: string;
  syncing: boolean;
  progress: SyncProgress | null;
};

export function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [ceiling, setCeiling] = useState(0.075);
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [health, setHealth] = useState<SourceHealth | null>(null);
  const [aliases, setAliases] = useState<LearnedAlias[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<Record<string, string>>({});
  const [library, setLibrary] = useState<Awaited<ReturnType<typeof api.libraryStatus>> | null>(null);
  const [template, setTemplate] = useState('');
  const [preview, setPreview] = useState<{ rendered: string }[]>([]);

  const refresh = (): void => {
    void api.settings().then((r) => {
      setSettings(r.settings);
      setCeiling(r.regionBonusCeiling);
    });
    void api.catalogStatus().then((r) => {
      setCatalog(r.platforms);
      setHealth(r.health);
    });
    void api.aliases().then((r) => setAliases(r.aliases));
    void api.libraryStatus().then((r) => {
      setLibrary(r);
      setTemplate((t) => t || r.namingTemplate);
    });
  };

  useEffect(refresh, []);

  // Live preview, so you can see what a template change does before applying it
  // to 400 games (plan §9.7).
  useEffect(() => {
    if (!template) return;
    const t = setTimeout(() => {
      void api
        .namingPreview(template)
        .then((r) => setPreview(r.examples))
        .catch(() => setPreview([]));
    }, 250);
    return () => clearTimeout(t);
  }, [template]);

  const save = async (patch: Partial<AppSettings>): Promise<void> => {
    try {
      const r = await api.updateSettings(patch);
      setSettings(r.settings);
      setMessage('Saved.');
      setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const runSync = (slug: string): void => {
    setSyncing((s) => ({ ...s, [slug]: 'starting…' }));
    syncCatalog(slug, {
      onProgress: (p) =>
        setSyncing((s) => ({ ...s, [slug]: `${p.section} — ${p.entriesSeen.toLocaleString()}` })),
      onDone: () => {
        setSyncing((s) => {
          const next = { ...s };
          delete next[slug];
          return next;
        });
        refresh();
      },
      onError: (m) => {
        setSyncing((s) => {
          const next = { ...s };
          delete next[slug];
          return next;
        });
        setError(m);
      },
    });
  };

  if (!settings) return <p className="muted">Loading…</p>;

  return (
    <>
      <h1>Settings</h1>
      <p className="sub">Matching behaviour, catalogues, and what the tool has learned.</p>

      {message && <div className="banner info">{message}</div>}
      {error && <div className="banner error">{error}</div>}

      <div className="panel">
        <h2>Default region preference</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Used unless an import overrides it. Ranked, highest first.
        </p>
        <RegionPicker
          value={settings.regionPreference}
          onChange={(regionPreference) => setSettings({ ...settings, regionPreference })}
          strict={settings.strictRegion}
          onStrictChange={(strictRegion) => setSettings({ ...settings, strictRegion })}
        />
        <button
          className="primary"
          style={{ marginTop: 12 }}
          disabled={settings.regionPreference.length === 0}
          onClick={() =>
            void save({
              regionPreference: settings.regionPreference,
              strictRegion: settings.strictRegion,
            })
          }
        >
          Save region preference
        </button>
      </div>

      <div className="panel">
        <h2>Matching thresholds</h2>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <Threshold
            label="Auto-accept above"
            value={settings.fuzzyThreshold}
            onChange={(fuzzyThreshold) => setSettings({ ...settings, fuzzyThreshold })}
            hint="Fuzzy score a match must beat to be accepted without asking."
          />
          <Threshold
            label="Required margin"
            value={settings.fuzzyMargin}
            onChange={(fuzzyMargin) => setSettings({ ...settings, fuzzyMargin })}
            hint="Gap the best match needs over the runner-up. This is what stops two regional variants being auto-accepted."
          />
          <Threshold
            label="Region bonus"
            value={settings.regionBonus}
            onChange={(regionBonus) => setSettings({ ...settings, regionBonus })}
            hint={`Capped at ${ceiling.toFixed(3)} — always below the margin, so region preference breaks ties but never promotes a worse title match.`}
          />
        </div>
        <button
          className="primary"
          onClick={() =>
            void save({
              fuzzyThreshold: settings.fuzzyThreshold,
              fuzzyMargin: settings.fuzzyMargin,
              regionBonus: settings.regionBonus,
            })
          }
        >
          Save thresholds
        </button>
      </div>

      <div className="panel">
        <h2>Catalogues</h2>
        {health && health.circuitOpen && (
          <div className="banner warn">
            The source is being skipped after {health.failureStreak} consecutive failures — retrying
            after {health.retryAfter}. Last error: {health.lastError}
          </div>
        )}
        <table>
          <thead>
            <tr>
              <th>Platform</th>
              <th style={{ width: 100 }}>Games</th>
              <th style={{ width: 140 }}>Last synced</th>
              <th style={{ width: 150 }} />
            </tr>
          </thead>
          <tbody>
            {catalog
              .filter((c) => c.entryCount > 0 || syncing[c.platform])
              .map((c) => (
                <tr key={c.platform}>
                  <td>{c.label}</td>
                  <td className="muted">{c.entryCount.toLocaleString()}</td>
                  <td className="muted">
                    {c.lastSyncedAt ? `${Math.floor(c.ageDays ?? 0)}d ago` : 'never'}
                    {c.stale && <span className="badge" style={{ marginLeft: 6 }}>stale</span>}
                  </td>
                  <td>
                    <button onClick={() => runSync(c.platform)} disabled={!!syncing[c.platform]}>
                      {syncing[c.platform] ?? 'Refresh'}
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 12 }}>
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) runSync(e.target.value);
              e.target.value = '';
            }}
            style={{ maxWidth: 260 }}
          >
            <option value="">Sync another platform…</option>
            {catalog
              .filter((c) => c.entryCount === 0)
              .map((c) => (
                <option key={c.platform} value={c.platform}>
                  {c.label}
                </option>
              ))}
          </select>
        </div>
      </div>

      {library && (
        <div className="panel">
          <h2>Library &amp; organizing</h2>

          {!library.enabled && (
            <div className="banner warn">
              Organizing is off (ORGANIZE_ENABLED=false) — downloads stop at the staging
              directory.
            </div>
          )}
          {library.folderMapWarnings.map((w) => (
            <div className="banner warn" key={w}>
              {w}
            </div>
          ))}
          {!library.chdmanAvailable && library.chdPolicy !== 'never' && (
            <div className="banner warn">
              chdman is not available in this image, so CHD conversion will be skipped and disc
              images stay in their extracted layout.
            </div>
          )}

          <div className="row muted" style={{ fontSize: 13, marginBottom: 14 }}>
            <span>
              Library <code>{library.libraryPath}</code>
            </span>
            <span>·</span>
            <span>
              Work <code>{library.workPath}</code>
            </span>
            <span>·</span>
            <span>extract: {library.extractPolicy}</span>
            <span>·</span>
            <span>chd: {library.chdPolicy}</span>
            <span>·</span>
            <span>folders: {library.platformFolderStyle}</span>
          </div>

          <label className="field">
            <span>Naming template</span>
            <input
              type="text"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              spellCheck={false}
            />
            <span style={{ textTransform: 'none', letterSpacing: 0, marginTop: 5, fontSize: 12 }}>
              Tokens: {'{title} {region} {version} {platform} {vaultId} {disc}'}. Set via
              NAMING_TEMPLATE — this preview is read-only.
            </span>
          </label>

          {preview.length > 0 && (
            <div>
              <strong style={{ fontSize: 12 }}>Preview</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {preview.map((e, i) => (
                  <li key={i} className="muted" style={{ fontSize: 13 }}>
                    <code>{e.rendered}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <details style={{ marginTop: 14 }}>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: 13 }}>
              Platform folder names ({library.platformFolderStyle})
            </summary>
            <div className="row" style={{ marginTop: 8, fontSize: 12 }}>
              {library.folders.map((f) => (
                <span key={f.slug} className="badge">
                  {f.slug} → {f.folder}
                </span>
              ))}
            </div>
          </details>
        </div>
      )}

      <div className="panel">
        <h2>Learned aliases</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Every review confirmation is remembered, so the same input resolves instantly next time.
          Delete one if you confirmed the wrong thing.
        </p>
        {aliases.length === 0 ? (
          <p className="muted">Nothing learned yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>You typed</th>
                <th>Resolves to</th>
                <th style={{ width: 80 }}>Source</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {aliases.map((a) => (
                <tr key={a.id}>
                  <td style={{ fontFamily: 'ui-monospace, monospace' }}>{a.inputNorm}</td>
                  <td>{a.title ?? `vault/${a.vaultId}`}</td>
                  <td className="muted">{a.source}</td>
                  <td>
                    <button
                      className="danger"
                      onClick={() => void api.deleteAlias(a.id).then(refresh)}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Threshold({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint: string;
}) {
  return (
    <label className="field" style={{ flex: '1 1 220px' }}>
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => {
          const n = Number.parseFloat(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
      <span style={{ textTransform: 'none', letterSpacing: 0, marginTop: 5, fontSize: 12 }}>
        {hint}
      </span>
    </label>
  );
}
