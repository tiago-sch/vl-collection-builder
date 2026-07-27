/**
 * tsc only emits .js — the SQL migrations and JSON data files it references are
 * plain assets, so copy them into dist/ after a build.
 */
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const assets = [
  ['src/db/migrations', 'dist/db/migrations'],
  ['src/sources/defaults.json', 'dist/sources/defaults.json'],
  ['data/aliases.json', 'dist/data/aliases.json'],
];

for (const [from, to] of assets) {
  const dest = resolve(root, to);
  await mkdir(dirname(dest), { recursive: true });
  await cp(resolve(root, from), dest, { recursive: true });
}

console.log(`copied ${assets.length} asset paths into dist/`);
