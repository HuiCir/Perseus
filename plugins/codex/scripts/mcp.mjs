import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { COMMAND_TOOL } from '../src/tool-registry.mjs';
import { validateJsonSchema } from '../src/schema-validation.mjs';
import { RpcClient } from '../src/rpc.mjs';
import { ExecutionManager } from '../src/execution.mjs';
import { WORKER_HOST_CONFIG } from '../src/config.mjs';
import { disableInheritedMcp } from '../src/host-policy.mjs';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requestId = value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

/** The installed alpha does not expand plugin-root placeholders in legacy MCP
 * arguments. This self-contained launcher uses public hooks/list metadata to
 * locate the installed copy without assuming a cache or marketplace path.
 * Keep it free of plugin-local imports: .mcp.json embeds this function verbatim.
 */
export async function launchInstalledMcp() {
  const { spawn } = await import('node:child_process');
  const { readFile, realpath } = await import('node:fs/promises');
  const { dirname, join, resolve } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  let child, exited, closed = false;
  const pending = new Map();
  let bytes = 0, buffer = '', nextId = 1;
  function fail() {
    for (const slot of pending.values()) { clearTimeout(slot.timer); slot.reject(new Error('Native plugin lookup failed')); }
    pending.clear();
  }
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native plugin lookup timeout')); }, 10_000);
      pending.set(id, { resolve: resolveRequest, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => { if (error) fail(); });
    });
  }
  async function stopChild() {
    if (!child) return;
    child.stdin.end();
    const wait = ms => Promise.race([exited.then(() => true), new Promise(resolveWait => {
      const timer = setTimeout(() => resolveWait(false), ms);
      exited.then(() => clearTimeout(timer));
    })]);
    if (await wait(1000)) return;
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      if (await wait(1000)) return;
    }
    throw new Error('Native plugin lookup cleanup unconfirmed');
  }
  try {
    child = spawn(process.env.PERSEUS_CODEX_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
      ['app-server', '--stdio'], { cwd: process.cwd(), env: process.env,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] });
    exited = new Promise(resolveExit => {
      child.once('error', () => { closed = true; fail(); resolveExit(); });
      child.once('exit', () => { closed = true; fail(); resolveExit(); });
    });
    child.stdin.on('error', fail);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk); buffer += chunk;
      if (bytes > 4 * 1024 * 1024) { fail(); return; }
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { fail(); continue; }
        const slot = pending.get(message.id);
        if (slot && !message.method) {
          pending.delete(message.id); clearTimeout(slot.timer);
          message.error ? slot.reject(new Error('Native plugin lookup rejected')) : slot.resolve(message.result);
        } else if (message.method && message.id !== undefined) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
            error: { code: -32601, message: 'Lookup host has no client tools' } }) + '\n');
        }
      }
    });
    await request('initialize', { clientInfo: { name: 'perseus-mcp-loader', version: '0.2.1' },
      capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
    const listing = await request('hooks/list', { cwds: [process.cwd()] });
    const hooks = (listing?.data ?? []).flatMap(entry => entry.hooks ?? [])
      .filter(hook => hook.pluginId === 'perseus@perseus-local');
    if (hooks.length !== 9 || hooks.some(hook => typeof hook.sourcePath !== 'string'
      || hook.sourcePath !== hooks[0].sourcePath || hook.source !== 'plugin')) throw new Error('Installed plugin metadata mismatch');
    const installedRoot = await realpath(dirname(dirname(hooks[0].sourcePath)));
    if (resolve(hooks[0].sourcePath) !== join(installedRoot, 'hooks', 'hooks.json')) throw new Error('Unexpected installed hook path');
    const manifest = JSON.parse(await readFile(join(installedRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
    if (manifest.name !== 'perseus' || manifest.version !== '0.2.1') throw new Error('Installed plugin identity mismatch');
    await stopChild();
    const { runStdioServer } = await import(pathToFileURL(join(installedRoot, 'scripts', 'mcp.mjs')).href);
    const outcome = await runStdioServer({ onCleanupError: () => process.stderr.write('Perseus MCP cleanup could not be confirmed\n') });
    if (!outcome.quiescent) process.exitCode = 1;
  } catch {
    try { await stopChild(); } catch {}
    process.stderr.write('Perseus MCP installed plugin lookup failed\n');
    process.exitCode = 1;
  } finally {
    if (child && !closed) { try { await stopChild(); } catch { process.exitCode = 1; } }
  }
}
export const MCP_BOOTSTRAP = `await (${launchInstalledMcp.toString()})();`;

class ProtocolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const invalidParams = () => { throw new ProtocolError(-32602, 'Invalid parameters'); };
function paramsObject(params, allowed, required = []) {
  if (!object(params) || Object.keys(params).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(params, key))
    || (params._meta !== undefined && !object(params._meta))) invalidParams();
  return params;
}

/** Owns a command-only native app-server; never starts a thread or a model. */
export async function createNativeExecutor({ sourceRoot }) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'perseus-mcp-'));
  let client, manager;
  try {
    const hostCwd = join(tempRoot, 'host');
    await mkdir(hostCwd, { mode: 0o700 });
    const policy = await disableInheritedMcp({ cwd: sourceRoot, configOverrides: WORKER_HOST_CONFIG });
    client = await RpcClient.create({ cwd: hostCwd, experimentalApi: true,
      configOverrides: { ...WORKER_HOST_CONFIG, ...policy } });
    manager = new ExecutionManager({ client, sourceRoot, tempRoot });
    if (!manager.canExecute(COMMAND_TOOL.name)) throw new Error('Structured command executor unavailable');
  } catch (error) {
    // The host must exit before any private directory is removed.
    await client?.close();
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
  let closing;
  return {
    acquire: (action, options) => manager.acquire(action, options),
    close() {
      if (closing) return closing;
      closing = (async () => {
        const failures = [];
        try { await manager.settleClose(); } catch (error) { failures.push(error); }
        try { await client.close(); } catch (error) { failures.push(error); }
        // Keep unconfirmed copies for diagnosis; do not claim they are clean.
        if (failures.length) throw new AggregateError(failures, 'MCP executor cleanup could not be confirmed');
        await rm(tempRoot, { recursive: true, force: true });
        return { quiescent: true };
      })();
      return closing;
    },
  };
}

