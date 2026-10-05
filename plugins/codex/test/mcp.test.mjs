import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CommandMcpServer, MCP_BOOTSTRAP } from '../scripts/mcp.mjs';
import { COMMAND_TOOL } from '../src/tool-registry.mjs';
import { AppServer, codexBinary, command, configure, temporaryMarketplace } from './fixtures/native-harness.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const executeFile = promisify(execFile);
const call = (server, id, method, params) => server.handle({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const notify = (server, method, params) => server.handle({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
async function initialize(server) {
  const response = await call(server, 1, 'initialize', { protocolVersion: '2025-11-25',
    capabilities: {}, clientInfo: { name: 'offline-test', version: '1' } });
  assert.equal(response.result.protocolVersion, '2025-11-25');
  assert.equal(response.result.instructions, undefined, 'server does not inject task guidance');
  await notify(server, 'notifications/initialized');
  return response;
}
const outcome = (exitCode = 0) => ({ result: { exitCode, stdout: '中文 😀\n', stderr: 'full stderr\n' },
  receipt: { acquisitionId: 'fixture', independentRoot: '/tmp/fixture-copy', sourceRoot: '/tmp/fixture-source',
    merged: false, isolation: 'fixture', network: 'denied' } });

test('MCP initializes and lists the shared structured tool without starting a native host', async () => {
  let starts = 0;
  const server = new CommandMcpServer({ executorFactory: () => { starts++; throw new Error('must remain lazy'); } });
  assert.equal((await call(server, 0, 'tools/list')).error.code, -32000);
  await initialize(server);
  const listed = (await call(server, 2, 'tools/list')).result;
  assert.deepEqual(listed.tools, [{ name: COMMAND_TOOL.name, description: COMMAND_TOOL.description, inputSchema: COMMAND_TOOL.parameters,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }]);
  assert.deepEqual((await call(server, 3, 'ping')).result, {});
  assert.equal((await call(server, 4, 'tools/list', { cursor: 'unknown' })).error.code, -32602);
  assert.equal((await call(server, 5, 'tools/list', { unknown: true })).error.code, -32602);
  assert.equal((await call(server, 6, 'unknown')).error.code, -32601);
  assert.equal(starts, 0);
  assert.equal(await notify(server, 'notifications/cancelled', { requestId: {} }), undefined, 'malformed notification params have no response');
  assert.equal((await server.handle({ jsonrpc: '2.0', method: 'ping', unknown: true })).error.code, -32600);
  assert.deepEqual(await server.close(), { quiescent: true });
});

test('MCP validates arguments, keeps argv opaque, and returns the complete native result plus receipt', async () => {
  const acquired = []; let starts = 0, closed = 0;
  const server = new CommandMcpServer({ sourceRoot: '/tmp/source', executorFactory: async options => {
    starts++; assert.equal(options.sourceRoot, '/tmp/source');
    return { acquire: async action => { acquired.push(action); return outcome(acquired.length === 1 ? 0 : 7); },
      close: async () => { closed++; return { quiescent: true }; } };
  } });
  await initialize(server);
  for (const arguments_ of [{}, { command: [] }, { command: ['test'], unknown: 1 }, { command: 'opaque shell string' }, { command: [1] }]) {
    assert.equal((await call(server, 2, 'tools/call', { name: 'command_exec', arguments: arguments_ })).error.code, -32602);
  }
  assert.equal((await call(server, 3, 'tools/call', { name: 'unknown', arguments: {} })).error.code, -32602);
  assert.equal(starts, 0, 'invalid commands do not start any native process');
  const args = { command: ['/usr/bin/printf', '$(never parsed); token'], cwd: '.' };
  const first = (await call(server, 4, 'tools/call', { name: 'command_exec', arguments: args })).result;
  assert.equal(first.isError, false); assert.deepEqual(first.structuredContent, outcome());
  assert.deepEqual(JSON.parse(first.content[0].text), first.structuredContent);
  assert.deepEqual(acquired[0], { tool: 'command_exec', arguments: args });
  const second = (await call(server, 5, 'tools/call', { name: 'command_exec', arguments: { command: ['/bin/false'] } })).result;
  assert.equal(second.isError, true); assert.deepEqual(second.structuredContent, outcome(7));
  assert.equal(starts, 1);
  await server.close(); await server.close(); assert.equal(closed, 1);
});

test('MCP cancellation is scoped to the request id, does not expose errors, and shutdown joins cleanup', async () => {
  let closed = false, release;
  const server = new CommandMcpServer({ executorFactory: async () => ({
    acquire: async (action, { signal }) => {
      if (action.arguments.command[0] === 'fast') return outcome();
      await new Promise((resolve, reject) => {
        release = resolve;
        signal.addEventListener('abort', () => reject(new Error('sensitive native exception')), { once: true });
      });
      return outcome();
    }, close: async () => { closed = true; release?.(); },
  }) });
  await initialize(server);
  const pending = call(server, 'slow', 'tools/call', { name: 'command_exec', arguments: { command: ['slow'] } });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await call(server, 'slow', 'tools/call', { name: 'command_exec', arguments: { command: ['slow'] } })).error.code, -32600);
  await notify(server, 'notifications/cancelled', { requestId: 'unrelated' });
  assert.equal(server.pending.get('slow').controller.signal.aborted, false);
  assert.equal((await call(server, 'fast', 'tools/call', { name: 'command_exec', arguments: { command: ['fast'] } })).result.isError, false);
  await notify(server, 'notifications/cancelled', { requestId: 'slow', reason: 'never logged' });
  const cancelled = (await pending).result;
  assert.equal(cancelled.structuredContent.error.code, 'CANCELLED');
  assert(!JSON.stringify(cancelled).includes('sensitive'));
  const shutdown = await call(server, 8, 'shutdown'); assert.deepEqual(shutdown.result, { quiescent: true });
  assert(closed); assert.equal(server.pending.size, 0);
});

function stdioFixture({ waitForCancel = false } = {}) {
  const module = new URL('../scripts/mcp.mjs', import.meta.url).href;
  const code = `import {CommandMcpServer,runStdioServer} from ${JSON.stringify(module)};
    const server=new CommandMcpServer({executorFactory:async({sourceRoot})=>({
      acquire:async(action,{signal})=>{
        if(${waitForCancel}&&action.arguments.command[0]==='wait')await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('private error')),{once:true}));
        return {result:{exitCode:0,stdout:'transport ✓',stderr:''},receipt:{sourceRoot,merged:false,network:'denied'}};
      },close:async()=>({quiescent:true})})});
    const result=await runStdioServer({server});if(!result.quiescent)process.exitCode=1;`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames = [], lines = []; let buffer = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', part => {
    buffer += part;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      lines.push(line); frames.push(JSON.parse(line));
    }
  });
  child.stderr.setEncoding('utf8').on('data', part => { stderr += part; });
  const send = value => child.stdin.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
  const response = async id => {
    const deadline = Date.now() + 5000;
    while (!frames.some(frame => frame.id === id)) {
      if (Date.now() > deadline) throw new Error('Offline MCP response timeout');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return frames.find(frame => frame.id === id);
  };
  return { child, frames, lines, send, response, stderr: () => stderr, remainder: () => buffer };
}

