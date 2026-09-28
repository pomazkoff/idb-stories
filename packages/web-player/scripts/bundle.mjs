// Сборка самодостаточных бандлов веб-плеера:
//   dist/web-player.iife.js — для <script>, глобальный объект IdbStories;
//   dist/web-player.esm.js  — для <script type="module"> и бандлеров;
//   dist/styles.css         — стили (хост подключает через <link>).
// @idb-stories/schema/allowlist вшивается в бандл из исходников; zod в бандл попасть не должен.
import { build } from 'esbuild';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

/** @type {import('esbuild').BuildOptions} */
const common = {
  entryPoints: [path.join(root, 'src/index.ts')],
  bundle: true,
  minify: true,
  sourcemap: true,
  target: 'es2020',
  platform: 'browser',
  conditions: ['@idb-stories/source'],
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
};

const outputs = [
  { format: 'iife', globalName: 'IdbStories', outfile: path.join(dist, 'web-player.iife.js') },
  { format: 'esm', outfile: path.join(dist, 'web-player.esm.js') },
];

await mkdir(dist, { recursive: true });

// Запрещённые конструкции в итоговом коде (T3, раздел 10.6) — страховка поверх ESLint.
const FORBIDDEN = [
  /\.innerHTML\b/,
  /\.outerHTML\b/,
  /insertAdjacentHTML/,
  /document\.write/,
  /\beval\(/,
  /new Function\(/,
];

for (const output of outputs) {
  const result = await build({ ...common, ...output });
  const inputs = Object.keys(result.metafile.inputs);
  const leaked = inputs.filter((p) => /node_modules[\\/](\.pnpm[\\/])?zod/.test(p));
  if (leaked.length > 0) {
    throw new Error(`zod попал в бандл ${output.outfile}: ${leaked.join(', ')}`);
  }
  const code = await readFile(output.outfile, 'utf8');
  for (const re of FORBIDDEN) {
    if (re.test(code)) throw new Error(`Запрещённая конструкция ${re} в ${output.outfile}`);
  }
  const size = Buffer.byteLength(code);
  console.log(`${path.relative(root, output.outfile)}  ${(size / 1024).toFixed(1)} KB`);
}

await copyFile(path.join(root, 'src/styles.css'), path.join(dist, 'styles.css'));
console.log('dist/styles.css');
