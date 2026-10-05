import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, link, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionManager, normalizeAction, seatbeltProfile } from '../src/execution.mjs';
import { RpcClient } from '../src/rpc.mjs';
import { createServer } from 'node:net';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const bundledDependencies = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies');
const pythonRoot = join(bundledDependencies, 'python'), python = join(pythonRoot, 'bin', 'python3');
const trustedRuntimeRoots = [pythonRoot];
async function assertProcessGone(pid) {
  assert(Number.isInteger(pid) && pid > 0);
  for (let n = 0; n < 100; n++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(10);
  }
  assert.fail('A native acquisition descendant survived command completion');
}
async function fixture(t, { cleanup = true } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'perseus-codex-execution-test-')));
  if (cleanup) t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source'), tempRoot = join(root, 'private');
  await mkdir(sourceRoot); await mkdir(tempRoot); await writeFile(join(sourceRoot, 'alpha.txt'), '中文 😀 needle\n');
  return { root, sourceRoot, tempRoot };
}

class OfflineCommandClient {
  listeners = new Set(); calls = [];
  onNotification(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(params) { for (const fn of this.listeners) fn({ method: 'command/exec/outputDelta', params }); }
  request(method, params) {
    this.calls.push({ method, params });
    assert.equal(method, 'command/exec');
    const env = { ...process.env };
    for (const [k, v] of Object.entries(params.env)) { if (v === null) delete env[k]; else env[k] = v; }
    return new Promise(resolve => execFile(params.command[0], params.command.slice(1), {
      cwd: params.cwd, env, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      for (const [stream, bytes] of [['stdout', stdout], ['stderr', stderr]]) {
        // Deliberately split in the middle of a UTF-8 character.
        for (const chunk of [bytes.subarray(0, 1), bytes.subarray(1)]) this.emit({ processId: params.processId, stream, deltaBase64: chunk.toString('base64'), capReached: false });
      }
      resolve({ exitCode: typeof error?.code === 'number' ? error.code : error ? 128 : 0, stdout: '', stderr: '' });
    }));
  }
}

test('canonical action identity and unsupported tools fail closed', () => {
  assert.deepEqual(normalizeAction({ tool: 'grep', arguments: { pattern: '-needle' } }), { tool: 'grep', arguments: { pattern: '-needle', path: '.' } });
  assert.throws(() => normalizeAction({ tool: 'bash', arguments: { command: 'true' } }), { code: 'UNSUPPORTED_ACTION' });
  assert.throws(() => normalizeAction({ tool: 'read', arguments: { path: 'bad\0path' } }), { code: 'INVALID_ACTION' });
  assert.deepEqual(normalizeAction({ tool: 'command_exec', arguments: { command: ['node', '-e', '1'] } }), { tool: 'command_exec', arguments: { command: ['node', '-e', '1'], cwd: '.' } });
  for (const command of [[], [''], ['node', 'bad\0arg'], 'echo unsafe'])
    assert.throws(() => normalizeAction({ tool: 'command_exec', arguments: { command } }), { code: 'INVALID_ACTION' });
  assert.throws(() => normalizeAction({ tool: 'exec_command', arguments: { cmd: 'echo unsafe' } }), { code: 'UNSUPPORTED_ACTION' });
});

test('fresh independent copies, fixed read/grep/glob argv, full UTF-8 output and no merge', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t), client = new OfflineCommandClient(), manager = new ExecutionManager({ ...f, client });
  await writeFile(join(f.sourceRoot, 'zeta.txt'), 'zeta needle\n');
  const first = await manager.acquire({ tool: 'read', arguments: { path: 'alpha.txt' } });
  assert.equal(first.result.stdout, '中文 😀 needle\n'); assert.equal(first.result.exitCode, 0);
  assert.equal(first.receipt.merged, false); assert(first.receipt.snapshotFinishedAt >= first.receipt.snapshotStartedAt);
  await writeFile(join(f.sourceRoot, 'alpha.txt'), 'next needle\n');
  const second = await manager.acquire({ tool: 'grep', arguments: { pattern: 'needle', path: '.' } });
  const third = await manager.acquire({ tool: 'glob', arguments: { pattern: '*.txt', path: '.' } });
  assert(second.result.stdout.includes('next needle')); assert(third.result.stdout.includes('alpha.txt'));
  assert.deepEqual(third.result.stdout.trim().split('\n'), ['./alpha.txt', './zeta.txt']);
  assert.notEqual(first.receipt.independentRoot, second.receipt.independentRoot);
  assert.equal(await readFile(join(f.sourceRoot, 'alpha.txt'), 'utf8'), 'next needle\n');
  assert.deepEqual(await readdir(f.tempRoot), []);
  for (const { params } of client.calls) {
    assert.equal(params.command[0], '/usr/bin/sandbox-exec'); assert.equal(params.disableOutputCap, true);
    assert.equal(params.sandboxPolicy.type, 'externalSandbox'); assert.equal(params.sandboxPolicy.networkAccess, 'restricted');
    assert.equal(params.streamStdoutStderr, true); assert.equal(params.env.RIPGREP_CONFIG_PATH, null);
  }
  for (const { params } of client.calls.slice(1)) assert.deepEqual(params.command.slice(params.command.indexOf('--sort'), params.command.indexOf('--sort') + 2), ['--sort', 'path']);
  await manager.settleClose();
});