test('real stdio uses newline JSON-RPC only, EOF cancels pending work and waits for cleanup', { timeout: 10_000 }, async t => {
  const f = stdioFixture({ waitForCancel: true });
  t.after(() => { if (f.child.exitCode === null) f.child.kill('SIGKILL'); });
  f.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'transport-test', version: '1' } } });
  assert.equal((await f.response(1)).result.protocolVersion, '2025-06-18');
  f.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  f.send('{malformed');
  assert.equal((await f.response(null)).error.code, -32700);
  f.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'command_exec', arguments: { command: ['fast'] } } });
  const result = (await f.response(2)).result;
  assert.equal(result.structuredContent.receipt.sourceRoot, root.replace(/\/$/, ''));
  f.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'command_exec', arguments: { command: ['wait'] } } });
  f.send({ jsonrpc: '2.0', id: 4, method: 'ping' });
  await f.response(4); // An independent request is served while a call is pending.
  const exited = once(f.child, 'exit'); f.child.stdin.end();
  assert.deepEqual(await exited, [0, null]);
  assert.equal((await f.response(3)).result.structuredContent.error.code, 'CANCELLED');
  assert.equal(f.stderr(), ''); assert.equal(f.remainder(), '');
  assert(f.lines.every(line => JSON.parse(line).jsonrpc === '2.0'));
});

test('SIGTERM cancels stdio work and joins cleanup before exiting', { timeout: 10_000 }, async t => {
  const f = stdioFixture({ waitForCancel: true });
  t.after(() => { if (f.child.exitCode === null) f.child.kill('SIGKILL'); });
  f.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'signal-test', version: '1' } } });
  await f.response(1); f.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  f.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'command_exec', arguments: { command: ['wait'] } } });
  f.send({ jsonrpc: '2.0', id: 3, method: 'ping' }); await f.response(3);
  const exited = once(f.child, 'exit'); f.child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
  assert.equal((await f.response(2)).result.structuredContent.error.code, 'CANCELLED');
  assert.equal(f.stderr(), '');
});

