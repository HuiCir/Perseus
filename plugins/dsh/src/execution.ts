/** Independent acquisition execution. Native tools run in a separate OS-confined host. */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ToolSchema } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools';

/** The actual 0.2.0-rc.2 native tools whose hosts this provider implements. */
export const NATIVE_ACQUISITION_TOOLS = ['read', 'write', 'edit', 'grep', 'glob', 'bash'] as const;
export const NATIVE_PROVIDER_ID = 'dsh-native-seatbelt';
export const NATIVE_EXECUTION_DEFAULTS = { cancellationGraceMs: 10_000, stderrMaxChars: 16_384 } as const;

export interface AcquisitionCall {
  toolName: string;
  arguments: unknown;
  workspace: string;
  actorSchemas: readonly ToolSchema[];
  outputSchema?: unknown;
  signal: AbortSignal;
  requestId?: string;
}

/** A configured provider is responsible for a genuinely independent execution scope. */
export interface AcquisitionProvider {
  readonly id: string;
  readonly tools: readonly string[];
  create(scope: AcquisitionScope): Promise<AcquisitionLease>;
}

export interface AcquisitionScope {
  acquisitionId: string;
  sourceWorkspace: string;
  isolatedWorkspace: string;
  privateRoot: string;
  privateTemp: string;
  signal: AbortSignal;
  call: AcquisitionCall;
}

export interface AcquisitionLease {
  readonly isolation: {
    kind: 'macos-seatbelt' | 'provider-acquisition-scope';
    /** External providers must describe their actual independent mutation scope. */
    scopeId: string;
    independentWrites: true;
    network: 'denied' | 'provider-scoped';
  };
  execute(call: AcquisitionCall): Promise<ToolExecutionResult>;
  /** Resolve only after processes and external scope work have stopped. */
  close(): Promise<void>;
}

export interface AcquisitionProvenance {
  provider: string;
  acquisitionId: string;
  requestId?: string;
  sourceWorkspace: string;
  isolatedWorkspace: string;
  snapshotStartedAt: number;
  snapshotFinishedAt: number;
  isolation: AcquisitionLease['isolation'];
  merged: false;
}

export interface AcquisitionOutcome {
  result: ToolExecutionResult;
  provenance: AcquisitionProvenance;
}

export interface NativeRuntimeOptions {
  runtimeRoot: string;
  nodeExecutable: string;
  /** Explicit carrier options only; ambient credentials are never forwarded. */
  childEnv?: Readonly<Record<string, string>>;
  /** Watchdog after cooperative cancellation; defaults to 10 seconds. */
  cancellationGraceMs?: number;
  /** Optional transport limit. Omitted preserves the complete native result. */
  maxResultBytes?: number;
  /** Diagnostic tail retention; defaults to 16,384 characters. */
  stderrMaxChars?: number;
}

export interface ExecutionManagerOptions {
  runtimeRoot?: string;
  nodeExecutable?: string;
  childEnv?: Readonly<Record<string, string>>;
  cancellationGraceMs?: number;
  maxResultBytes?: number;
  stderrMaxChars?: number;
  tempRoot?: string;
  /** Per-tool routing is explicit. Missing routes or providers fail closed. */
  routes?: Readonly<Record<string, string>>;
  providers?: readonly AcquisitionProvider[];
  /** Native package config, keyed by package suffix (tool-fs, tool-fs-search, bash-local). */
  toolConfigs?: Readonly<Record<string, unknown>>;
  /** Optional additional preflight. Parent ToolRuntime policy should surround acquire(). */
  authorize?: (call: AcquisitionCall) => boolean | Promise<boolean>;
}

export class AcquisitionExecutionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'AcquisitionExecutionError'; }
}

