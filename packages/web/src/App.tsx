import { useEffect, useState } from 'react';
import { api } from './api/client.js';
import { Setup } from './pages/Setup.js';
import { Import } from './pages/Import.js';
import { Review } from './pages/Review.js';
import { Library } from './pages/Library.js';
import { Downloads } from './pages/Downloads.js';
import { Settings } from './pages/Settings.js';

type Tab = 'import' | 'review' | 'library' | 'downloads' | 'settings';

export function App() {
  const [ready, setReady] = useState(false);
  const [setupDone, setSetupDone] = useState(false);
  const [tab, setTab] = useState<Tab>('import');
  const [jobId, setJobId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .setupState()
      .then((s) => {
        setSetupDone(s.completed);
        setReady(true);
      })
      .catch((e) => {
        setError((e as Error).message);
        setReady(true);
      });
  }, []);

  if (!ready) {
    return (
      <div className="app">
        <p className="muted" style={{ paddingTop: 40 }}>
          Loading…
        </p>
      </div>
    );
  }

  // Every route redirects to the wizard until setup is complete (plan §6.0).
  if (!setupDone) return <Setup onDone={() => setSetupDone(true)} />;

  return (
    <div className="app">
      <nav className="top">
        <span className="brand">VL Collection Builder</span>
        <button className={tab === 'import' ? 'active' : ''} onClick={() => setTab('import')}>
          Import
        </button>
        <button
          className={tab === 'review' ? 'active' : ''}
          onClick={() => setTab('review')}
          disabled={jobId === null}
          title={jobId === null ? 'Run an import first' : undefined}
        >
          Review
        </button>
        <button className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}>
          Library
        </button>
        <button className={tab === 'downloads' ? 'active' : ''} onClick={() => setTab('downloads')}>
          Downloads
        </button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          Settings
        </button>
      </nav>

      {error && <div className="banner error">{error}</div>}

      {tab === 'import' && (
        <Import
          onJobCreated={(id) => {
            setJobId(id);
            setTab('review');
          }}
        />
      )}
      {tab === 'review' && jobId !== null && (
        <Review jobId={jobId} onDone={() => setTab('import')} />
      )}
      {tab === 'library' && <Library />}
      {tab === 'downloads' && <Downloads />}
      {tab === 'settings' && <Settings />}
    </div>
  );
}