async function ownedDescendants(parentPid) {
  // Inventory numeric PID/PPID fields only; no process argv or environment.
  const { stdout } = await executeFile('/bin/ps', ['-axo', 'pid=,ppid='], { env: {} });
  const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const owned = new Set([parentPid]);
  let size;
  do { size = owned.size; for (const [pid, ppid] of rows) if (owned.has(ppid)) owned.add(pid); } while (owned.size !== size);
  return [...owned];
}
const exists = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
async function processStatus(pids) {
  const { stdout } = await executeFile('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,state=,comm='], { env: {} });
  return stdout.trim().split('\n').map(line => {
    const [pid, ppid, pgid, state, ...comm] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), state, executable: comm.join(' ') };
  }).filter(row => pids.includes(row.pid));
}

test('installed native Codex discovers the production packaged MCP tool without inference or credentials', { timeout: 45_000 }, async t => {
  const binary = codexBinary();
  if (!binary) { t.skip('No supported native Codex runtime found'); return; }
  const fixture = await temporaryMarketplace({ fixtureHooks: false }); let app;
  t.after(async () => { await app?.close(); await rm(fixture.root, { recursive: true, force: true }); });
  // This is a local-package, offline lifecycle test. Native Codex otherwise
  // starts an unrelated remote marketplace Git sync that can outlive its host.
  // Restrict Git itself, rather than weakening the owned-process assertion or
  // changing the production MCP package. No user Git credential helper is read.
  Object.assign(fixture.env, { GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  const packed = JSON.parse((await command(process.execPath, [join(root, 'scripts/pack.mjs'), join(fixture.root, 'packed')], { cwd: root, env: fixture.env })).stdout);
  const mcpConfig = JSON.parse(await readFile(join(packed.marketplace, 'plugins', 'perseus', '.mcp.json'), 'utf8'));
  assert.deepEqual(mcpConfig.mcpServers.perseus.args, ['--input-type=module', '-e', MCP_BOOTSTRAP], 'package embeds the reviewed bootstrap exactly');
  await configure(fixture, 'http://127.0.0.1:1/v1');
  const options = { env: fixture.env, cwd: fixture.workspace };
  await command(binary, ['plugin', 'marketplace', 'add', packed.marketplace], options);
  await command(binary, ['plugin', 'add', 'perseus@perseus-local', '--json'], options);
  app = new AppServer(binary, options); await app.initialize();
  const started = await app.call('thread/start', { cwd: fixture.workspace, model: 'gpt-6-sol', modelProvider: 'perseus-fake',
    approvalPolicy: 'never', sandbox: 'danger-full-access', config: { 'features.hooks': false } });
  const listing = await app.call('mcpServerStatus/list', { threadId: started.thread.id, detail: 'toolsAndAuthOnly' });
  const servers = listing.data.filter(server => server.pluginId === 'perseus@perseus-local');
  assert.equal(servers.length, 1, 'production plugin exposes exactly one MCP server');
  assert(servers[0].toolsError == null, 'production MCP initializes successfully');
  assert.deepEqual(servers[0].tools.command_exec.inputSchema, COMMAND_TOOL.parameters);
  assert.equal(servers[0].tools.command_exec.name, 'command_exec');
  assert(!JSON.stringify(servers[0]).includes('${PLUGIN_ROOT}'), 'native runtime resolves package script path');
  const hooks = await app.call('hooks/list', { cwds: [fixture.workspace] });
  const installedHooks = hooks.data.flatMap(entry => entry.hooks).filter(hook => hook.pluginId === 'perseus@perseus-local');
  assert.equal(installedHooks.length, 9);
  const awaitedHome = await realpath(fixture.home);
  assert(installedHooks.every(hook => hook.sourcePath.startsWith(join(awaitedHome, 'plugins', 'cache'))), 'bootstrap metadata names the installed cache, not marketplace source');
  await assert.rejects(readFile(join(fixture.home, 'auth.json')), { code: 'ENOENT' });
  if (process.env.PERSEUS_CODEX_NATIVE_SMOKE === '1') {
    const executed = await app.call('mcpServer/tool/call', { threadId: started.thread.id, server: servers[0].name,
      tool: 'command_exec', arguments: { command: ['/bin/pwd'] } });
    assert.equal(executed.isError, false);
    assert.equal(executed.structuredContent.result.exitCode, 0);
    assert.equal(executed.structuredContent.receipt.sourceRoot, await realpath(fixture.workspace), 'MCP starts in native thread workspace');
    assert.equal(executed.structuredContent.receipt.merged, false);
    assert.notEqual(executed.structuredContent.result.stdout.trim(), fixture.workspace);
  }
  if (process.platform === 'darwin') {
    const pids = await ownedDescendants(app.child.pid);
    const before = await processStatus(pids);
    assert(pids.length >= 2, 'native host owns its MCP server process');
    await app.close();
    const deadline = Date.now() + 3000;
    while (pids.some(exists) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert(pids.every(pid => !exists(pid)), `native shutdown leaves no owned MCP or command host process; before=${JSON.stringify(before)}; remaining=${JSON.stringify(await processStatus(pids))}`);
  }
});