/** MCP protocol handler with an injected executor factory for offline tests. */
export class CommandMcpServer {
  constructor({ sourceRoot = process.cwd(), executorFactory = createNativeExecutor } = {}) {
    if (typeof sourceRoot !== 'string' || !sourceRoot || typeof executorFactory !== 'function')
      throw new TypeError('Invalid MCP server options');
    this.sourceRoot = resolve(sourceRoot);
    this.executorFactory = executorFactory;
    this.pending = new Map();
    this.initialized = false;
    this.ready = false;
    this.closed = false;
  }
  async executor() {
    if (!this.starting) {
      this.starting = Promise.resolve().then(() => this.executorFactory({ sourceRoot: this.sourceRoot }));
    }
    const executor = await this.starting;
    if (!executor || typeof executor.acquire !== 'function' || typeof executor.close !== 'function')
      throw new Error('Invalid command executor');
    return executor;
  }
  async handle(message) {
    const hasId = object(message) && Object.hasOwn(message, 'id');
    const id = hasId && requestId(message.id) ? message.id : null;
    const validEnvelope = object(message) && message.jsonrpc === '2.0' && typeof message.method === 'string'
      && (!hasId || requestId(message.id))
      && Object.keys(message).every(key => ['jsonrpc', 'id', 'method', 'params'].includes(key));
    try {
      if (!validEnvelope)
        throw new ProtocolError(-32600, 'Invalid request');
      if (!hasId) { this.notify(message.method, message.params); return; }
      const result = await this.request(message.method, message.params, id);
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      if (!hasId && validEnvelope) return;
      return { jsonrpc: '2.0', id, error: error instanceof ProtocolError
        ? { code: error.code, message: error.message }
        : { code: -32603, message: 'Internal server error' } };
    }
  }
  notify(method, raw) {
    if (method === 'notifications/initialized') {
      paramsObject(raw ?? {}, ['_meta']);
      if (this.initialized && !this.closed) this.ready = true;
    } else if (method === 'notifications/cancelled') {
      const params = paramsObject(raw, ['requestId', 'reason', '_meta'], ['requestId']);
      if (!requestId(params.requestId) || (params.reason !== undefined && typeof params.reason !== 'string')) invalidParams();
      // Never log cancellation reasons, command arguments, or native errors.
      this.pending.get(params.requestId)?.controller.abort();
    }
  }
  async request(method, raw, id) {
    if (this.closed) throw new ProtocolError(-32000, 'Server is closed');
    if (method === 'initialize') {
      const params = paramsObject(raw, ['protocolVersion', 'capabilities', 'clientInfo', '_meta'],
        ['protocolVersion', 'capabilities', 'clientInfo']);
      if (this.initialized || typeof params.protocolVersion !== 'string' || !object(params.capabilities)
        || !object(params.clientInfo) || typeof params.clientInfo.name !== 'string'
        || typeof params.clientInfo.version !== 'string') invalidParams();
      this.initialized = true;
      return { protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} }, serverInfo: { name: 'perseus', version: '0.2.1' } };
    }
    if (method === 'ping') { paramsObject(raw ?? {}, ['_meta']); return {}; }
    if (!this.ready) throw new ProtocolError(-32000, 'Server is not initialized');
    if (method === 'tools/list') {
      const params = paramsObject(raw ?? {}, ['cursor', '_meta']);
      if (params.cursor !== undefined) invalidParams();
      return { tools: [{ name: COMMAND_TOOL.name, description: COMMAND_TOOL.description,
        inputSchema: structuredClone(COMMAND_TOOL.parameters),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] };
    }
    if (method === 'tools/call') {
      const params = paramsObject(raw, ['name', 'arguments', '_meta'], ['name']);
      if (params.name !== COMMAND_TOOL.name) throw new ProtocolError(-32602, 'Unknown tool');
      if (this.pending.has(id)) throw new ProtocolError(-32600, 'Request id is already active');
      const args = params.arguments ?? {};
      try { if (!validateJsonSchema(COMMAND_TOOL.parameters, args)) invalidParams(); }
      catch { invalidParams(); }
      const controller = new AbortController();
      const slot = { controller };
      this.pending.set(id, slot);
      slot.work = (async () => {
        const executor = await this.executor();
        if (controller.signal.aborted) throw new Error('Cancelled');
        return executor.acquire({ tool: COMMAND_TOOL.name, arguments: structuredClone(args) }, { signal: controller.signal });
      })();
      try {
        const outcome = await slot.work;
        if (!object(outcome) || !object(outcome.result) || !object(outcome.receipt)
          || !Number.isInteger(outcome.result.exitCode)) throw new Error('Invalid command result');
        return { content: [{ type: 'text', text: JSON.stringify(outcome) }], structuredContent: outcome,
          isError: outcome.result.exitCode !== 0 };
      } catch (error) {
        const code = controller.signal.aborted ? 'CANCELLED' :
          (typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'EXECUTION_FAILED');
        const outcome = { error: { code, message: code === 'CANCELLED' ? 'Command request cancelled' : 'Command execution failed' },
          ...(object(error?.receipt) ? { receipt: error.receipt } : {}) };
        return { content: [{ type: 'text', text: JSON.stringify(outcome) }], structuredContent: outcome, isError: true };
      } finally { this.pending.delete(id); }
    }
    // MCP's normal shutdown is transport EOF. This explicit extension also
    // waits for confirmed command and host cleanup before acknowledging.
    if (method === 'shutdown') { paramsObject(raw ?? {}, ['_meta']); return this.close(); }
    throw new ProtocolError(-32601, 'Method not found');
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const { controller } of this.pending.values()) controller.abort();
    this.closing = (async () => {
      const active = [...this.pending.values()].map(slot => slot.work);
      const executor = this.starting ? await this.executor() : undefined;
      let failure;
      try { await executor?.close(); } catch (error) { failure = error; }
      await Promise.allSettled(active);
      if (failure) throw failure;
      return { quiescent: true };
    })();
    return this.closing;
  }
}

