import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Candidate, JobCounts, JobItem } from '@vault-lookup/shared';
import { api } from '../api/client.js';

/**
 * The review queue (plan §6.1).
 *
 * Keyboard-driven and one item at a time: number keys select, Enter confirms,
 * arrows move. Items already settled are not shown — this screen is for
 * decisions, not for confirming things that are already decided.
 */
export function Review({ jobId, onDone }: { jobId: number; onDone: () => void }) {
  const [items, setItems] = useState<JobItem[]>([]);
  const [counts, setCounts] = useState<JobCounts | null>(null);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const [{ items: all }, { counts: c }] = await Promise.all([
      api.jobItems(jobId),
      api.job(jobId),
    ]);
    setItems(all);
    setCounts(c);
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  const queue = useMemo(
    () => items.filter((i) => i.status === 'needs_review' || i.status === 'not_found'),
    [items],
  );
  const current = queue[index];

  useEffect(() => {
    setSelected(0);
    setShowManual(false);
    setManualUrl('');
  }, [index, current?.id]);

  const resolve = useCallback(
    async (body: { entryId?: number; manualUrl?: string; skip?: boolean }): Promise<void> => {
      if (!current) return;
      try {
        await api.resolveItem(jobId, current.id, body);
        await load();
        // Staying on the same index moves to the next unresolved item, because
        // the one just handled drops out of the queue.
        setIndex((i) => Math.min(i, Math.max(0, queue.length - 2)));
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [current, jobId, load, queue.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!current) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      if (e.key >= '1' && e.key <= '9') {
        const n = Number(e.key) - 1;
        if (n < current.candidates.length) setSelected(n);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, current.candidates.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (e.key === 'Enter') {
        const c = current.candidates[selected];
        if (c) void resolve({ entryId: c.entryId });
      } else if (e.key.toLowerCase() === 's') {
        void resolve({ skip: true });
      } else if (e.key.toLowerCase() === 'u') {
        setShowManual(true);
      } else if (e.key === 'ArrowRight') {
        setIndex((i) => Math.min(i + 1, queue.length - 1));
      } else if (e.key === 'ArrowLeft') {
        setIndex((i) => Math.max(i - 1, 0));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, selected, resolve, queue.length]);

  const commit = async (): Promise<void> => {
    setCommitting(true);
    try {
      const { result } = await api.commitJob(jobId);
      setCommitted(
        `${result.inserted} added to your library` +
          (result.existing ? `, ${result.existing} already there` : '') +
          (result.skipped ? `, ${result.skipped} unresolved and left out` : ''),
      );
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCommitting(false);
    }
  };

  const autoMatched = counts?.byStatus.auto_matched ?? 0;
  const confirmed = counts?.byStatus.confirmed ?? 0;

  return (
    <>
      <div className="spread">
        <h1>Review</h1>
        <button onClick={onDone}>Back to import</button>
      </div>
      <p className="sub">
        {counts
          ? `${autoMatched + confirmed} of ${counts.total} settled · ${queue.length} left to review`
          : 'loading…'}
      </p>

      {error && <div className="banner error">{error}</div>}
      {committed && <div className="banner info">{committed}</div>}

      {counts && (
        <div className="panel">
          <div className="row">
            <TierCount counts={counts} tier={0} label="alias" />
            <TierCount counts={counts} tier={1} label="exact" />
            <TierCount counts={counts} tier={2} label="fuzzy" />
            <TierCount counts={counts} tier={4} label="you" />
            <div style={{ flex: 1 }} />
            <button
              className="primary"
              onClick={() => void commit()}
              disabled={committing || autoMatched + confirmed === 0}
            >
              {committing ? 'Saving…' : `Save ${autoMatched + confirmed} to library`}
            </button>
          </div>
        </div>
      )}

      {queue.length === 0 && (
        <div className="panel">
          <p style={{ margin: 0 }}>
            Nothing left to review. {autoMatched + confirmed > 0 && 'Save them to your library above.'}
          </p>
        </div>
      )}

      {current && (
        <div className="panel">
          <div className="spread" style={{ marginBottom: 12 }}>
            <div>
              <strong style={{ fontSize: 16 }}>“{current.inputName}”</strong>
              {current.status === 'not_found' && (
                <span className="badge" style={{ marginLeft: 8 }}>
                  nothing close found
                </span>
              )}
            </div>
            <span className="muted">
              {index + 1} of {queue.length}
            </span>
          </div>

          {current.candidates.length === 0 && (
            <p className="muted">
              No candidates in the local catalogue. Paste a Vault URL below, or skip it.
            </p>
          )}

          {current.candidates.map((c, i) => (
            <CandidateRow
              key={c.entryId}
              candidate={c}
              index={i}
              selected={i === selected}
              onSelect={() => setSelected(i)}
              onConfirm={() => void resolve({ entryId: c.entryId })}
            />
          ))}

          {showManual && (
            <div className="row" style={{ marginTop: 12 }}>
              <input
                type="url"
                autoFocus
                placeholder="https://vimm.net/vault/8433"
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                className="primary"
                disabled={!/^https?:\/\//i.test(manualUrl)}
                onClick={() => void resolve({ manualUrl })}
              >
                Use this URL
              </button>
              <button onClick={() => setShowManual(false)}>Cancel</button>
            </div>
          )}

          <div className="row" style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <span className="muted" style={{ fontSize: 12 }}>
              <kbd>1</kbd>–<kbd>9</kbd> select · <kbd>↑↓</kbd> move · <kbd>Enter</kbd> confirm ·{' '}
              <kbd>S</kbd> skip · <kbd>U</kbd> paste URL · <kbd>←→</kbd> other items
            </span>
            <div style={{ flex: 1 }} />
            <button onClick={() => void resolve({ skip: true })}>Skip</button>
          </div>
        </div>
      )}
    </>
  );
}

function TierCount({ counts, tier, label }: { counts: JobCounts; tier: 0 | 1 | 2 | 4; label: string }) {
  const n = counts.byTier[tier] ?? 0;
  return (
    <span className={`badge tier${tier}`}>
      {n} {label}
    </span>
  );
}

function CandidateRow({
  candidate,
  index,
  selected,
  onSelect,
  onConfirm,
}: {
  candidate: Candidate;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onConfirm: () => void;
}) {
  const owned = candidate.libraryState === 'in_library';

  return (
    <div
      className={`candidate${selected ? ' selected' : ''}`}
      onClick={onSelect}
      onDoubleClick={onConfirm}
    >
      <span className="key">{index < 9 ? index + 1 : '·'}</span>
      <span className="title">
        <b>{candidate.title}</b>
        {owned && (
          <span className="badge owned" style={{ marginLeft: 8 }}>
            already in library
          </span>
        )}
        <br />
        <span className="meta">
          {candidate.regions.join('/') || 'region unknown'}
          {candidate.version && ` · v${candidate.version}`}
          {candidate.rating !== null && ` · ${candidate.rating}`}
          {candidate.languages && ` · ${candidate.languages}`}
          {' · '}
          <a href={candidate.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            vault/{candidate.vaultId}
          </a>
        </span>
      </span>
      <span className="score">{candidate.score.toFixed(2)}</span>
      {selected && (
        <button
          className="primary"
          onClick={(e) => {
            e.stopPropagation();
            onConfirm();
          }}
        >
          {owned ? 'Confirm anyway' : 'Confirm'}
        </button>
      )}
    </div>
  );
}
