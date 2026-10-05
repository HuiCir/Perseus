import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { RpcClient } from '../src/rpc.mjs';

function transport({ graceful = true, handshake = true, handle = () => {} } = {}) {
  const child = new EventEmitter(); child.pid = 123456789; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = [];
  child.reply = (id, result) => child.stdout.write(`${JSON.stringify({ id, result })}\n`);
  child.stdin = new Writable({ write(chunk, _, done) {
    for (const line of chunk.toString().trim().split('\n')) {
      const request = JSON.parse(line);
      if (request.method === 'initialize') { child.initialization = request; if (handshake) queueMicrotask(() => child.reply(request.id, { userAgent: 'test' })); }
      else handle(request, child);
    }
    done();
  } });
  child.stdin.on('finish', () => { if (graceful) queueMicrotask(() => child.emit('exit', 0, null)); });
  child.kill = signal => { child.kills.push(signal); queueMicrotask(() => child.emit('exit', null, signal)); return true; };
  return child;
}

test('owned stdio handshake, scoped config overrides, chunked notifications, and close', async () => {
  let spawnArgs, spawnOptions, initialization;
  const child = transport({ handle(request, child) {
    if (request.method === 'echo') {
      const frame = JSON.stringify({ method: 'thread/status/changed', params: { status: 'ready' } }) + '\n';
      child.stdout.write(frame.slice(0, 8)); child.stdout.write(frame.slice(8)); child.reply(request.id, request.params);
    }
  } });
  const originalWrite = child.stdin._write.bind(child.stdin);
  child.stdin._write = (chunk, enc, done) => { const obj = JSON.parse(chunk.toString()); if (obj.method === 'initialize') initialization = obj; originalWrite(chunk, enc, done); };
  const client = await RpcClient.create({ codexBin: '/fake/codex', versionProbe: async () => 'codex-cli 0.159.0-alpha.12.1',
    configOverrides: { 'features.hooks': false, 'features.apps': false, model: 'gpt-6-luna', mcp_servers: { 'a.b': { enabled: false } } },
    cwd: '/private/inference/model-room',
    spawnImpl: (_, args, options) => { spawnArgs = args; spawnOptions = options; return child; } });
  assert.equal(initialization.params.capabilities.experimentalApi, false);
  assert.deepEqual(spawnArgs.slice(-2), ['app-server', '--stdio']);
  assert(spawnArgs.includes('features.hooks=false')); assert(spawnArgs.includes('model="gpt-6-luna"'));
  assert(spawnArgs.includes('mcp_servers={ "a.b" = { "enabled" = false } }'));
  assert.equal(spawnOptions.cwd, '/private/inference/model-room');
  const notifications = []; const off = client.onNotification(n => notifications.push(n));
  assert.deepEqual(await client.request('echo', { value: 7 }), { value: 7 });
  assert.deepEqual(notifications, [{ method: 'thread/status/changed', params: { status: 'ready' } }]); off();
  assert.deepEqual(await client.close(), { quiescent: true });
  assert.equal(client.pending.size, 0); assert.equal(client.state, 'closed');
});

test('experimental APIs require explicit boolean opt-in', async () => {
  assert.throws(() => new RpcClient({ experimentalApi: 'true' }), TypeError);
  const child = transport();
  const client = await RpcClient.create({ codexBin: '/fake/codex', versionProbe: async () => 'codex-cli test',
    spawnImpl: () => child, experimentalApi: true });
  assert.equal(child.initialization.params.capabilities.experimentalApi, true); await client.close();
});

test('initialize deadline rejects a silent transport and retires its owned host', async () => {
  assert.throws(() => new RpcClient({ initializeTimeoutMs: 0 }), TypeError);
  const child = transport({ handshake: false });
  const client = new RpcClient({ codexBin: '/fake/codex', versionProbe: async () => 'codex-cli test',
    spawnImpl: () => child, initializeTimeoutMs: 10 });
  await assert.rejects(client.start(), { code: 'INITIALIZE_TIMEOUT' });
  assert.equal(client.state, 'closed'); assert.equal(client.pending.size, 0);
  assert.deepEqual(await client.close(), { quiescent: true });
});

