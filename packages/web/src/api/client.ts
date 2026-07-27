import type {
  AppSettings,
  DownloadItem,
  DownloadProgress,
  CatalogSyncState,
  Game,
  Job,
  JobCounts,
  JobItem,
  JobItemStatus,
  LearnedAlias,
  Platform,
  SetupState,
  SourceHealth,
  SyncProgress,
} from '@vault-lookup/shared';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string; detail?: string };
      detail = body.detail ?? body.error ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const api = {
  platforms: () => request<{ platforms: Platform[] }>('/platforms'),

  setupState: () => request<SetupState>('/setup/state'),
  completeSetup: (body: {
    platform?: string;
    regionPreference: string[];
    strictRegion: boolean;
  }) => request<{ completed: boolean }>('/setup/complete', {
    method: 'POST',
    body: JSON.stringify(body),
  }),

  catalogStatus: () =>
    request<{
      platforms: (CatalogSyncState & { label: string; syncing: boolean })[];
      health: SourceHealth;
      staleAfterDays: number;
    }>('/catalog/status'),

  settings: () => request<{ settings: AppSettings; regionBonusCeiling: number }>('/settings'),
  updateSettings: (patch: Partial<AppSettings>) =>
    request<{ settings: AppSettings }>('/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  createJob: (body: {
    platform: string;
    names: string[];
    name?: string;
    regionPreference?: string[];
    strictRegion?: boolean;
  }) => request<{ job: Job; counts: JobCounts }>('/jobs', {
    method: 'POST',
    body: JSON.stringify(body),
  }),

  job: (id: number) => request<{ job: Job; counts: JobCounts }>(`/jobs/${id}`),
  jobItems: (id: number, status?: JobItemStatus) =>
    request<{ items: JobItem[] }>(`/jobs/${id}/items${status ? `?status=${status}` : ''}`),

  resolveItem: (
    jobId: number,
    itemId: number,
    body: { entryId?: number; manualUrl?: string; skip?: boolean },
  ) => request<{ item: JobItem; counts: JobCounts }>(`/jobs/${jobId}/items/${itemId}/resolve`, {
    method: 'POST',
    body: JSON.stringify(body),
  }),

  commitJob: (id: number) =>
    request<{ result: { inserted: number; existing: number; skipped: number }; counts: JobCounts }>(
      `/jobs/${id}/commit`,
      { method: 'POST' },
    ),

  games: (platform?: string) =>
    request<{ games: Game[]; count: number }>(`/games${platform ? `?platform=${platform}` : ''}`),
  deleteGame: (id: number) => request<{ deleted: boolean }>(`/games/${id}`, { method: 'DELETE' }),

  aliases: (platform?: string) =>
    request<{ aliases: LearnedAlias[] }>(`/aliases${platform ? `?platform=${platform}` : ''}`),
  deleteAlias: (id: number) => request<{ deleted: boolean }>(`/aliases/${id}`, { method: 'DELETE' }),

  downloads: () =>
    request<{
      items: DownloadItem[];
      active: DownloadItem | null;
      stats: Record<string, number>;
      downloading: boolean;
      enabled: boolean;
      freeDiskMb: number | null;
      downloadsPath: string;
      concurrency: number;
      interDownloadDelayMs: number;
    }>('/downloads'),

  enqueueDownloads: (body: { gameIds?: number[]; vaultUrls?: string[] }) =>
    request<{ queued: number[]; duplicates: number[]; errors: string[] }>('/downloads', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  reorderDownload: (id: number, position: number) =>
    request<{ item: DownloadItem }>(`/downloads/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ position }),
    }),

  pauseDownload: (id: number) =>
    request<{ item: DownloadItem }>(`/downloads/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'paused' }),
    }),

  resumeDownload: (id: number) =>
    request<{ item: DownloadItem }>(`/downloads/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'queued' }),
    }),

  retryDownload: (id: number) =>
    request<{ item: DownloadItem }>(`/downloads/${id}/retry`, { method: 'POST' }),

  deleteDownload: (id: number, deletePart = false) =>
    request<{ deleted?: boolean; cancelled?: boolean }>(
      `/downloads/${id}${deletePart ? '?deletePart=true' : ''}`,
      { method: 'DELETE' },
    ),

  liveSearch: (platform: string, q: string) =>
    request<{ results: { vaultId: number; title: string; regions: string[]; url: string }[] }>(
      `/catalog/search/${platform}?q=${encodeURIComponent(q)}`,
    ),
};

/**
 * Catalogue sync over SSE. The crawl takes minutes, so progress has to stream
 * rather than resolve at the end.
 */
export function syncCatalog(
  platform: string,
  handlers: {
    onProgress?: (p: SyncProgress) => void;
    onDone?: (r: { entryCount: number; pagesFetched: number; warnings: string[] }) => void;
    onError?: (message: string) => void;
  },
): () => void {
  const controller = new AbortController();

  void (async () => {
    try {
      const res = await fetch(`/api/catalog/sync/${platform}`, {
        method: 'POST',
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`sync failed: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const event = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim();
          const data = /^data:\s*(.+)$/m.exec(frame)?.[1];
          if (!event || !data) continue;
          const payload = JSON.parse(data);
          if (event === 'progress') handlers.onProgress?.(payload);
          else if (event === 'done') handlers.onDone?.(payload);
          else if (event === 'error') handlers.onError?.(payload.error);
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') handlers.onError?.((err as Error).message);
    }
  })();

  return () => controller.abort();
}


/** Download progress over SSE. Shares the transport with catalogue sync. */
export function streamDownloads(handlers: {
  onProgress?: (p: DownloadProgress) => void;
  onError?: (message: string) => void;
}): () => void {
  const source = new EventSource('/api/downloads/stream');
  source.addEventListener('progress', (e) => {
    try {
      handlers.onProgress?.(JSON.parse((e as MessageEvent).data));
    } catch {
      /* ignore a malformed frame rather than tearing down the stream */
    }
  });
  source.onerror = () => handlers.onError?.('download progress stream disconnected');
  return () => source.close();
}
