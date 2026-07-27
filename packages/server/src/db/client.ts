/**
 * SQLite access via node:sqlite (plan §7).
 *
 * Using the built-in driver instead of better-sqlite3 removes the native build
 * step, so the image has no python3/make/g++ and is architecture-portable.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, settingDefaults } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) throw new Error('database not initialised — call initDb() first');
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Applies any migration files not yet recorded, in filename order.
 * Each runs inside a transaction so a failure leaves no half-applied schema.
 */
async function migrate(database: DatabaseSync): Promise<string[]> {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const dir = resolve(here, 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  const applied = new Set(
    database
      .prepare('SELECT name FROM schema_migration')
      .all()
      .map((r) => r.name as string),
  );

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(resolve(dir, file), 'utf8');
    database.exec('BEGIN');
    try {
      database.exec(sql);
      database
        .prepare('INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)')
        .run(file, nowIso());
      database.exec('COMMIT');
      ran.push(file);
    } catch (err) {
      database.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }
  return ran;
}

/** Inserts default settings rows, never overwriting a value already present. */
function seedSettings(database: DatabaseSync): void {
  const stmt = database.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING',
  );
  const ts = nowIso();
  for (const [key, value] of Object.entries(settingDefaults)) {
    stmt.run(key, value, ts);
  }
}

/**
 * Unattended setup: SETUP_SKIP=true plus a non-empty REGION_PREFERENCE completes
 * the wizard without a browser (plan §6.0). SETUP_SKIP alone is deliberately not
 * enough — silently defaulting the region is the failure the wizard exists to
 * prevent, so we log and let the wizard run instead.
 */
function maybeCompleteSetup(database: DatabaseSync, log: (m: string) => void): void {
  if (!config.setupSkip) return;

  const done = database.prepare("SELECT value FROM settings WHERE key = 'setup_completed_at'").get();
  if (done) return;

  if (config.regionPreference.length === 0) {
    log('SETUP_SKIP is set but REGION_PREFERENCE is empty — the first-run wizard will still run. Set REGION_PREFERENCE to complete setup unattended.');
    return;
  }

  database
    .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run('setup_completed_at', nowIso(), nowIso());
  log(`setup completed unattended with region preference ${config.regionPreference.join(' > ')}`);
}

export interface InitResult {
  migrationsRun: string[];
  path: string;
}

export async function initDb(log: (m: string) => void = console.log): Promise<InitResult> {
  await mkdir(dirname(config.databasePath), { recursive: true });

  const database = new DatabaseSync(config.databasePath);

  // WAL gives us concurrent reads during a sync write. foreign_keys is off by
  // default in SQLite and our ON DELETE CASCADEs depend on it.
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA synchronous = NORMAL');

  const migrationsRun = await migrate(database);
  seedSettings(database);
  maybeCompleteSetup(database, log);

  db = database;
  return { migrationsRun, path: config.databasePath };
}

export function closeDb(): void {
  db?.close();
  db = null;
}

/** Runs `fn` inside a transaction, rolling back if it throws. */
export function transaction<T>(fn: () => T): T {
  const database = getDb();
  database.exec('BEGIN');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}