test('path escapes, symlinks and outside hardlinks are rejected before execution', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t), client = new OfflineCommandClient(), manager = new ExecutionManager({ ...f, client });
  await assert.rejects(manager.acquire({ tool: 'read', arguments: { path: '../outside' } }), { code: 'PATH_ESCAPE' });
  await symlink(join(f.sourceRoot, 'alpha.txt'), join(f.sourceRoot, 'alias'));
  await assert.rejects(manager.acquire({ tool: 'read', arguments: { path: 'alpha.txt' } }), { code: 'UNSAFE_WORKSPACE' });
  await rm(join(f.sourceRoot, 'alias')); await link(join(f.sourceRoot, 'alpha.txt'), join(f.root, 'outside-link'));
  await assert.rejects(manager.acquire({ tool: 'read', arguments: { path: 'alpha.txt' } }), { code: 'UNSAFE_WORKSPACE' });
  assert.equal(client.calls.length, 0); assert.deepEqual(await readdir(f.tempRoot), []);
});

test('typed commands run real Node tests and Python subprocesses only in a fresh copy with a scrubbed environment', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t), client = new OfflineCommandClient(), manager = new ExecutionManager({ ...f, client, trustedRuntimeRoots });
  await mkdir(join(f.sourceRoot, 'suite'));
  await writeFile(join(f.sourceRoot, 'suite', 'case.test.mjs'), 'import test from "node:test";import assert from "node:assert/strict";import fs from "node:fs";test("private scratch",()=>{fs.writeFileSync("scratch", "isolated");assert.equal(fs.readFileSync("scratch","utf8"),"isolated")});\n');
  const node = await manager.acquire({ tool: 'command_exec', arguments: { command: [process.execPath, '--test', '--test-isolation=none', 'case.test.mjs'], cwd: join(f.sourceRoot, 'suite') } });
  assert.equal(node.result.exitCode, 0, node.result.stderr); assert.match(node.result.stdout, /private scratch/);
  await assert.rejects(access(join(f.sourceRoot, 'suite', 'scratch')));
  const py = await manager.acquire({ tool: 'command_exec', arguments: { command: [python, '-c', 'import pathlib,subprocess,unittest;pathlib.Path("py-scratch").write_text("isolated");assert subprocess.run(["/bin/echo","python-child"],capture_output=True,text=True).stdout=="python-child\\n";print("python-ok")'] } });
  assert.deepEqual(py.result, { exitCode: 0, stdout: 'python-ok\n', stderr: '' }); await assert.rejects(access(join(f.sourceRoot, 'py-scratch')));
  const env = await manager.acquire({ tool: 'command_exec', arguments: { command: [process.execPath, '-e', 'console.log(JSON.stringify(Object.keys(process.env).sort()))'] } });
  assert.deepEqual(JSON.parse(env.result.stdout), ['HOME', 'LANG', 'OPENSSL_CONF', 'PATH', 'TEMP', 'TMP', 'TMPDIR']);
  assert(manager.canExecute('command_exec')); assert(!manager.canExecute('exec_command'));
  assert.match(seatbeltProfile({ privateRoot: '/private/example', sourceRoot: f.sourceRoot }), /\(deny default\)/);
  assert.deepEqual(await readdir(f.tempRoot), []); await manager.settleClose();
});

