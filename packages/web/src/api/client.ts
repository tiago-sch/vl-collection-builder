import type {
  AppSettings,
  DownloadItem,
  DownloadProgress,
  LibraryFile,
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
} from '@vl-collection-builder/shared';

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
      platforms: (CatalogSyncState & {
        label: string;
        syncing: boolean;
        /** Present while a crawl is running, so a reload shows it immediately. */
        progress: SyncProgress | null;
      })[];
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

  libraryFiles: (platform?: string) =>
    request<{ files: LibraryFile[] }>(`/library/files${platform ? `?platform=${platform}` : ''}`),

  libraryStatus: () =>
    request<{
      enabled: boolean;
      organizing: boolean;
      libraryPath: string;
      workPath: string;
      namingTemplate: string;
      extractPolicy: string;
      chdPolicy: string;
      chdmanAvailable: boolean;
      platformFolderStyle: string;
      freeDiskMb: number | null;
      folderMapWarnings: string[];
      folders: { slug: string; folder: string }[];
    }>('/library/status'),

  namingPreview: (template: string) =>
    request<{
      template: string;
      examples: { input: Record<string, unknown>; rendered: string }[];
    }>(`/library/preview?template=${encodeURIComponent(template)}`),

  reorganize: (id: number) =>
    request<{ queued: boolean }>(`/downloads/${id}/reorganize`, { method: 'POST' }),

  cancelSync: (platform: string) =>
    request<{ cancelled: boolean }>(`/catalog/sync/${platform}/cancel`, { method: 'POST' }),

  liveSearch: (platform: string, q: string) =>
    request<{ results: { vaultId: number; title: string; regions: string[]; url: string }[] }>(
      `/catalog/search/${platform}?q=${encodeURIComponent(q)}`,
    ),
};

/**
 * Watch a catalogue sync.
 *
 * `start: true` begins one if it is not already running; otherwise this only
 * attaches. Either way, closing the stream just detaches this watcher — the
 * crawl is a background job on the server and keeps running through a refresh,
 * a tab change, or the browser being closed entirely.
 */
export function watchCatalogSync(
  platform: string,
  handlers: {
    start?: boolean;
    onProgress?: (p: SyncProgress) => void;
    onDone?: (r: { entryCount: number; pagesFetched: number; warnings: string[] } | null) => void;
    onError?: (message: string) => void;
  },
): () => void {
  const controller = new AbortController();

  void (async () => {
    try {
      const res = handlers.start
        ? await fetch(`/api/catalog/sync/${platform}`, { method: 'POST', signal: controller.signal })
        : await fetch(`/api/catalog/sync/${platform}/stream`, { signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`sync stream failed: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

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
          else if (event === 'idle') handlers.onDone?.(null);
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') handlers.onError?.((err as Error).message);
    }
  })();

  return () => controller.abort();
}

/** Backwards-compatible alias: starts a sync and watches it. */
export function syncCatalog(
  platform: string,
  handlers: {
    onProgress?: (p: SyncProgress) => void;
    onDone?: (r: { entryCount: number; pagesFetched: number; warnings: string[] } | null) => void;
    onError?: (message: string) => void;
  },
): () => void {
  return watchCatalogSync(platform, { ...handlers, start: true });
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
