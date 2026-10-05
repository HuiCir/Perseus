import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const portable = JSON.parse(await readFile(join(root, 'packaging/portable-plugin.json'), 'utf8'));
const compatibility = JSON.parse(await readFile(join(root, '.codex-plugin/plugin.json'), 'utf8'));
if (existsSync(join(root, 'plugin.json'))) throw new Error('This Codex compatibility package must not contain a root portable manifest.');
if (portable.name !== compatibility.name || portable.version !== compatibility.version) {
  throw new Error('Portable and compatibility plugin identity must match.');
}
if (!/^[a-z][a-z0-9-]*$/.test(portable.name) || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(portable.version)) {
  throw new Error('Plugin name or version is invalid.');
}
const out = resolve(process.argv[2] ?? join(root, 'dist'));
if (out === root || root.startsWith(`${out}/`)) throw new Error('Output must not contain the source package.');
await mkdir(out, { recursive: true });
const market = join(out, `perseus-marketplace-${portable.version}`);
const plugin = join(market, 'plugins', portable.name);
await rm(market, { recursive: true, force: true });
await mkdir(plugin, { recursive: true });
const items = ['.codex-plugin', '.mcp.json', 'hooks', 'scripts', 'lib', 'src', 'packaging', 'package.json', 'README.md', 'LICENSE'];
for (const item of items) {
  const source = join(root, item);
  if (!existsSync(source)) continue;
  await cp(source, join(plugin, item), {
    recursive: (await stat(source)).isDirectory(),
    filter: (path) => !/(?:^|\/)node_modules(?:\/|$)/.test(path),
  });
}
for (const required of ['scripts/hook.mjs', 'scripts/mcp.mjs', '.mcp.json', 'lib/schema-validator.cjs', 'hooks/hooks.json', '.codex-plugin/plugin.json']) {
  if (!existsSync(join(plugin, required))) throw new Error(`Missing package file: ${required}`);
}
await mkdir(join(market, '.agents', 'plugins'), { recursive: true });
await writeFile(join(market, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
  name: 'perseus-local',
  interface: { displayName: 'Perseus local plugins' },
  plugins: [{
    name: portable.name,
    source: { source: 'local', path: `./plugins/${portable.name}` },
    policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
    category: 'Productivity',
  }],
}, null, 2) + '\n');
const archive = join(out, `codex-plugin-${portable.name}-${portable.version}.tar.gz`);
const result = spawnSync('tar', ['-czf', archive, '-C', market, '.'], { encoding: 'utf8' });
if (result.status !== 0) throw new Error(result.stderr || 'tar failed');
const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(`${archive}.sha256`, `${sha256}  ${archive.split('/').at(-1)}\n`);
console.log(JSON.stringify({ archive, marketplace: market, sha256, layout: 'codex-compatibility' }));
