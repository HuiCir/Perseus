import { mkdir, readFile, writeFile, readdir, cp, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
await mkdir(out, { recursive: true });
const run = (binary, args, cwd = root) => execFileSync(binary, args, { cwd, stdio: 'inherit' });
run('/bin/bash', ['scripts/package-release.sh', join(out, 'Perseus-prototype-0.9.0.zip')], join(root, 'prototype'));
run(process.execPath, ['scripts/pack.mjs'], join(root, 'plugins/codex'));
await cp(join(root, 'plugins/codex/dist/codex-plugin-perseus-0.2.1.tar.gz'), join(out, 'codex-plugin-perseus-0.2.1.tar.gz'));
run('npm', ['run', 'build'], join(root, 'plugins/dsh'));
for (const component of ['dsh', 'dsh-ui', 'dsh-panel'])
  run('npm', ['pack', '--ignore-scripts', '--pack-destination', out], join(root, 'plugins', component));

const staging = await mkdtemp(join(tmpdir(), 'perseus-source-release-'));
try {
  const target = join(staging, 'Perseus');
  await cp(root, target, { recursive: true, filter: path => {
    const relative = path.slice(root.length).split('/').filter(Boolean);
    return !relative.some(part => ['.git', 'node_modules', 'dist', 'artifacts', 'live-results', '__pycache__', '.DS_Store',
      'auth.json', 'credentials.json', 'sessions'].includes(part) || part.startsWith('.env') || /\.(jsonl|log|pyc)$/.test(part));
  } });
  run('zip', ['-X', '-q', '-r', join(out, 'Perseus-source-2026.10.05.zip'), 'Perseus'], staging);
} finally { await rm(staging, { recursive: true, force: true }); }
const artifacts = [];
for (const file of (await readdir(out)).sort()) {
  if (!/\.(zip|tgz|tar\.gz)$/.test(file)) continue;
  const bytes = await readFile(join(out, file));
  artifacts.push({ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(join(out, 'SHA256SUMS'), artifacts.map(item => `${item.sha256}  ${item.file}`).join('\n') + '\n');
await writeFile(join(out, 'release-artifacts.json'), JSON.stringify({ release: 'bundle-2026.10.05', prerelease: true, artifacts }, null, 2) + '\n');
console.log(JSON.stringify({ out, artifacts: artifacts.map(item => item.file) }));