test('general commands deny original/HOME/outside reads, writes, TCP/Unix IPC and signals to another process', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t), client = new OfflineCommandClient(), manager = new ExecutionManager({ ...f, client });
  const homeProbe = await mkdtemp(join(homedir(), '.perseus-public-probe-')); t.after(() => rm(homeProbe, { recursive: true, force: true }));
  const homeFile = join(homeProbe, 'probe.txt'); await writeFile(homeFile, 'owned-test-data');
  const outsideFile = join(f.root, 'outside.txt'); await writeFile(outsideFile, 'owned-test-data');
  const ipcRoot = await mkdtemp('/private/tmp/perseus-ipc-probe-'), socket = join(ipcRoot, 's');
  const server = createServer(connection => connection.destroy()); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(ipcRoot, { recursive: true, force: true }); });
  const outsider = spawn('/bin/sleep', ['30'], { stdio: 'ignore' }); t.after(() => { try { process.kill(outsider.pid, 'SIGKILL'); } catch {} });
  const script = 'const fs=require("node:fs"),net=require("node:net");const [original,home,outside,write,pid,socket]=process.argv.slice(1);const out={};for(const [name,fn] of Object.entries({original:()=>fs.readFileSync(original),home:()=>fs.readFileSync(home),outside:()=>fs.readFileSync(outside),write:()=>fs.writeFileSync(write,"bad"),signal:()=>process.kill(Number(pid),"SIGTERM")})){try{fn();out[name]="ALLOWED"}catch(e){out[name]=e.code}}Promise.all([new Promise(r=>net.connect(80,"127.0.0.1").on("error",e=>{out.tcp=e.code;r()})),new Promise(r=>net.connect(socket).on("error",e=>{out.ipc=e.code;r()}))]).then(()=>console.log(JSON.stringify(out)))';
  const outcome = await manager.acquire({ tool: 'command_exec', arguments: { command: [process.execPath, '-e', script, join(f.sourceRoot, 'alpha.txt'), homeFile, outsideFile, join(f.root, 'must-not-exist'), String(outsider.pid), socket] } });
  assert.equal(outcome.result.exitCode, 0, outcome.result.stderr);
  const denied = JSON.parse(outcome.result.stdout);
  for (const name of ['original', 'home', 'outside', 'write', 'signal', 'tcp', 'ipc']) assert.match(denied[name], /^(EPERM|EACCES)$/, name);
  process.kill(outsider.pid, 0); await assert.rejects(access(join(f.root, 'must-not-exist')));
  await manager.settleClose();
});

test('session/group detachment and posix_spawn are denied rather than permitting untracked daemons', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t), client = new OfflineCommandClient(), manager = new ExecutionManager({ ...f, client, trustedRuntimeRoots });
  const detached = await manager.acquire({ tool: 'command_exec', arguments: { command: [process.execPath, '-e', 'try{require("node:child_process").spawn("/bin/sleep",["30"],{detached:true,stdio:"ignore"});throw Error("ALLOWED")}catch(e){if(e.code!=="EPERM")throw e;console.log(e.code)}'] } });
  assert.deepEqual(detached.result, { exitCode: 0, stdout: 'EPERM\n', stderr: '' });
  const groups = await manager.acquire({ tool: 'command_exec', arguments: { command: [python, '-c', 'import os,json;out={}\nfor name,fn in [("setsid",os.setsid),("setpgid",lambda:os.setpgid(0,0))]:\n try:fn();out[name]="ALLOWED"\n except PermissionError:out[name]="EPERM"\nprint(json.dumps(out))'] } });
  assert.equal(groups.result.exitCode, 0, groups.result.stderr); assert.deepEqual(JSON.parse(groups.result.stdout), { setsid: 'EPERM', setpgid: 'EPERM' });
  await manager.settleClose();
});

test('terminate acknowledgement does not release a copy before native completion', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t); let finish, command, terminated = false;
  const client = { onNotification: () => () => {}, request(method, params) {
    if (method === 'command/exec') { command = params; return new Promise(resolve => { finish = resolve; }); }
    assert.equal(method, 'command/exec/terminate'); terminated = true; return Promise.resolve({});
  } };
  const manager = new ExecutionManager({ ...f, client, cancellationGraceMs: 1000 }), abort = new AbortController();
  const work = manager.acquire({ tool: 'read', arguments: { path: 'alpha.txt' } }, { signal: abort.signal });
  const rejected = assert.rejects(work, { code: 'ABORTED' });
  while (!command) await delay(5); abort.abort(); await delay(20); assert(terminated); await access(command.cwd);
  assert.equal(manager.pendingAcquisitions, 1); finish({ exitCode: 143, stdout: '', stderr: '' }); await rejected;
  assert.deepEqual(await readdir(f.tempRoot), []); await manager.settleClose();
});

test('unconfirmed cancellation retains the private copy and reports a cleanup failure', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t); let finish, command;
  const client = { onNotification: () => () => {}, request(method, params) {
    if (method === 'command/exec') { command = params; return new Promise(resolve => { finish = resolve; }); }
    return Promise.resolve({});
  } };
  const manager = new ExecutionManager({ ...f, client, cancellationGraceMs: 20 }), abort = new AbortController();
  const work = manager.acquire({ tool: 'read', arguments: { path: 'alpha.txt' } }, { signal: abort.signal });
  const rejected = assert.rejects(work, { code: 'CLEANUP_UNCONFIRMED' });
  while (!command) await delay(5); abort.abort(); await rejected; await access(command.cwd);
  await assert.rejects(manager.settleClose(), { code: 'CLEANUP_UNCONFIRMED' }); finish({ exitCode: 143, stdout: '', stderr: '' });
});

