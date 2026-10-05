import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import {
  ExecutionManager, detectDesktopRuntime, nativeSeatbeltProfile,
  NATIVE_EXECUTION_DEFAULTS, createNativeAcquisitionProvider,
  type AcquisitionProvider, type AcquisitionCall,
} from '../src/execution.ts';

const signal = new AbortController().signal;
const echoSchema = { name: 'fixture', description: 'fixture', parameters: { type: 'object', properties: {} } };
async function fixtureWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'perseus-execution-test-'));
  await writeFile(join(root, 'input.txt'), 'authoritative');
  return root;
}

test('unknown providers are ineligible and have no shared execution fallback', async () => {
  const manager = new ExecutionManager({ routes: {} });
  assert.equal(manager.canExecute('remote_mutation'), false);
  await assert.rejects(manager.acquire({ toolName: 'remote_mutation', arguments: {}, workspace: '/', actorSchemas: [], signal }), /No independent provider/);
  await manager.settleClose();
});

test('every call gets an independent copy, full results, and cleanup without merge', async () => {
  const source = await fixtureWorkspace();
  const seen: string[] = [];
  const closed: string[] = [];
  const provider: AcquisitionProvider = {
    id: 'fixture', tools: ['fixture'],
    async create(scope) {
      seen.push(scope.isolatedWorkspace);
      assert.equal(await readFile(join(scope.isolatedWorkspace, 'input.txt'), 'utf8'), 'authoritative');
      return {
        isolation: { kind: 'provider-acquisition-scope', scopeId: scope.acquisitionId, independentWrites: true, network: 'provider-scoped' },
        async execute() {
          await writeFile(join(scope.isolatedWorkspace, 'input.txt'), 'speculative');
          return { isError: false, value: { complete: [1, 2, 3] }, content: [{ type: 'text', text: 'native projection' }], meta: { original: true } };
        },
        async close() { closed.push(scope.acquisitionId); },
      };
    },
  };
  const manager = new ExecutionManager({ routes: { fixture: 'fixture' }, providers: [provider] });
  try {
    const call: AcquisitionCall = { toolName: 'fixture', arguments: {}, workspace: source, actorSchemas: [echoSchema], signal };
    const outcomes = await Promise.all([manager.acquire(call), manager.acquire(call)]);
    assert.notEqual(seen[0], seen[1]);
    assert.deepEqual(outcomes[0]!.result.value, { complete: [1, 2, 3] });
    assert.deepEqual(outcomes[0]!.result.meta, { original: true });
    assert.equal(outcomes[0]!.provenance.merged, false);
    assert.ok(outcomes[0]!.provenance.snapshotStartedAt <= outcomes[0]!.provenance.snapshotFinishedAt);
    assert.equal(await readFile(join(source, 'input.txt'), 'utf8'), 'authoritative');
    assert.equal(closed.length, 2);
    for (const path of seen) assert.equal(existsSync(path), false);
  } finally { await manager.settleClose(); await rm(source, { recursive: true, force: true }); }
});

test('cancel joins the provider before deleting its independent workspace', async () => {
  const source = await fixtureWorkspace();
  let created!: () => void;
  const ready = new Promise<void>(accept => { created = accept; });
  let isolated = '';
  let closed = false;
  const provider: AcquisitionProvider = {
    id: 'blocked', tools: ['fixture'],
    async create(scope) {
      isolated = scope.isolatedWorkspace;
      return {
        isolation: { kind: 'provider-acquisition-scope', scopeId: scope.acquisitionId, independentWrites: true, network: 'provider-scoped' },
        async execute() {
          created();
          await new Promise((_accept, reject) => scope.signal.addEventListener('abort', () => reject(scope.signal.reason), { once: true }));
          throw new Error('unreachable');
        },
        async close() { assert.equal(existsSync(isolated), true); closed = true; },
      };
    },
  };
  const manager = new ExecutionManager({ routes: { fixture: 'blocked' }, providers: [provider] });
  const pending = manager.acquire({ toolName: 'fixture', arguments: {}, workspace: source, actorSchemas: [echoSchema], signal });
  const rejection = assert.rejects(pending);
  await ready;
  await manager.settleClose();
  await rejection;
  assert.equal(closed, true);
  assert.equal(existsSync(isolated), false);
  await rm(source, { recursive: true, force: true });
});

