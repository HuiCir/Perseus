import { spawn, execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const DEFAULT_CODEX_PATH = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';

export class RpcError extends Error {
  constructor(code, message) { super(message); this.name = 'RpcError'; this.code = code; }
}

function abortError() { return new RpcError('ABORTED', 'The RPC wait was cancelled'); }
function sanitized(text) {
  return text.replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, '$1[redacted]')
    .replace(/((?:access_token|refresh_token|api_key|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
}

function toml(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return String(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`).join(', ')} }`;
  throw new TypeError('Config overrides must contain TOML-compatible values');
}

export async function discoverCodex({ codexBin, env = process.env, versionProbe } = {}) {
  const explicit = codexBin ?? env.PERSEUS_CODEX_BIN;
  const candidates = explicit ? [explicit] : [DEFAULT_CODEX_PATH,
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    ...(env.PATH ?? '').split(delimiter).filter(Boolean).map(p => join(p, 'codex'))];
  for (const executable of [...new Set(candidates)]) {
    try {
      if (!versionProbe) await access(executable, constants.X_OK);
      const version = versionProbe ? await versionProbe(executable) :
        (await execFileAsync(executable, ['--version'], { env, timeout: 5000, maxBuffer: 65536 })).stdout.trim();
      if (!/^codex-cli\s+\S+/.test(version)) throw new Error('Unexpected version response');
      return { executable, version };
    } catch {
      if (explicit) throw new RpcError('CODEX_RUNTIME_UNAVAILABLE', 'The selected Codex executable did not answer --version');
    }
  }
  throw new RpcError('CODEX_RUNTIME_UNAVAILABLE', 'No working Codex executable was found');
}

/** One owned standalone app-server. No daemon, configuration write, or auth-file access. */
export class RpcClient {
  constructor({ codexBin, configOverrides = {}, cliArgs = [], env = process.env, cwd, experimentalApi = false,
    maxStderrChars = 16384, shutdownGraceMs = 5000, initializeTimeoutMs = 10000, spawnImpl = spawn, versionProbe,
    killImpl = process.kill.bind(process), platform = process.platform } = {}) {
    if (!Number.isInteger(maxStderrChars) || maxStderrChars < 0 || !Number.isInteger(shutdownGraceMs) || shutdownGraceMs < 1 ||
      !Number.isInteger(initializeTimeoutMs) || initializeTimeoutMs < 1)
      throw new TypeError('Invalid RPC resource limits');
    if (typeof experimentalApi !== 'boolean') throw new TypeError('experimentalApi must be a boolean');
    this.options = { codexBin, configOverrides, cliArgs, env, cwd, experimentalApi, maxStderrChars, shutdownGraceMs, initializeTimeoutMs, spawnImpl, versionProbe, killImpl, platform };
    this.listeners = new Set(); this.pending = new Map(); this.nextId = 1;
    this.state = 'new'; this.stderr = ''; this.buffer = '';
  }
  static async create(options) { const client = new RpcClient(options); await client.start(); return client; }
  async start() {
    if (this.state !== 'new') throw new RpcError('INVALID_STATE', 'RPC client has already been started');
    this.runtime = await discoverCodex(this.options);
    const overrides = Object.entries(this.options.configOverrides).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]);
    this.state = 'starting';
    this.child = this.options.spawnImpl(this.runtime.executable, [...overrides, ...this.options.cliArgs, 'app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: this.options.env, cwd: this.options.cwd, detached: this.options.platform !== 'win32',
    });
    this.exited = new Promise(resolve => {
      this.child.once('error', () => {
        this.state = 'closed'; this.failPending(new RpcError('RPC_TRANSPORT_FAILED', 'Codex app-server could not start'));
        resolve({ code: null, signal: null });
      });
      this.child.once('exit', (code, signal) => {
        this.state = 'closed'; this.failPending(new RpcError('RPC_CLOSED', 'Codex app-server exited'));
        resolve({ code, signal });
      });
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.consume(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => {
      this.stderr = sanitized(this.stderr + chunk).slice(-this.options.maxStderrChars);
      if (this.options.maxStderrChars === 0) this.stderr = '';
    });
    this.child.stdin.on('error', () => this.failPending(new RpcError('RPC_TRANSPORT_FAILED', 'Codex RPC input closed')));
    const initializeAbort = new AbortController();
    const initializeTimer = setTimeout(() => initializeAbort.abort(), this.options.initializeTimeoutMs);
    try {
      await this.request('initialize', { clientInfo: { name: 'perseus', title: 'Perseus', version: '0.2.1' },
        capabilities: { experimentalApi: this.options.experimentalApi } }, { signal: initializeAbort.signal });
      this.write({ method: 'initialized' }); this.state = 'ready'; return this;
    } catch (error) {
      const timedOut = initializeAbort.signal.aborted;
      clearTimeout(initializeTimer); await this.close();
      if (timedOut) throw new RpcError('INITIALIZE_TIMEOUT', 'Codex initialize handshake timed out');
      throw error;
    } finally { clearTimeout(initializeTimer); }
  }
  write(message) {
    if (!this.child || this.state === 'closed' || this.state === 'closing') throw new RpcError('RPC_CLOSED', 'Codex RPC is closed');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method, params = {}, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (!this.child || this.state === 'closed' || this.state === 'closing') return Promise.reject(new RpcError('RPC_CLOSED', 'Codex RPC is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => { reject(abortError()); /* Keep tracking the wire request until its response. */ };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', onAbort, { once: true });
      try { this.write({ id, method, params }); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }
  onNotification(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  consume(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.failPending(new RpcError('INVALID_RPC_FRAME', 'Codex emitted an invalid JSON frame')); continue; }
      if (message.method) {
        if (Object.hasOwn(message, 'id')) {
          // This executor never authorizes client-executed tools, permissions, or token refresh.
          try { this.write({ id: message.id, error: { code: -32601, message: 'Client-executed requests are unavailable' } }); } catch {}
        } else {
          for (const listener of [...this.listeners]) { try { listener({ method: message.method, params: message.params }); } catch {} }
        }
      } else if (Object.hasOwn(message, 'id')) {
        const waiter = this.pending.get(message.id); if (!waiter) continue;
        this.pending.delete(message.id); waiter.cleanup();
        if (message.error) waiter.reject(new RpcError(message.error.code ?? 'RPC_ERROR', 'Codex rejected the RPC request'));
        else waiter.resolve(message.result);
      }
    }
  }
  failPending(error) { for (const waiter of this.pending.values()) { waiter.cleanup(); waiter.reject(error); } this.pending.clear(); }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeOwned(); return this.closePromise;
  }
  async closeOwned() {
    if (!this.child) { this.state = 'closed'; return { quiescent: true }; }
    if (this.state === 'closed') { await this.exited; return { quiescent: true }; }
    this.state = 'closing'; this.child.stdin.end();
    const wait = async () => {
      let timer;
      try { return await Promise.race([this.exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), this.options.shutdownGraceMs); })]); }
      finally { clearTimeout(timer); }
    };
    if (!await wait()) {
      this.signalOwnedGroup('SIGTERM');
      if (!await wait()) { this.signalOwnedGroup('SIGKILL'); if (!await wait()) throw new RpcError('CLEANUP_UNCONFIRMED', 'Owned Codex app-server did not exit'); }
    }
    this.listeners.clear(); this.failPending(new RpcError('RPC_CLOSED', 'Codex RPC is closed'));
    return { quiescent: true };
  }
  signalOwnedGroup(signal) {
    try {
      if (this.options.platform === 'win32') this.child.kill(signal);
      else {
        if (!Number.isInteger(this.child.pid) || this.child.pid <= 0) throw new RpcError('CLEANUP_UNCONFIRMED', 'Owned server process group is unavailable');
        this.options.killImpl(-this.child.pid, signal);
      }
    } catch (error) {
      // The exit event can trail the OS disappearance of the owned group.
      if (error.code !== 'ESRCH') throw new RpcError('CLEANUP_UNCONFIRMED', 'Owned server process group could not be stopped');
    }
  }
}