test('bundled Codex command/exec streams complete results and confirms real cancellation', {
  skip: process.platform !== 'darwin' || process.env.PERSEUS_CODEX_NATIVE_SMOKE !== '1',
}, async t => {
  const f = await fixture(t, { cleanup: false });
  await writeFile(join(f.sourceRoot, 'zeta.txt'), 'zeta needle\n');
  const client = await RpcClient.create({ configOverrides: {
    'features.hooks': false, 'features.apps': false, 'features.multi_agent': false,
  } });
  const manager = new ExecutionManager({ ...f, client, trustedRuntimeRoots });
  t.after(async () => { await manager.settleClose().catch(() => {}); await client.close(); await rm(f.root, { recursive: true, force: true }); });
  const request = client.request.bind(client), nativeResults = [], terminateReplies = [];
  client.request = (method, params, options) => {
    const response = request(method, params, options);
    if (method === 'command/exec/terminate') terminateReplies.push(response);
    return response.then(result => { if (method === 'command/exec') nativeResults.push(result); return result; });
  };
  const read = await manager.acquire({ tool: 'read', arguments: { path: 'alpha.txt' } });
  assert.deepEqual(read.result, { exitCode: 0, stdout: '中文 😀 needle\n', stderr: '' });
  const grep = await manager.acquire({ tool: 'grep', arguments: { pattern: 'needle', path: '.' } });
  assert.equal(grep.result.stdout, './alpha.txt:1:中文 😀 needle\n./zeta.txt:1:zeta needle\n');
  const glob = await manager.acquire({ tool: 'glob', arguments: { pattern: '*.txt', path: '.' } });
  assert.equal(glob.result.stdout, './alpha.txt\n./zeta.txt\n');
  await writeFile(join(f.sourceRoot, 'command.test.mjs'), 'import test from "node:test";import assert from "node:assert/strict";import fs from "node:fs";test("native copy",()=>{fs.writeFileSync("scratch","isolated");assert.equal(fs.readFileSync("scratch","utf8"),"isolated")});\n');
  const command = await manager.acquire({ tool: 'command_exec', arguments: { command: [process.execPath, '--test', '--test-isolation=none', 'command.test.mjs'] } });
  assert.equal(command.result.exitCode, 0, command.result.stderr); assert.match(command.result.stdout, /native copy/);
  await assert.rejects(access(join(f.sourceRoot, 'scratch')));
  const background = await manager.acquire({ tool: 'command_exec', arguments: { command: [python, '-c', 'import os,subprocess;child=subprocess.Popen(["/bin/sleep","30"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);print(child.pid,flush=True);os._exit(0)'] } });
  assert.equal(background.result.exitCode, 0, background.result.stderr);
  await assertProcessGone(Number(background.result.stdout.trim()));
  const commandAbort = new AbortController(); let childOutput = '';
  const offChild = client.onNotification(({ method, params }) => {
    if (method === 'command/exec/outputDelta' && params.stream === 'stdout') {
      childOutput += Buffer.from(params.deltaBase64, 'base64').toString('utf8');
      if (childOutput.includes('\n')) commandAbort.abort();
    }
  });
  await assert.rejects(manager.acquire({ tool: 'command_exec', arguments: { command: [python, '-c', 'import subprocess,time;child=subprocess.Popen(["/bin/sleep","30"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);print(child.pid,flush=True);time.sleep(30)'] } }, { signal: commandAbort.signal }), { code: 'ABORTED' });
  offChild(); await assertProcessGone(Number(childOutput.trim()));
  const large = await open(join(f.sourceRoot, 'large.bin'), 'w');
  await large.truncate(64 * 1024 * 1024); await large.close();
  const abort = new AbortController(); let streamed = false;
  const off = client.onNotification(({ method, params }) => {
    if (method === 'command/exec/outputDelta' && params.stream === 'stdout' && !streamed) { streamed = true; abort.abort(); }
  });
  await assert.rejects(manager.acquire({ tool: 'read', arguments: { path: 'large.bin' } }, { signal: abort.signal }), { code: 'ABORTED' });
  off(); assert(streamed); assert.equal(terminateReplies.length, 2); await Promise.all(terminateReplies);
  assert.notEqual(nativeResults.at(-1).exitCode, 0);
  for (const result of nativeResults) { assert.equal(result.stdout, ''); assert.equal(result.stderr, ''); }
  assert.deepEqual(await readdir(f.tempRoot), []); assert.equal(manager.retainedRoots.size, 0);
  assert.deepEqual(await manager.settleClose(), { quiescent: true, pendingAcquisitions: 0 });
  assert.deepEqual(await client.close(), { quiescent: true });
});
