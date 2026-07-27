import { useCallback, useEffect, useRef, useState } from 'react';
import type { DownloadItem, DownloadProgress, DownloadStatus } from '@vault-lookup/shared';
import { api, streamDownloads } from '../api/client.js';

const ACTIVE_STATES: DownloadStatus[] = ['queued', 'active', 'paused', 'downloaded', 'organizing'];

function bytes(n: number): string {
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
}

export function Downloads() {
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [meta, setMeta] = useState<{
    freeDiskMb: number | null;
    downloadsPath: string;
    interDownloadDelayMs: number;
    enabled: boolean;
  } | null>(null);
  const [live, setLive] = useState<Record<number, DownloadProgress>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await api.downloads();
      setItems(r.items);
      setMeta({
        freeDiskMb: r.freeDiskMb,
        downloadsPath: r.downloadsPath,
        interDownloadDelayMs: r.interDownloadDelayMs,
        enabled: r.enabled,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live progress, plus a reload whenever an item finishes so statuses settle.
  const reloadTimer = useRef<number | null>(null);
  useEffect(() => {
    const stop = streamDownloads({
      onProgress: (p) => {
        setLive((prev) => ({ ...prev, [p.id]: p }));
        if (p.status !== 'active') {
          if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
          reloadTimer.current = window.setTimeout(() => void load(), 300);
        }
      },
      onError: () => undefined,
    });
    return () => {
      stop();
      if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    };
  }, [load]);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const queue = items.filter((i) => ACTIVE_STATES.includes(i.status));
  const done = items.filter((i) => i.status === 'completed' || i.status === 'organized');
  const failed = items.filter(
    (i) => i.status === 'error' || i.status === 'cancelled' || i.status === 'organize_error',
  );

  return (
    <>
      <h1>Downloads</h1>
      <p className="sub">
        One file at a time, always.{' '}
        <span className="muted">
          Vimm's operator asks for one download at a time, so there is no concurrency setting —
          the worker is a single loop by design.
        </span>
      </p>

      {error && <div className="banner error">{error}</div>}
      {meta && !meta.enabled && (
        <div className="banner warn">The download worker is disabled (DOWNLOADS_ENABLED=false).</div>
      )}

      {meta && (
        <div className="panel">
          <div className="row muted" style={{ fontSize: 13 }}>
            <span>
              Saving to <code>{meta.downloadsPath}</code>
            </span>
            <span>·</span>
            <span>
              {meta.freeDiskMb === null
                ? 'free space unknown'
                : `${(meta.freeDiskMb / 1024).toFixed(1)} GB free`}
            </span>
            <span>·</span>
            <span>{meta.interDownloadDelayMs / 1000}s between files</span>
          </div>
        </div>
      )}

      <Section title={`Queue (${queue.length})`} empty="Nothing queued.">
        {queue.map((item, i) => {
          const p = live[item.id];
          const received = p?.receivedBytes ?? item.receivedBytes;
          const total = p?.totalBytes || item.totalBytes;
          const pct = total > 0 ? Math.min(100, (received / total) * 100) : 0;

          return (
            <div key={item.id} className="panel" style={{ marginBottom: 8 }}>
              <div className="spread">
                <div style={{ minWidth: 0 }}>
                  <strong>{item.title}</strong>{' '}
                  <span className={`badge${item.status === 'active' ? ' tier1' : ''}`}>
                    {item.status}
                  </span>
                  {item.disc && (
                    <span className="badge" style={{ marginLeft: 6 }}>
                      disc {item.disc}/{item.discTotal}
                    </span>
                  )}
                  <div className="muted" style={{ fontSize: 12 }}>
                    {item.fileName ?? item.vaultUrl}
                  </div>
                </div>
                <div className="row">
                  <button
                    onClick={() => void act(() => api.reorderDownload(item.id, Math.max(0, i - 1)))}
                    disabled={i === 0}
                    title="Move up"
                  >
                    ↑
                  </button>
                  {item.status === 'queued' && (
                    <button onClick={() => void act(() => api.pauseDownload(item.id))}>Pause</button>
                  )}
                  {item.status === 'paused' && (
                    <button onClick={() => void act(() => api.resumeDownload(item.id))}>
                      Resume
                    </button>
                  )}
                  <button className="danger" onClick={() => void act(() => api.deleteDownload(item.id))}>
                    Cancel
                  </button>
                </div>
              </div>

              {(item.status === 'active' || received > 0) && (
                <div style={{ marginTop: 8 }}>
                  <div className="progress">
                    <div style={{ width: `${pct}%` }} />
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {bytes(received)} of {bytes(total)}
                    {p?.rate ? ` · ${bytes(p.rate)}/s` : ''}
                    {item.attempts > 0 && ` · attempt ${item.attempts + 1}`}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </Section>

      <Section title={`Failed (${failed.length})`} empty="">
        {failed.map((item) => (
          <div key={item.id} className="panel" style={{ marginBottom: 8 }}>
            <div className="spread">
              <div style={{ minWidth: 0 }}>
                <strong>{item.title}</strong>{' '}
                <span className="badge">{item.status}</span>
                {item.error && (
                  <div className="muted" style={{ fontSize: 12 }}>
                    {item.error}
                  </div>
                )}
              </div>
              <div className="row">
                <button onClick={() => void act(() => api.retryDownload(item.id))}>Retry</button>
                <button
                  className="danger"
                  onClick={() => void act(() => api.deleteDownload(item.id, true))}
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        ))}
      </Section>

      <Section title={`Completed (${done.length})`} empty="Nothing downloaded yet.">
        {done.length > 0 && (
          <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th style={{ width: 260 }}>File</th>
                  <th style={{ width: 100 }}>Size</th>
                  <th style={{ width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {done.map((item) => (
                  <tr key={item.id}>
                    <td>{item.title}</td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {item.fileName ?? '—'}
                    </td>
                    <td className="muted">{bytes(item.totalBytes)}</td>
                    <td>
                      <button className="danger" onClick={() => void act(() => api.deleteDownload(item.id))}>
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  const has = Array.isArray(children) ? children.length > 0 : Boolean(children);
  if (!has && !empty) return null;
  return (
    <section style={{ marginBottom: 24 }}>
      <h2>{title}</h2>
      {has ? children : <p className="muted">{empty}</p>}
    </section>
  );
}