test('Seatbelt profile denies network, authoritative reads, and writes outside its private root', () => {
  const profile = nativeSeatbeltProfile({ sourceWorkspace: '/source', privateRoot: '/private-copy' });
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /\(deny file-read\* \(subpath "\/source"\)\)/);
  assert.deepEqual(NATIVE_EXECUTION_DEFAULTS, { cancellationGraceMs: 10000, stderrMaxChars: 16384 });
  for (const option of [{ cancellationGraceMs: 0 }, { cancellationGraceMs: 2_147_483_648 }, { maxResultBytes: -1 }, { stderrMaxChars: NaN }]) {
    assert.throws(() => createNativeAcquisitionProvider({ runtimeRoot: '/runtime', nodeExecutable: '/node', ...option }), /must be a positive safe integer/);
  }
});

const runtime = detectDesktopRuntime();
test('installed native read/write/edit/grep/glob/bash execute through independent Seatbelt hosts', {
  skip: process.platform !== 'darwin' || runtime === undefined || process.env.ELECTRON_RUN_AS_NODE !== '1'
    ? 'Run through the installed DSH Desktop Node carrier to access its packaged native tools' : false,
  timeout: 30_000,
}, async () => {
  const source = await fixtureWorkspace();
  const requireNative = createRequire(join(runtime!.runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  const load = async (suffix: string) => import(pathToFileURL(requireNative.resolve(`@deepseek-ai/${suffix}`)).href);
  const { Context } = await load('cordis');
  const ctx = new Context();
  for (const [suffix, config] of [
    ['dsh-system-prompt', {}], ['dsh-tools', {}], ['dsh-fs-local', { cwd: source }],
    ['dsh-subprocess-local', {}], ['dsh-bash-local', { cwd: source, graceMs: 500 }],
    ['dsh-shell-env', {}], ['dsh-tool-fs', {}], ['dsh-tool-fs-search', { sampleOverCapGlobResults: false }], ['dsh-tool-bash', {}],
  ] as const) { const plugin = await load(suffix); await ctx.plugin(plugin.default ?? plugin, config); }
  const manager = new ExecutionManager(runtime!);
  const acquire = (toolName: string, args: unknown) => manager.acquire({ toolName, arguments: args, workspace: source, actorSchemas: ctx.tools.schemas(), outputSchema: ctx.tools.get(toolName)?.output.schema, signal });
  try {
    const read = await acquire('read', { file_path: join(source, 'input.txt') });
    assert.equal(read.result.isError, false);
    assert.ok(JSON.stringify(read.result.value).includes('authoritative'));
    const write = await acquire('write', { file_path: 'new-file.txt', content: 'speculative' });
    assert.equal(write.result.isError, false);
    assert.equal((write.result.value as { after: string }).after, 'speculative');
    assert.equal(existsSync(join(source, 'new-file.txt')), false);
    // The successful read above belonged to another acquisition's session and
    // copied file identities. It cannot satisfy this host's observation gate.
    const existingWrite = await acquire('write', { file_path: 'input.txt', content: 'speculative' });
    assert.ok(existingWrite.result.isError);
    assert.equal(existingWrite.result.error?.info?.code, 'FS_NOT_OBSERVED');
    assert.equal(await readFile(join(source, 'input.txt'), 'utf8'), 'authoritative');
    const edit = await acquire('edit', { file_path: 'input.txt', old_string: 'authoritative', new_string: 'speculative edit' });
    assert.ok(edit.result.isError);
    assert.equal(edit.result.error?.info?.code, 'FS_NOT_OBSERVED');
    assert.ok(JSON.stringify(edit.result.content).includes('file has not been read'));
    assert.equal(await readFile(join(source, 'input.txt'), 'utf8'), 'authoritative');
    const grep = await acquire('grep', { pattern: 'authoritative', path: source });
    assert.equal(grep.result.isError, false);
    assert.ok(JSON.stringify(grep.result.value).includes('authoritative'));
    const glob = await acquire('glob', { pattern: '*.txt', path: source });
    assert.equal(glob.result.isError, false);
    assert.ok((glob.result.value as { paths: string[] }).paths.includes('input.txt'));
    const independent = await acquire('read', { file_path: 'input.txt' });
    assert.ok(JSON.stringify(independent.result.value).includes('authoritative'));
    const bash = await acquire('bash', { command: 'printf copy > created.txt; printf complete', description: 'Test independent native shell execution' });
    assert.equal(bash.result.isError, false);
    assert.ok(JSON.stringify(bash.result.value).includes('complete'));
    assert.equal(existsSync(join(source, 'created.txt')), false);
    const background = await acquire('bash', { command: 'sleep 30 >/dev/null 2>&1 & printf "child:%s" "$!"', description: 'Check cleanup of an opaque command background child' });
    assert.equal(background.result.isError, false);
    const childPid = Number(JSON.stringify(background.result.value).match(/child:(\d+)/)?.[1]);
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
    assert.throws(() => process.kill(childPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
    const absolute = await acquire('bash', { command: `cat '${join(source, 'input.txt')}'`, description: 'Check original workspace read denial' });
    assert.ok(JSON.stringify(absolute.result.value).includes('Operation not permitted'));
    const absoluteWrite = await acquire('bash', { command: `printf forbidden > '${join(source, 'input.txt')}'`, description: 'Check original workspace write denial' });
    assert.ok(JSON.stringify(absoluteWrite.result.value).includes('Operation not permitted'));
    assert.equal(await readFile(join(source, 'input.txt'), 'utf8'), 'authoritative');
    const outside = await fixtureWorkspace();
    try {
      const hardlink = await acquire('bash', { command: `ln '${join(outside, 'input.txt')}' ./alias.txt && printf forbidden > ./alias.txt`, description: 'Check hardlink cannot escape write boundary' });
      assert.equal(await readFile(join(outside, 'input.txt'), 'utf8'), 'authoritative');
      assert.notEqual((hardlink.result.value as { exitCode: number }).exitCode, 0);
    } finally { await rm(outside, { recursive: true, force: true }); }
    let connections = 0;
    const server = createServer(socket => { connections++; socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'); });
    await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
    try {
      const port = (server.address() as { port: number }).port;
      const network = await acquire('bash', { command: `/usr/bin/curl --max-time 2 http://127.0.0.1:${port}`, description: 'Check acquisition network denial' });
      assert.equal(connections, 0);
      assert.equal(network.result.isError, false);
      assert.notEqual((network.result.value as { exitCode: number }).exitCode, 0);
    } finally { await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); }
    const abort = new AbortController();
    const started = Date.now();
    const pending = manager.acquire({ toolName: 'bash', arguments: { command: 'sleep 30', description: 'Check native cancellation cleanup' }, workspace: source, actorSchemas: ctx.tools.schemas(), signal: abort.signal });
    setTimeout(() => abort.abort(new Error('test cancel')), 200);
    const canceled = await pending;
    assert.equal(canceled.result.isError, true);
    assert.ok(Date.now() - started < 3000);
    const bounded = new ExecutionManager({ ...runtime!, maxResultBytes: 10, cancellationGraceMs: 1000, stderrMaxChars: 200 });
    try {
      await assert.rejects(bounded.acquire({ toolName: 'read', arguments: { file_path: 'input.txt' }, workspace: source, actorSchemas: ctx.tools.schemas(), signal }), /IPC limit/);
    } finally { await bounded.settleClose(); }
  } finally { await manager.settleClose(); await ctx.fiber.dispose(); await rm(source, { recursive: true, force: true }); }
});
