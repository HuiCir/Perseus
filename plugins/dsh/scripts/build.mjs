import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
await build({ entryPoints: ['src/index.ts'], outdir: 'dist', bundle: true,
  platform: 'node', format: 'esm', target: 'node22', packages: 'external', sourcemap: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--emitDeclarationOnly'], { stdio: 'inherit' });
for (const file of readdirSync('dist').filter(file => file.endsWith('.d.ts'))) {
  const path = `dist/${file}`;
  writeFileSync(path, readFileSync(path, 'utf8').replace(/(from ['"]\.\/[^'"]+)\.ts(['"])/g, '$1.js$2'));
}