/** Discover the installed carrier without opening settings or credential files. */
export function detectDesktopRuntime(): NativeRuntimeOptions | undefined {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    ?? '/Applications/DeepSeek Harness.app/Contents/Resources';
  const nativeModules = process.env.DSH_NATIVE_NODE_MODULES;
  const runtimeRoot = nativeModules === undefined ? join(resources, 'app.asar', 'dsh') : dirname(nativeModules);
  const nodeExecutable = process.env.DSH_DESKTOP_EXECUTABLE
    ?? join(resources, '..', 'MacOS', 'DeepSeek Harness');
  if (!existsSync(nodeExecutable)) return undefined;
  return { runtimeRoot, nodeExecutable, childEnv: { ELECTRON_RUN_AS_NODE: '1' } };
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Fresh workspace per invocation, no adoption or merge, and quiescent cleanup. */
export class ExecutionManager {
  private readonly options: ExecutionManagerOptions;
  private readonly providers = new Map<string, AcquisitionProvider>();
  private readonly routes: Readonly<Record<string, string>>;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<AcquisitionOutcome> }>();
  private readonly cleanupErrors: unknown[] = [];
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(options: ExecutionManagerOptions = {}) {
    this.options = options;
    const detected = detectDesktopRuntime();
    const runtimeRoot = options.runtimeRoot ?? detected?.runtimeRoot;
    const nodeExecutable = options.nodeExecutable ?? detected?.nodeExecutable;
    if (runtimeRoot !== undefined && nodeExecutable !== undefined) {
      this.providers.set(NATIVE_PROVIDER_ID, createNativeAcquisitionProvider({
        runtimeRoot, nodeExecutable,
        childEnv: options.childEnv ?? (nodeExecutable === detected?.nodeExecutable ? detected.childEnv : undefined),
        cancellationGraceMs: options.cancellationGraceMs, maxResultBytes: options.maxResultBytes,
        stderrMaxChars: options.stderrMaxChars,
      }, options.toolConfigs));
    }
    for (const provider of options.providers ?? []) {
      if (!provider.id || this.providers.has(provider.id)) throw new AcquisitionExecutionError('DUPLICATE_PROVIDER', `Duplicate acquisition provider: ${provider.id}`);
      this.providers.set(provider.id, provider);
    }
    this.routes = options.routes ?? Object.fromEntries(NATIVE_ACQUISITION_TOOLS.map(name => [name, NATIVE_PROVIDER_ID]));
  }

  canExecute(toolName: string, definition?: Pick<ToolDefinition, 'name' | 'parameters' | 'output'>): boolean {
    if (this.closed) return false;
    const provider = this.providers.get(this.routes[toolName] ?? '');
    return provider !== undefined && provider.tools.includes(toolName)
      && (definition === undefined || (definition.name === toolName && definition.output?.schema !== undefined));
  }

  acquire(call: AcquisitionCall): Promise<AcquisitionOutcome> {
    if (!this.canExecute(call.toolName)) return Promise.reject(new AcquisitionExecutionError('NO_ACQUISITION_PROVIDER', `No independent provider is configured for tool ${call.toolName}`));
    if (call.actorSchemas.filter(schema => schema.name === call.toolName).length !== 1) {
      return Promise.reject(new AcquisitionExecutionError('INVALID_NATIVE_SCHEMA', `Expected one Actor schema for ${call.toolName}`));
    }
    const acquisitionId = randomUUID();
    const controller = new AbortController();
    const signal = AbortSignal.any([call.signal, controller.signal]);
    const done = this.run(acquisitionId, { ...call, signal });
    this.active.set(acquisitionId, { controller, done });
    void done.then(() => this.active.delete(acquisitionId), error => {
      this.active.delete(acquisitionId);
      if (error instanceof AcquisitionExecutionError && error.code === 'ACQUISITION_CLEANUP_FAILED') this.cleanupErrors.push(error);
    });
    return done;
  }

  cancel(reason: unknown = new AcquisitionExecutionError('ACQUISITION_CANCELED', 'Acquisition canceled')): void {
    for (const { controller } of this.active.values()) controller.abort(reason);
  }

  /** Stop all owned calls and join every cleanup; no pending work reaches another run. */
  settleClose(): Promise<void> {
    this.closed = true;
    this.cancel();
    return this.closePromise ??= (async () => {
      await Promise.allSettled([...this.active.values()].map(entry => entry.done));
      if (this.cleanupErrors.length > 0) throw new AggregateError(this.cleanupErrors, 'Acquisition cleanup failed');
    })();
  }

  private async run(acquisitionId: string, call: AcquisitionCall): Promise<AcquisitionOutcome> {
    call.signal.throwIfAborted();
    if (this.options.authorize !== undefined && !await this.options.authorize(call)) {
      throw new AcquisitionExecutionError('ACQUISITION_POLICY_DENIED', `Acquisition policy denied ${call.toolName}`);
    }
    call.signal.throwIfAborted();
    const sourceWorkspace = await realpath(call.workspace);
    const tempBase = await realpath(this.options.tempRoot ?? tmpdir());
    if (within(sourceWorkspace, tempBase)) throw new AcquisitionExecutionError('UNSAFE_TEMP_ROOT', 'Acquisition temp root must be outside the authoritative workspace');
    const privateRoot = await mkdtemp(join(tempBase, 'perseus-acquisition-'));
    const isolatedWorkspace = join(privateRoot, 'workspace');
    const privateTemp = join(privateRoot, 'tmp');
    let lease: AcquisitionLease | undefined;
    try {
      await mkdir(privateTemp);
      const snapshotStartedAt = Date.now();
      await cp(sourceWorkspace, isolatedWorkspace, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
      const snapshotFinishedAt = Date.now();
      call.signal.throwIfAborted();
      const provider = this.providers.get(this.routes[call.toolName]!)!;
      lease = await provider.create({ acquisitionId, sourceWorkspace, isolatedWorkspace, privateRoot, privateTemp, signal: call.signal, call });
      if (lease.isolation.independentWrites !== true || !lease.isolation.scopeId
        || !['denied', 'provider-scoped'].includes(lease.isolation.network)) {
        throw new AcquisitionExecutionError('UNCONFIRMED_ISOLATION', `Provider ${provider.id} did not supply an independent write and network scope`);
      }
      call.signal.throwIfAborted();
      const result = await lease.execute(call);
      return {
        result,
        provenance: {
          provider: provider.id, acquisitionId,
          ...(call.requestId === undefined ? {} : { requestId: call.requestId }),
          sourceWorkspace, isolatedWorkspace, snapshotStartedAt, snapshotFinishedAt, isolation: lease.isolation, merged: false,
        },
      };
    } finally {
      try {
        await lease?.close();
        await rm(privateRoot, { recursive: true, force: true });
      } catch (cause) {
        throw new AcquisitionExecutionError('ACQUISITION_CLEANUP_FAILED', `Could not close acquisition ${acquisitionId}: ${String(cause)}`);
      }
    }
  }
}

function sbpl(value: string): string { return JSON.stringify(value); }

/** Seatbelt covers the entire tool host and all subprocesses, including native FS calls. */
export function nativeSeatbeltProfile(scope: Pick<AcquisitionScope, 'sourceWorkspace' | 'privateRoot'>, runtimeRoot?: string): string {
  if (runtimeRoot !== undefined && within(scope.sourceWorkspace, resolve(runtimeRoot))) {
    throw new AcquisitionExecutionError('UNSAFE_NATIVE_RUNTIME_ROOT', 'Native runtime must be outside the authoritative workspace');
  }
  return ['(version 1)', '(allow default)', '(deny network*)', '(deny file-write*)',
    `(allow file-write* (subpath ${sbpl(scope.privateRoot)}) (literal "/dev/null"))`,
    `(deny file-read* (subpath ${sbpl(homedir())}))`,
    ...(runtimeRoot === undefined ? [] : [`(allow file-read* (subpath ${sbpl(resolve(runtimeRoot))}))`]),
    `(deny file-read* (subpath ${sbpl(scope.sourceWorkspace)}))`].join('\n');
}

/** Supports macOS only; another OS requires an independently enforced provider. */
export function createNativeAcquisitionProvider(runtime: NativeRuntimeOptions, toolConfigs: Readonly<Record<string, unknown>> = {}): AcquisitionProvider {
  for (const [name, value] of Object.entries({ cancellationGraceMs: runtime.cancellationGraceMs ?? NATIVE_EXECUTION_DEFAULTS.cancellationGraceMs,
    maxResultBytes: runtime.maxResultBytes, stderrMaxChars: runtime.stderrMaxChars ?? NATIVE_EXECUTION_DEFAULTS.stderrMaxChars })) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1
      || (name === 'cancellationGraceMs' && value > 2_147_483_647))) {
      throw new AcquisitionExecutionError('INVALID_NATIVE_RUNTIME_OPTION', `${name} must be a positive safe integer${name === 'cancellationGraceMs' ? ' at most 2147483647' : ''}`);
    }
  }
  return {
    id: NATIVE_PROVIDER_ID,
    tools: NATIVE_ACQUISITION_TOOLS,
    async create(scope) {
      if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
        throw new AcquisitionExecutionError('NATIVE_ISOLATION_UNAVAILABLE', 'Native acquisition requires macOS Seatbelt; no unconfined fallback exists');
      }
      const entrypoint = join(scope.privateRoot, 'native-host.mjs');
      await writeFile(entrypoint, NATIVE_HOST_SOURCE, { mode: 0o600 });
      await mkdir(join(scope.privateRoot, 'home'));
      let work: Promise<ToolExecutionResult> | undefined;
      let child: ChildProcess | undefined;
      const isolation: AcquisitionLease['isolation'] = { kind: 'macos-seatbelt', scopeId: scope.acquisitionId, independentWrites: true, network: 'denied' };
      return {
        isolation,
        execute(call) {
          if (work !== undefined) return Promise.reject(new AcquisitionExecutionError('LEASE_ALREADY_USED', 'Each native lease executes exactly one call'));
          work = runNativeHost(runtime, scope, entrypoint, toolConfigs, call, spawned => { child = spawned; });
          return work;
        },
        async close() {
          if (work !== undefined) await work.catch(error => {
            if (error instanceof AcquisitionExecutionError && error.code === 'NATIVE_CLEANUP_FAILED') throw error;
          });
          if (child !== undefined && child.exitCode === null && child.signalCode === null) {
            throw new AcquisitionExecutionError('NATIVE_HOST_NOT_QUIESCENT', 'Native host has not exited');
          }
        },
      };
    },
  };
}