/** JSON-RPC stdio transport: one JSON object per line, protocol-only stdout. */
export async function runStdioServer({ server = new CommandMcpServer(), input = process.stdin,
  output = process.stdout, onCleanupError = () => {} } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const work = new Set();
  let writing = Promise.resolve(), failed = false;
  const send = response => {
    if (response === undefined) return;
    writing = writing.then(() => new Promise((resolveWrite, reject) => {
      output.write(`${JSON.stringify(response)}\n`, error => error ? reject(error) : resolveWrite());
    }));
    writing.catch(() => { failed = true; lines.close(); });
  };
  const dispatch = line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    const job = server.handle(message).then(send).finally(() => work.delete(job));
    work.add(job);
  };
  const stop = () => { lines.close(); input.pause(); };
  const onSignal = () => { stop(); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const ended = new Promise(resolveEnd => lines.once('close', resolveEnd));
  lines.on('line', dispatch);
  try {
    await ended;
    try { await server.close(); } catch { failed = true; onCleanupError(); }
    await Promise.allSettled([...work]);
    await writing;
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
  return { quiescent: !failed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const outcome = await runStdioServer({ onCleanupError: () => {
      process.stderr.write('Perseus MCP cleanup could not be confirmed\n');
    } });
    if (!outcome.quiescent) process.exitCode = 1;
  } catch {
    process.stderr.write('Perseus MCP transport failed\n');
    process.exitCode = 1;
  }
}
