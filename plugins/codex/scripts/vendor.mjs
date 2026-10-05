import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('lib/vendor', { recursive: true });
await build({ entryPoints: ['scripts/vendor/schema-validator.mjs'], bundle: true,
  platform: 'node', format: 'cjs', target: 'node24', outfile: 'lib/schema-validator.cjs', legalComments: 'inline' });
for (const name of ['ajv', 'ajv-formats', 'fast-uri', 'fast-deep-equal', 'json-schema-traverse', 'require-from-string']) {
  const source = ['LICENSE', 'LICENSE.txt'].map(file => `node_modules/${name}/${file}`);
  let copied = false;
  for (const path of source) try { await copyFile(path, `lib/vendor/${name}-LICENSE`); copied = true; break; } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!copied) throw new Error(`Missing vendor license: ${name}`);
}