function runNativeHost(runtime: NativeRuntimeOptions, scope: AcquisitionScope, entrypoint: string,
  toolConfigs: Readonly<Record<string, unknown>>, call: AcquisitionCall, onSpawn: (child: ChildProcess) => void): Promise<ToolExecutionResult> {
  return new Promise((accept, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', nativeSeatbeltProfile(scope, runtime.runtimeRoot), runtime.nodeExecutable, entrypoint], {
      cwd: scope.isolatedWorkspace,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: join(scope.privateRoot, 'home'), TMPDIR: scope.privateTemp, TMP: scope.privateTemp, TEMP: scope.privateTemp,
        DSH_HOME: join(scope.privateRoot, 'home'), ...runtime.childEnv,
      },
      stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
    });
    onSpawn(child);
    const packetChunks: Buffer[] = [];
    let packetBytes = 0;
    let status = '';
    let statusComplete = false;
    let stderr = '';
    let overflow = false;
    let forced = false;
    let termination: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.stdin?.write(`${JSON.stringify({ abort: true })}\n`);
      // Native cancellation normally drains through the DSH subprocess provider.
      // A broken host is explicitly failed instead of hanging the Actor's cleanup.
      termination = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, runtime.cancellationGraceMs ?? NATIVE_EXECUTION_DEFAULTS.cancellationGraceMs);
      termination.unref();
    };
    scope.signal.addEventListener('abort', abort, { once: true });
    if (scope.signal.aborted) abort();
    child.stdin?.on('error', () => undefined);
    const channel = child.stdio[3];
    channel?.on('data', (chunk: Buffer) => {
      if (!statusComplete) {
        const newline = chunk.indexOf(10);
        const prefix = newline < 0 ? chunk : chunk.subarray(0, newline);
        // This fixed control frame is separate from optional result retention.
        status += prefix.toString('ascii');
        if (status.length > 64) { forced = true; child.kill('SIGKILL'); return; }
        if (newline < 0) return;
        statusComplete = true;
        chunk = chunk.subarray(newline + 1);
      }
      packetBytes += chunk.length;
      if (runtime.maxResultBytes !== undefined && packetBytes > runtime.maxResultBytes) {
        overflow = true;
        packetChunks.length = 0;
      }
      // Continue draining after overflow. The host has already awaited native
      // cleanup before sending a result; killing it would lose that guarantee.
      if (!overflow) packetChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-(runtime.stderrMaxChars ?? NATIVE_EXECUTION_DEFAULTS.stderrMaxChars)); });
    child.once('error', error => reject(new AcquisitionExecutionError('NATIVE_HOST_START_FAILED', error.message)));
    child.once('close', (code, signal) => {
      scope.signal.removeEventListener('abort', abort);
      if (termination !== undefined) clearTimeout(termination);
      if (forced || signal !== null || code !== 0 || status !== 'quiescent') return reject(new AcquisitionExecutionError('NATIVE_CLEANUP_FAILED', `Native host did not prove tool cleanup (exit ${code ?? signal}); private scope retained: ${scope.privateRoot}${stderr ? ': ' + stderr : ''}`));
      if (overflow) return reject(new AcquisitionExecutionError('NATIVE_RESULT_OVERFLOW', 'Native result exceeded the IPC limit'));
      try {
        const reply: { result?: ToolExecutionResult; error?: { code: string; message: string } } = JSON.parse(Buffer.concat(packetChunks, packetBytes).toString('utf8'));
        if (reply.error !== undefined) return reject(new AcquisitionExecutionError(reply.error.code, reply.error.message));
        if (reply.result === undefined || typeof reply.result.isError !== 'boolean' || !Array.isArray(reply.result.content)) {
          return reject(new AcquisitionExecutionError('INVALID_NATIVE_RESULT', 'Native host returned no complete ToolExecutionResult'));
        }
        accept(reply.result);
      } catch (error) { reject(new AcquisitionExecutionError('INVALID_NATIVE_RESULT', `Invalid native IPC result: ${String(error)}`)); }
    });
    child.stdin?.write(`${JSON.stringify({
      runtimeRoot: runtime.runtimeRoot, workspace: scope.isolatedWorkspace, original: scope.sourceWorkspace,
      originalAliases: [scope.sourceWorkspace, resolve(call.workspace)],
      acquisitionId: scope.acquisitionId, toolConfigs,
      toolName: call.toolName, arguments: call.arguments,
      actorSchema: call.actorSchemas.find(schema => schema.name === call.toolName), outputSchema: call.outputSchema,
    })}\n`);
  });
}

