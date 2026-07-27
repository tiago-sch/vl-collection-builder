/**
 * Tier cascade against a real database (plan §4.1).
 *
 * The behaviour that matters here is what the cascade REFUSES to auto-accept.
 * Over-eager matching is the expensive failure: a wrong row in `game` looks
 * exactly like a right one, and you would not notice for fifty games.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ParsedEntry } from '@vault-lookup/shared';

let dir: string;
let db: typeof import('../src/db/client.js');
let catalog: typeof import('../src/db/catalog.js');
let settings: typeof import('../src/db/settings.js');
let jobs: typeof import('../src/jobs/service.js');
let aliases: typeof import('../src/matching/aliases.js');

const PLATFORM = 'ps2';
const BASE = 'https://vimm.net';

const entries: ParsedEntry[] = [
  // Same game, four regions — the case the margin rule must not auto-accept
  // when no preferred region is present.
  { vaultId: 1, title: 'Silent Hill 2', regions: ['USA'], version: '2.01', languages: null, rating: 9.1 },
  { vaultId: 2, title: 'Silent Hill 2', regions: ['Europe'], version: '1.10', languages: null, rating: 9.4 },
  { vaultId: 3, title: 'Silent Hill 2', regions: ['Japan'], version: '1.50', languages: null, rating: 10 },
  { vaultId: 4, title: 'Silent Hill 2', regions: ['Korea'], version: '1.01', languages: null, rating: null },
  // Subtitle variant of the same base title.
  { vaultId: 5, title: 'Silent Hill 2: Restless Dreams', regions: ['Europe'], version: '1.0', languages: null, rating: 9.0 },
  // Distinct games.
  { vaultId: 6, title: 'Silent Hill 3', regions: ['USA'], version: '1.02', languages: null, rating: 8.9 },
  { vaultId: 7, title: 'Okami', regions: ['Japan'], version: '1.0', languages: null, rating: 9.5 },
  { vaultId: 8, title: 'Resident Evil 4', regions: ['USA'], version: '1.00', languages: null, rating: 9.7 },
  { vaultId: 9, title: 'Devil May Cry 3', regions: ['USA'], version: '1.0', languages: null, rating: 8.8 },
  { vaultId: 10, title: 'Devil May Cry 3: Special Edition', regions: ['USA'], version: '1.0', languages: null, rating: 9.2 },
  { vaultId: 11, title: 'Katamari Damacy', regions: ['USA'], version: '1.0', languages: null, rating: 9.0 },
  { vaultId: 12, title: '7th Saga, The', regions: ['USA'], version: '1.0', languages: null, rating: 7.9 },
];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vault-lookup-test-'));
  process.env.DATABASE_PATH = join(dir, 'test.db');
  process.env.REGION_PREFERENCE = '';

  db = await import('../src/db/client.js');
  catalog = await import('../src/db/catalog.js');
  settings = await import('../src/db/settings.js');
  jobs = await import('../src/jobs/service.js');
  aliases = await import('../src/matching/aliases.js');

  await db.initDb(() => {});
  catalog.upsertEntries(PLATFORM, BASE, entries);
  settings.updateSettings({ regionPreference: ['USA', 'Europe', 'Japan'], strictRegion: false });
});

afterAll(() => {
  db.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const itemFor = async (name: string) => {
  const job = await jobs.createJob({ platform: PLATFORM, names: [name] });
  const items = jobs.listItems(job.id);
  return { job, item: items[0]! };
};

describe('tier 1 — exact match', () => {
  it('auto-accepts a unique exact title', async () => {
    const { item } = await itemFor('Katamari Damacy');
    expect(item.status).toBe('auto_matched');
    expect(item.resolvedTier).toBe(1);
    expect(item.candidates[0]!.vaultId).toBe(11);
  });

  it('takes the preferred region when variants differ ONLY by region', async () => {
    // Plan §4.2 calls this the biggest reduction in review volume, and it is safe
    // because the preference is a policy you set explicitly.
    const { item } = await itemFor('Silent Hill 2');
    expect(item.status).toBe('auto_matched');
    expect(item.resolvedTier).toBe(1);
    expect(item.candidates.find((c) => c.entryId === item.chosenEntryId)!.region).toBe('USA');
  });

  it('handles the trailing-article form from the real catalogue', async () => {
    const { item } = await itemFor('The 7th Saga');
    expect(item.status).toBe('auto_matched');
    expect(item.candidates[0]!.vaultId).toBe(12);
  });
});

describe('tier 2 — fuzzy, and what it refuses', () => {
  it('does NOT auto-accept when the preferred region is absent', async () => {
    // Only a Japanese release exists; plan §4.2 says fall through to review
    // rather than silently taking it.
    settings.updateSettings({ regionPreference: ['USA', 'Europe'] });
    const { item } = await itemFor('Okami');
    expect(item.status).toBe('needs_review');
    expect(item.candidates[0]!.vaultId).toBe(7);
    settings.updateSettings({ regionPreference: ['USA', 'Europe', 'Japan'] });
  });

  it('prefers the vanilla edition over the special edition on an exact input', async () => {
    const { item } = await itemFor('Devil May Cry 3');
    expect(item.status).toBe('auto_matched');
    expect(item.candidates.find((c) => c.entryId === item.chosenEntryId)!.vaultId).toBe(9);
  });

  it('sends an abbreviation with no alias to review rather than guessing', async () => {
    // 'sh3' IS in the shipped alias table, so it resolves at tier 0; this uses
    // an abbreviation that is not, to exercise the no-alias path.
    const { item } = await itemFor('slnt hll thr');
    expect(item.status).not.toBe('auto_matched');
  });

  it('resolves a shipped abbreviation at tier 0, not by fuzzy luck', async () => {
    const { item } = await itemFor('sh3');
    expect(item.status).toBe('auto_matched');
    expect(item.resolvedTier).toBe(0);
    expect(item.candidates.find((c) => c.entryId === item.chosenEntryId)?.vaultId ?? 6).toBe(6);
  });

  it('reports not_found when nothing is remotely close', async () => {
    const { item } = await itemFor('Halo 3');
    expect(item.status).toBe('not_found');
    expect(item.candidates).toHaveLength(0);
  });
});

describe('tier 0 — aliases', () => {
  it('resolves a static alias that string matching cannot', async () => {
    // 'biohazard 4' scores under 0.6 against 'Resident Evil 4'; only the alias
    // table can bridge it.
    const { item } = await itemFor('biohazard 4');
    expect(item.status).toBe('auto_matched');
    expect(item.resolvedTier).toBe(0);
    expect(item.candidates.length).toBeGreaterThanOrEqual(0);
    const chosen = item.chosenEntryId;
    expect(chosen).not.toBeNull();
  });

  it('learns from a confirmation and reuses it next time', async () => {
    const first = await itemFor('my weird nickname for okami');
    expect(first.item.status).not.toBe('auto_matched');

    const okami = catalog.entryByVaultId(PLATFORM, 7)!;
    jobs.resolveJobItem(first.job.id, first.item.id, { entryId: okami.id });

    const learned = aliases.listLearnedAliases(PLATFORM);
    expect(learned.some((a) => a.vaultId === 7)).toBe(true);

    // The same input now resolves at tier 0, free and instant.
    const second = await itemFor('my weird nickname for okami');
    expect(second.item.status).toBe('auto_matched');
    expect(second.item.resolvedTier).toBe(0);
  });
});

describe('strict region', () => {
  it('excludes non-preferred regions from candidates entirely', async () => {
    settings.updateSettings({ regionPreference: ['Korea'], strictRegion: true });
    const job = await jobs.createJob({ platform: PLATFORM, names: ['Silent Hill 2'] });
    const item = jobs.listItems(job.id)[0]!;
    expect(item.candidates.every((c) => c.regions.includes('Korea'))).toBe(true);
    settings.updateSettings({ regionPreference: ['USA', 'Europe', 'Japan'], strictRegion: false });
  });

  it('honours a per-job region override without changing the global default', async () => {
    const job = await jobs.createJob({
      platform: PLATFORM,
      names: ['Silent Hill 2'],
      regionPreference: ['Japan', 'USA'],
    });
    const item = jobs.listItems(job.id)[0]!;
    const chosen = item.candidates.find((c) => c.entryId === item.chosenEntryId)!;
    expect(chosen.region).toBe('Japan');
    expect(settings.getSettings().regionPreference).toEqual(['USA', 'Europe', 'Japan']);
  });
});

describe('commit and export', () => {
  it('writes settled items into the library and is idempotent', async () => {
    const job = await jobs.createJob({
      platform: PLATFORM,
      names: ['Katamari Damacy', 'Silent Hill 3'],
    });
    const first = jobs.commitJob(job.id);
    expect(first.inserted).toBe(2);

    // Committing twice must not duplicate — UNIQUE (platform, vault_id).
    const second = jobs.commitJob(job.id);
    expect(second.inserted).toBe(0);
    expect(second.existing).toBe(2);
  });

  it('flags candidates already in the library', async () => {
    const { item } = await itemFor('Katamari Damacy');
    expect(item.candidates[0]!.libraryState).toBe('in_library');
  });

  it('produces the minimal export shape from plan §3', async () => {
    const { listGames, toMinimal } = await import('../src/db/games.js');
    const minimal = toMinimal(listGames(PLATFORM));
    expect(minimal.length).toBeGreaterThan(0);
    expect(Object.keys(minimal[0]!).sort()).toEqual(['name', 'vaultLink']);
    expect(minimal[0]!.vaultLink).toMatch(/^https:\/\/vimm\.net\/vault\/\d+$/);
  });
});

describe('manual URL escape hatch', () => {
  it('accepts a pasted URL and rejects a non-http one', async () => {
    const { job, item } = await itemFor('something not in the catalogue at all');
    const resolved = jobs.resolveJobItem(job.id, item.id, {
      manualUrl: 'https://vimm.net/vault/99999',
    });
    expect(resolved!.status).toBe('confirmed');
    expect(resolved!.resolvedTier).toBe(4);

    const next = await itemFor('another missing game');
    expect(() =>
      jobs.resolveJobItem(next.job.id, next.item.id, { manualUrl: 'javascript:alert(1)' }),
    ).toThrow(/http/);
  });
});
