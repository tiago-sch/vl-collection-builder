/**
 * Matching evaluation (plan §4.5).
 *
 * `learned_alias` accumulates human-confirmed input -> entry pairs as an
 * ordinary side effect of using the review queue. That is a real labelled set,
 * produced for free, and it is what makes "is this tier earning its place?" an
 * answerable question rather than a matter of taste.
 *
 * Most "should I add AI here?" decisions never get an answer because nobody has
 * ground truth. This design generates it. When the phase 8 resolver lands, the
 * same harness replays the set with it on and off; if the delta is two
 * percentage points, turn it off and save the key.
 *
 *   npm run eval
 *   npm run eval -- --platform ps2 --verbose
 */
import { initDb, closeDb, getDb } from '../db/client.js';
import { allEntries } from '../db/catalog.js';
import { effectiveRegionBonus, getSettings } from '../db/settings.js';
import { resolveItem, type ResolveContext } from '../matching/resolve.js';
import { loadStaticAliases } from '../matching/aliases.js';

interface Labelled {
  platform: string;
  inputNorm: string;
  vaultId: number;
  title: string;
  source: string;
}

interface Outcome {
  label: Labelled;
  status: string;
  tier: number | null;
  predictedVaultId: number | null;
  correct: boolean;
}

function parseArgs(argv: string[]): { platform?: string; verbose: boolean } {
  const out: { platform?: string; verbose: boolean } = { verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--platform' && argv[i + 1]) out.platform = argv[i + 1];
    if (argv[i] === '--verbose' || argv[i] === '-v') out.verbose = true;
  }
  return out;
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await initDb(() => {});
  await loadStaticAliases();

  const rows = getDb()
    .prepare(
      `SELECT la.platform, la.input_norm, la.vault_id, la.source, ce.title
         FROM learned_alias la
         JOIN catalog_entry ce ON ce.id = la.entry_id
        ${args.platform ? 'WHERE la.platform = ?' : ''}
        ORDER BY la.platform, la.input_norm`,
    )
    .all(...(args.platform ? [args.platform] : [])) as unknown as Array<{
    platform: string;
    input_norm: string;
    vault_id: number;
    source: string;
    title: string;
  }>;

  const labels: Labelled[] = rows.map((r) => ({
    platform: r.platform,
    inputNorm: r.input_norm,
    vaultId: r.vault_id,
    title: r.title,
    source: r.source,
  }));

  if (labels.length === 0) {
    console.log(
      'No confirmed matches yet.\n\n' +
        'The evaluation set is built from your own review confirmations, so it fills\n' +
        'up as you use the tool. Run a few imports, confirm the ambiguous ones, and\n' +
        'come back — there is nothing to measure against until then.',
    );
    closeDb();
    return;
  }

  const settings = getSettings();
  const byPlatform = new Map<string, Labelled[]>();
  for (const l of labels) byPlatform.set(l.platform, [...(byPlatform.get(l.platform) ?? []), l]);

  const outcomes: Outcome[] = [];

  for (const [platform, group] of byPlatform) {
    const entries = allEntries(platform);
    const ctx: ResolveContext = {
      platform,
      entries,
      settings,
      regionPreference: settings.regionPreference,
      strictRegion: settings.strictRegion,
      regionBonus: effectiveRegionBonus(settings),
    };

    for (const label of group) {
      // Replay the ORIGINAL input, but with its own learned alias excluded —
      // otherwise every case resolves at tier 0 from the answer key and the
      // score is a meaningless 100%.
      const outcome = await resolveItemWithoutAlias(label, ctx);
      outcomes.push(outcome);
    }
  }

  // --- report --------------------------------------------------------------
  const settled = outcomes.filter((o) => o.status === 'auto_matched');
  const correct = outcomes.filter((o) => o.correct);
  const wrong = settled.filter((o) => !o.correct);

  console.log(`\nEvaluation set: ${outcomes.length} confirmed matches`);
  console.log(`  from your reviews : ${labels.filter((l) => l.source === 'user').length}`);
  console.log(`  from static table : ${labels.filter((l) => l.source === 'static').length}`);

  console.log('\nWithout the alias for each item (i.e. how it behaved the first time):');
  console.log(`  auto-resolved     : ${settled.length}  (${pct(settled.length, outcomes.length)})`);
  console.log(`  of those, correct : ${correct.length}  (${pct(correct.length, settled.length)})`);
  console.log(`  WRONG auto-match  : ${wrong.length}  (${pct(wrong.length, settled.length)})`);
  console.log(`  sent to review    : ${outcomes.length - settled.length}`);

  const byTier = new Map<string, number>();
  for (const o of settled) {
    const key = o.tier === null ? 'none' : String(o.tier);
    byTier.set(key, (byTier.get(key) ?? 0) + 1);
  }
  console.log('\nBy tier:');
  for (const [tier, n] of [...byTier].sort()) {
    const names: Record<string, string> = { '0': 'alias', '1': 'exact', '2': 'fuzzy', '3': 'llm' };
    console.log(`  tier ${tier} (${names[tier] ?? '?'}) : ${n}`);
  }

  if (wrong.length > 0) {
    console.log('\nWrong auto-matches — these are the expensive failures:');
    for (const o of wrong) {
      console.log(
        `  "${o.label.inputNorm}"\n     wanted vault/${o.label.vaultId} (${o.label.title})\n     got    vault/${o.predictedVaultId}`,
      );
    }
  }

  if (args.verbose) {
    console.log('\nEvery case:');
    for (const o of outcomes) {
      console.log(
        `  ${o.correct ? 'ok  ' : 'MISS'} tier ${o.tier ?? '-'} ${o.status.padEnd(13)} "${o.label.inputNorm}"`,
      );
    }
  }

  console.log(
    '\nThe resolver is not built (phase 8). When it is, run this with it on and\n' +
      'off: if auto-resolution moves by a couple of points, it is not worth a key.\n',
  );

  closeDb();
}

/** Resolve one label with its own learned alias temporarily removed. */
async function resolveItemWithoutAlias(label: Labelled, ctx: ResolveContext): Promise<Outcome> {
  interface AliasRow {
    id: number;
    platform: string;
    input_norm: string;
    entry_id: number;
    vault_id: number;
    source: string;
    confirmed_at: string;
  }

  const db = getDb();
  const saved = db
    .prepare('SELECT * FROM learned_alias WHERE platform = ? AND input_norm = ?')
    .get(label.platform, label.inputNorm) as unknown as AliasRow | undefined;

  db.prepare('DELETE FROM learned_alias WHERE platform = ? AND input_norm = ?').run(
    label.platform,
    label.inputNorm,
  );

  try {
    const result = await resolveItem(label.inputNorm, ctx);
    return {
      label,
      status: result.status,
      tier: result.tier,
      predictedVaultId: result.chosen?.vaultId ?? null,
      correct: result.chosen?.vaultId === label.vaultId,
    };
  } finally {
    if (saved) {
      db.prepare(
        `INSERT INTO learned_alias (id, platform, input_norm, entry_id, vault_id, source, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        saved.id,
        saved.platform,
        saved.input_norm,
        saved.entry_id,
        saved.vault_id,
        saved.source,
        saved.confirmed_at,
      );
    }
  }
}

main().catch((err) => {
  console.error('eval failed:', err);
  process.exit(1);
});