/** Trusted small native host; all tool bodies and descendants inherit the OS policy. */
const NATIVE_HOST_SOURCE = String.raw`
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { writeSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const lines = createInterface({ input: process.stdin });
const controller = new AbortController();
let first;
const input = new Promise(accept => { first = accept; });
lines.on('line', line => {
  try { const value = JSON.parse(line); if (value.abort) controller.abort(new Error('Acquisition canceled')); else if (first) { first(value); first = undefined; } }
  catch { controller.abort(new Error('Invalid host control message')); }
});
const request = await input;
const requireNative = createRequire(join(request.runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
const load = async suffix => import(pathToFileURL(requireNative.resolve('@deepseek-ai/' + suffix)).href);
let ctx;
let scope;
let reply;
let cleanupConfirmed = false;
const managedHandles = [];
const inside = (root, path) => { const r = relative(root, path); return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r)); };
async function safePath(raw) {
  if (typeof raw !== 'string') throw new Error('Native path must be a string');
  let target = isAbsolute(raw) ? raw : resolve(request.workspace, raw);
  for (const original of request.originalAliases) if (inside(original, target)) { target = resolve(request.workspace, relative(original, target)); break; }
  if (!inside(request.workspace, target)) throw new Error('Native path is outside the acquisition workspace');
  let existing = target;
  while (true) {
    try { await lstat(existing); break; } catch (error) { if (error.code !== 'ENOENT') throw error; const parent = dirname(existing); if (parent === existing) throw error; existing = parent; }
  }
  if (!inside(request.workspace, await realpath(existing))) throw new Error('Native path follows a symlink outside the acquisition workspace');
  return target;
}
function normalizeSchema(value) {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description').sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, normalizeSchema(v)]));
  return value;
}
function compatibleSchema(native, actor) {
  const base = structuredClone(actor);
  for (const control of ['sandbox_permissions', 'justification', 'run_in_background']) {
    if (base.properties && !(control in (native.properties ?? {}))) delete base.properties[control];
    if (Array.isArray(base.required)) base.required = base.required.filter(name => name !== control);
  }
  if (Array.isArray(base.required) && base.required.length === 0) delete base.required;
  return JSON.stringify(normalizeSchema(native)) === JSON.stringify(normalizeSchema(base));
}
try {
  const { Context } = await load('cordis');
  ctx = new Context();
  for (const [suffix, config] of [
    ['dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false }],
    ['dsh-tools', { mode: 'native' }],
    ['dsh-fs-local', { ...(request.toolConfigs['fs-local'] ?? {}), cwd: request.workspace }],
    ['dsh-subprocess-local', {}],
    ['dsh-bash-local', { ...(request.toolConfigs['bash-local'] ?? {}), cwd: request.workspace }],
    ['dsh-shell-env', { dshHome: process.env.DSH_HOME }],
    // Observation ownership stays in this disposable host. Prior Actor or
    // other-acquisition reads cannot authorize mutations of a fresh copy.
    ['dsh-fs-observation-policy', {}],
    ['dsh-tool-fs', request.toolConfigs['tool-fs'] ?? {}],
    ['dsh-tool-fs-search', { sampleOverCapGlobResults: false, ...(request.toolConfigs['tool-fs-search'] ?? {}) }],
    ['dsh-tool-bash', { enableRunInBackground: false, promoteOnTimeout: false }],
  ]) {
    const plugin = await load(suffix);
    if (suffix === 'dsh-subprocess-local') {
      // The public service seam exposes its own managed-range exit observer.
      // On macOS this is process-group containment: a setsid escape is outside
      // the official provider's guarantee, even though Seatbelt still applies.
      class ObservedSubprocess extends plugin.LocalSubprocessRuntime {
        spawn(spec) { const handle = super.spawn(spec); managedHandles.push(handle); return handle; }
      }
      await ctx.plugin(ObservedSubprocess, config);
    } else await ctx.plugin(plugin.default ?? plugin, config);
  }
  const native = ctx.tools.get(request.toolName);
  if (!native || !compatibleSchema(native.parameters, request.actorSchema.parameters)) throw Object.assign(new Error('Actor schema differs from the implemented native ABI'), { code: 'NATIVE_SCHEMA_MISMATCH' });
  if (request.outputSchema !== undefined && JSON.stringify(normalizeSchema(native.output.schema)) !== JSON.stringify(normalizeSchema(request.outputSchema))) throw Object.assign(new Error('Actor output declaration differs from the native ABI'), { code: 'NATIVE_OUTPUT_SCHEMA_MISMATCH' });
  const agent = { id: request.acquisitionId, session: { header: { cwd: request.workspace } } };
  const { createScope } = await load('dsh-scope');
  await ctx.plugin(Object.assign(inner => { scope = createScope(inner, agent); agent.ctx = scope.ctx; }, { inject: ['tools', 'systemPrompt'] }));
  scope.ctx.tools.register({ ...native, ...request.actorSchema, output: native.output, execute: native.execute });
  scope.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== request.toolName) return { kind: 'deny', reason: 'Only this acquisition capability may execute' };
    const args = exec.arguments;
    if (args && (args.sandbox_permissions !== undefined || args.justification !== undefined || args.run_in_background === true)) return { kind: 'deny', reason: 'Acquisition cannot escalate or detach background jobs' };
    return next();
  });
  const args = structuredClone(request.arguments);
  const fields = { read: ['file_path'], write: ['file_path'], edit: ['file_path'], grep: ['path'], glob: ['path'], bash: ['workdir'] }[request.toolName];
  for (const field of fields ?? []) if (args[field] !== undefined) args[field] = await safePath(args[field]);
  reply = { result: await ctx.tools.execute({ name: request.toolName, arguments: args, callId: request.acquisitionId, agent, signal: controller.signal }) };
} catch (error) { reply = { error: { code: error.code ?? 'NATIVE_ACQUISITION_FAILED', message: error.message ?? String(error) } }; }
finally {
  try {
    await scope?.dispose(); await ctx?.fiber.dispose();
    for (const handle of managedHandles) {
      if (await handle.waitForExit() !== true) throw new Error('Native subprocess managed range did not prove exit');
    }
    cleanupConfirmed = true;
  }
  catch (error) { reply = { error: { code: 'NATIVE_CLEANUP_FAILED', message: error.message ?? String(error) } }; }
  lines.close();
}
writeSync(3, (cleanupConfirmed ? 'quiescent' : 'cleanup-failed') + '\n');
writeSync(3, JSON.stringify(reply));
process.stdin.destroy();
`;