test('a never-handshaking real process group exits before startup failure returns', { skip: process.platform === 'win32' }, async t => {
  const fixture = `
    const {spawn}=require('node:child_process');
    const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    process.stdout.write(JSON.stringify({method:'fixture/worker',params:{pid:worker.pid}})+'\\n');
    process.stdin.resume(); setInterval(()=>{},1000);`;
  let ownedHost, workerPid;
  const client = new RpcClient({ codexBin: '/fake/codex', versionProbe: async () => 'codex-cli fixture',
    initializeTimeoutMs: 100, shutdownGraceMs: 20,
    spawnImpl: (_, __, options) => { ownedHost = spawn(process.execPath, ['-e', fixture], options); return ownedHost; } });
  client.onNotification(({ method, params }) => { if (method === 'fixture/worker') workerPid = params.pid; });
  t.after(() => client.close());
  await assert.rejects(client.start(), { code: 'INITIALIZE_TIMEOUT' });
  assert.equal(client.state, 'closed'); assert(workerPid);
  assert.throws(() => process.kill(ownedHost.pid, 0), { code: 'ESRCH' });
  let gone = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(workerPid, 0); } catch (error) { if (error.code === 'ESRCH') { gone = true; break; } throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert(gone, 'the startup host child must also exit'); assert.equal(client.pending.size, 0);
});

test('aborting a waiter retains tracking until the native wire response', async () => {
  let held;
  const child = transport({ handle: request => { if (request.method === 'hold') held = request; } });
  const client = await RpcClient.create({ codexBin: '/fake/codex', versionProbe: async () => 'codex-cli test', spawnImpl: () => child });
  const abort = new AbortController(); const work = client.request('hold', {}, { signal: abort.signal }); abort.abort();
  await assert.rejects(work, { code: 'ABORTED' }); assert.equal(client.pending.size, 1);
  child.reply(held.id, {}); assert.equal(client.pending.size, 0); await client.close();
});

test('close escalates only the owned detached group, without publishing raw stderr', async () => {
  const child = transport({ graceful: false });
  const groupSignals = [];
  const client = await RpcClient.create({ codexBin: '/fake/codex', versionProbe: async () => 'codex-cli test', spawnImpl: () => child,
    shutdownGraceMs: 10, maxStderrChars: 96, platform: 'darwin', killImpl: (pid, signal) => {
      groupSignals.push({ pid, signal }); if (signal === 'SIGKILL') queueMicrotask(() => child.emit('exit', null, signal));
    } });
  child.stderr.write('Authorization: Bearer secret-value api_key=private-value sk-neverpublish');
  assert(!client.stderr.includes('secret-value')); assert(!client.stderr.includes('private-value')); assert(!client.stderr.includes('sk-neverpublish'));
  assert(client.stderr.length <= 96); await client.close(); assert.deepEqual(child.kills, []);
  assert.deepEqual(groupSignals, [{ pid: -child.pid, signal: 'SIGTERM' }, { pid: -child.pid, signal: 'SIGKILL' }]);
});

test('forced close stops a real same-group child and preserves an unrelated process', { skip: process.platform === 'win32' }, async t => {
  const idle = 'setInterval(()=>{},1000)';
  const unrelated = spawn(process.execPath, ['-e', idle], { stdio: 'ignore', detached: true });
  t.after(async () => { unrelated.kill('SIGKILL'); await new Promise(resolve => { if (unrelated.exitCode !== null || unrelated.signalCode !== null) resolve(); else unrelated.once('exit', resolve); }); });
  const server = `
    const {spawn}=require('node:child_process'); const {createInterface}=require('node:readline');
    const worker=spawn(process.execPath,['-e',${JSON.stringify(idle)}],{stdio:'ignore'});
    process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);
    createInterface({input:process.stdin}).on('line',line=>{
      const r=JSON.parse(line); if(r.id!==undefined) process.stdout.write(JSON.stringify({id:r.id,result:r.method==='initialize'?{userAgent:'fixture'}:{pid:worker.pid}})+'\\n');
    });`;
  const client = await RpcClient.create({ codexBin: '/fake/codex', versionProbe: async () => 'codex-cli fixture', shutdownGraceMs: 30,
    spawnImpl: (_, __, options) => spawn(process.execPath, ['-e', server], options) });
  t.after(() => client.close());
  const { pid } = await client.request('fixture/child', {});
  assert.deepEqual(await client.close(), { quiescent: true });
  let gone = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') { gone = true; break; } throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert(gone, 'the same-group child must exit'); process.kill(unrelated.pid, 0);
});

test('server-side requests fail closed and protocol errors contain no server payload', async () => {
  const requests = [];
  const child = transport({ handle: r => requests.push(r) });
  const client = await RpcClient.create({ codexBin: '/fake/codex', versionProbe: async () => 'codex-cli test', spawnImpl: () => child });
  child.stdout.write(JSON.stringify({ id: 'server-1', method: 'item/commandExecution/requestApproval', params: { command: 'private' } }) + '\n');
  assert.equal(requests.at(-1).error.code, -32601);
  const work = client.request('failure', {}); const id = requests.at(-1).id;
  child.stdout.write(JSON.stringify({ id, error: { code: -32000, message: 'sk-private' } }) + '\n');
  await assert.rejects(work, error => error.code === -32000 && !error.message.includes('sk-private')); await client.close();
});
