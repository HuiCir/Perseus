import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const executeFile = promisify(execFile);

export class AcquisitionExecutionError extends Error {
  constructor(code, message, receipt) { super(message); this.name = 'AcquisitionExecutionError'; this.code = code; this.receipt = receipt; }
}
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); };
const sbpl = text => JSON.stringify(text);
const checkAbort = signal => { if (signal?.aborted) throw new AcquisitionExecutionError('ABORTED', 'Acquisition was cancelled'); };

export function normalizeAction(action) {
  const tool = action?.tool ?? action?.type ?? action?.kind;
  const args = action?.arguments ?? action;
  if (!['read', 'grep', 'glob', 'command_exec'].includes(tool)) throw new AcquisitionExecutionError('UNSUPPORTED_ACTION', 'The acquisition tool has no isolated native adapter');
  if (tool === 'command_exec') {
    if (!Array.isArray(args.command) || !args.command.length || args.command.some(value => typeof value !== 'string' || value.includes('\0')) || !args.command[0])
      throw new AcquisitionExecutionError('INVALID_ACTION', 'command_exec requires a nonempty argv array without NUL characters');
    const cwd = args.cwd ?? '.';
    if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) throw new AcquisitionExecutionError('INVALID_ACTION', 'A valid scoped cwd is required');
    return { tool, arguments: { command: [...args.command], cwd } };
  }
  const path = args.path ?? (tool === 'read' ? undefined : '.');
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new AcquisitionExecutionError('INVALID_ACTION', 'A valid scoped path is required');
  if (tool !== 'read' && (typeof args.pattern !== 'string' || args.pattern.includes('\0')))
    throw new AcquisitionExecutionError('INVALID_ACTION', 'A valid search pattern is required');
  return { tool, arguments: tool === 'read' ? { path } : { pattern: args.pattern, path } };
}

export function seatbeltProfile({ privateRoot, sourceRoot, home = homedir(), executable, trustedRuntimeRoots = [dirname(dirname(process.execPath))], libraryFiles = [] }) {
  const roots = [...new Set(['/System/Library', '/System/Volumes/Preboot/Cryptexes/OS', '/usr/lib', '/usr/bin', '/bin', ...trustedRuntimeRoots, privateRoot])];
  return ['(version 1)', '(deny default)', '(deny network*)',
    '(allow syscall-unix syscall-mach system-fcntl)',
    // Keep fork/exec descendants in the native command process group.
    // posix_spawn can create a new session in-kernel without a setsid syscall.
    '(deny syscall-unix (syscall-number SYS_setsid SYS_setpgid SYS_posix_spawn))',
    '(allow process-exec process-fork)', '(allow sysctl-read)',
    '(allow process-info* (target self))', '(allow signal (target self))',
    '(allow dynamic-code-generation)', '(allow file-read-metadata file-test-existence)',
    // Apple's system.sb requires the root directory itself for process cwd initialization.
    '(allow file-read* (literal "/"))',
    '(allow file-read-data file-write-data (literal "/dev/fd/0") (literal "/dev/fd/1") (literal "/dev/fd/2"))',
    `(allow file-read* file-map-executable ${roots.map(path => `(subpath ${sbpl(path)})`).join(' ')})`,
    `(allow file-write* (subpath ${sbpl(privateRoot)}) (literal "/dev/null"))`,
    '(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
    `(deny file-read-data file-map-executable process-exec (subpath ${sbpl(sourceRoot)}))`,
    // HOME contents have no ambient allow: only the selected runtime/private paths above
    // are readable. A blanket HOME deny would also block a trusted runtime installed there.
    ...libraryFiles.map(path => `(allow file-read* file-map-executable (literal ${sbpl(path)}))`),
    ...(executable ? [`(allow file-read* file-map-executable (literal ${sbpl(executable)}))`] : [])].join('\n');
}

const libraryCache = new Map();
async function runtimeLibraries(executables) {
  const files = new Set(), inspected = new Set();
  async function inspect(path) {
    if (inspected.has(path) || path.startsWith('/usr/lib/') || path.startsWith('/System/')) return;
    inspected.add(path);
    let canonical;
    try { canonical = await realpath(path); } catch { return; }
    files.add(path); files.add(canonical);
    let task = libraryCache.get(canonical);
    if (!task) { task = executeFile('/usr/bin/otool', ['-L', canonical], { env: {}, maxBuffer: 1024 * 1024 }).then(({ stdout }) => stdout.split('\n').slice(1).map(line => line.trim().split(' (')[0]).filter(Boolean)).catch(() => []); libraryCache.set(canonical, task); }
    for (const name of await task) {
      if (isAbsolute(name)) await inspect(name);
      else if (name.startsWith('@loader_path/')) await inspect(resolve(dirname(canonical), name.slice(13)));
      else if (name.startsWith('@rpath/')) {
        await inspect(join(dirname(canonical), name.slice(7)));
        await inspect(join(dirname(dirname(canonical)), 'lib', name.slice(7)));
      }
    }
  }
  for (const executable of executables.filter(Boolean)) await inspect(executable);
  return [...files];
}

async function runtimeRoots(extraRoots) {
  const node = await realpath(process.execPath), roots = [dirname(dirname(node))];
  const pythonRoot = join(dirname(roots[0]), 'python');
  try { await access(join(pythonRoot, 'bin', 'python3'), constants.X_OK); roots.push(await realpath(pythonRoot)); } catch {}
  for (const root of extraRoots) roots.push(await realpath(root));
  return [...new Set(roots)].filter(root => !['/', '/Users', homedir()].includes(root));
}

async function snapshot(sourceRoot, destination, signal) {
  const files = [], directories = [], inodes = new Map();
  async function scan(path, rel = '') {
    checkAbort(signal);
    const stat = await lstat(path, { bigint: true });
    if (stat.isSymbolicLink()) throw new AcquisitionExecutionError('UNSAFE_WORKSPACE', 'Workspace symlinks are unsupported');
    if (stat.isDirectory()) {
      directories.push(rel);
      for (const name of (await readdir(path)).sort()) await scan(join(path, name), join(rel, name));
    } else if (stat.isFile()) {
      const key = `${stat.dev}:${stat.ino}`;
      const inode = inodes.get(key) ?? { count: 0n, links: stat.nlink }; inode.count++; inodes.set(key, inode);
      files.push({ path, rel, stat });
    } else throw new AcquisitionExecutionError('UNSAFE_WORKSPACE', 'Workspace special files are unsupported');
  }
  await scan(sourceRoot);
  for (const inode of inodes.values()) if (inode.links > inode.count)
    throw new AcquisitionExecutionError('UNSAFE_WORKSPACE', 'Workspace hardlinks extend outside the snapshot');
  for (const rel of directories) { checkAbort(signal); await mkdir(join(destination, rel), { recursive: true, mode: 0o700 }); }
  for (const file of files) {
    checkAbort(signal);
    const input = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let output;
    try {
      const current = await input.stat({ bigint: true });
      if (!current.isFile() || current.dev !== file.stat.dev || current.ino !== file.stat.ino || current.nlink !== file.stat.nlink)
        throw new AcquisitionExecutionError('WORKSPACE_CHANGED', 'Workspace topology changed while copying');
      output = await open(join(destination, file.rel), 'wx', Number(file.stat.mode & 0o777n));
      const buffer = Buffer.allocUnsafe(128 * 1024);
      while (true) {
        checkAbort(signal);
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        for (let offset = 0; offset < bytesRead;) {
          checkAbort(signal);
          const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null);
          if (bytesWritten === 0) throw new AcquisitionExecutionError('SNAPSHOT_FAILED', 'Snapshot write made no progress');
          offset += bytesWritten;
        }
      }
    } finally { await input.close(); await output?.close(); }
  }
}

async function findRg(preferred) {
  for (const path of preferred ? [preferred] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(p => join(p, 'rg'))) {
    try { await access(path, constants.X_OK); return await realpath(path); } catch {}
  }
  throw new AcquisitionExecutionError('RG_UNAVAILABLE', 'The ripgrep executable was not found');
}

/** Each acquisition owns a fresh copy; native commands execute under an additional OS boundary. */
export class ExecutionManager {
  constructor({ client, sourceRoot, tempRoot = tmpdir(), rgExecutable, trustedRuntimeRoots = [], cancellationGraceMs = 5000, platform = process.platform } = {}) {
    if (!client || !sourceRoot || !Array.isArray(trustedRuntimeRoots) || trustedRuntimeRoots.some(root => typeof root !== 'string' || !isAbsolute(root) || root.includes('\0') || inside(resolve(root), homedir())) || !Number.isInteger(cancellationGraceMs) || cancellationGraceMs < 1) throw new TypeError('Invalid execution options');
    this.client = client; this.sourceRoot = resolve(sourceRoot); this.tempRoot = resolve(tempRoot);
    this.rgExecutable = rgExecutable; this.trustedRuntimeRoots = trustedRuntimeRoots; this.cancellationGraceMs = cancellationGraceMs; this.platform = platform;
    this.abortController = new AbortController(); this.active = new Set(); this.closed = false; this.retainedRoots = new Set();
  }
  canExecute(tool) { return ['read', 'grep', 'glob', 'command_exec'].includes(tool); }
  get pendingAcquisitions() { return this.active.size; }
  acquire(action, options = {}) {
    if (this.closed) return Promise.reject(new AcquisitionExecutionError('EXECUTOR_CLOSED', 'Acquisition executor is closed'));
    const signal = options.signal ? AbortSignal.any([options.signal, this.abortController.signal]) : this.abortController.signal;
    const work = this.run(action, signal); this.active.add(work);
    work.finally(() => this.active.delete(work)).catch(() => {}); return work;
  }
  async run(rawAction, signal) {
    const action = normalizeAction(rawAction); checkAbort(signal);
    if (this.platform !== 'darwin') throw new AcquisitionExecutionError('ISOLATION_UNAVAILABLE', 'Acquisitions require macOS Seatbelt; no unconfined fallback is available');
    await access('/usr/bin/sandbox-exec', constants.X_OK);
    const sourceRoot = await realpath(this.sourceRoot);
    if (inside(sourceRoot, await realpath(homedir()))) throw new AcquisitionExecutionError('UNSAFE_WORKSPACE', 'The source workspace cannot contain the host home directory');
    await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
    const tempRoot = await realpath(this.tempRoot);
    if (inside(sourceRoot, tempRoot)) throw new AcquisitionExecutionError('UNSAFE_TEMP_ROOT', 'Acquisition temp storage must be outside the source workspace');
    const requested = action.tool === 'command_exec' ? action.arguments.cwd : action.arguments.path;
    const sourcePath = isAbsolute(requested) ? resolve(requested) : resolve(sourceRoot, requested);
    if (!inside(sourceRoot, sourcePath)) throw new AcquisitionExecutionError('PATH_ESCAPE', 'Acquisition path leaves the source workspace');
    const relativePath = relative(sourceRoot, sourcePath) || '.';
    const privateRoot = await mkdtemp(join(tempRoot, 'perseus-codex-acquisition-')); await chmod(privateRoot, 0o700);
    const workspace = join(privateRoot, 'workspace'), privateTemp = join(privateRoot, 'tmp'), privateHome = join(privateRoot, 'home');
    const receipt = { acquisitionId: randomUUID(), provider: 'codex-native-command', sourceRoot, independentRoot: privateRoot,
      workspace, snapshotStartedAt: 0, snapshotFinishedAt: 0, merged: false, isolation: 'macos-seatbelt', network: 'denied', nativeSandbox: 'externalSandbox', subprocessPolicy: 'fork-exec-only-no-detachment' };
    let cleanupConfirmed = true;
    try {
      await mkdir(privateTemp); await mkdir(privateHome);
      receipt.snapshotStartedAt = Date.now(); await snapshot(sourceRoot, workspace, signal); receipt.snapshotFinishedAt = Date.now();
      checkAbort(signal);
      const selectedRoots = await runtimeRoots(this.trustedRuntimeRoots);
      if (selectedRoots.some(root => inside(sourceRoot, root) || inside(root, sourceRoot)))
        throw new AcquisitionExecutionError('UNSAFE_RUNTIME_ROOT', 'Trusted runtime roots must not overlap the source workspace');
      const executable = action.tool === 'command_exec' ? undefined : action.tool === 'read' ? '/bin/cat' : await findRg(this.rgExecutable);
      const command = action.tool === 'command_exec' ? action.arguments.command : action.tool === 'read' ? [executable, '--', relativePath] : action.tool === 'grep' ?
        [executable, '--no-config', '--color=never', '--no-heading', '--line-number', '--with-filename', '--hidden', '--no-ignore', '--sort', 'path', '--', action.arguments.pattern, relativePath] :
        [executable, '--no-config', '--files', '--hidden', '--no-ignore', '--sort', 'path', `--glob=${action.arguments.pattern}`, '--', relativePath];
      const profile = join(privateRoot, 'acquisition.sb');
      const libraryFiles = await runtimeLibraries([process.execPath, executable, ...selectedRoots.map(root => join(root, 'bin', 'python3'))]);
      await writeFile(profile, seatbeltProfile({ privateRoot, sourceRoot, executable, trustedRuntimeRoots: selectedRoots, libraryFiles }), { mode: 0o600 });
      const environment = { ...Object.fromEntries(Object.keys(process.env).map(name => [name, null])),
        HOME: privateHome, TMPDIR: privateTemp, TMP: privateTemp, TEMP: privateTemp, RIPGREP_CONFIG_PATH: null };
      const isolatedEnvironment = ['HOME=' + privateHome, 'TMPDIR=' + privateTemp, 'TMP=' + privateTemp, 'TEMP=' + privateTemp,
        'PATH=' + [...selectedRoots.map(root => join(root, 'bin')), '/usr/bin', '/bin'].join(delimiter), 'LANG=en_US.UTF-8', 'OPENSSL_CONF=/dev/null'];
      const processId = `perseus-${receipt.acquisitionId}`, chunks = { stdout: [], stderr: [] };
      let truncated = false, finished = false;
      const unsubscribe = this.client.onNotification(({ method, params }) => {
        if (method !== 'command/exec/outputDelta' || params?.processId !== processId || !['stdout', 'stderr'].includes(params.stream)) return;
        chunks[params.stream].push(Buffer.from(params.deltaBase64, 'base64')); truncated ||= params.capReached === true;
      });
      const request = this.client.request('command/exec', { processId,
        command: ['/usr/bin/sandbox-exec', '-f', profile, '/usr/bin/env', '-i', ...isolatedEnvironment, ...command], cwd: action.tool === 'command_exec' ? join(workspace, relativePath) : workspace,
        // Codex's Seatbelt forbids sandbox_apply inside it. The fixed argv above applies our
        // stronger acquisition boundary; externalSandbox skips only the conflicting inner layer.
        sandboxPolicy: { type: 'externalSandbox', networkAccess: 'restricted' }, streamStdoutStderr: true,
        disableOutputCap: true, disableTimeout: true,
        env: environment });
      const completion = request.then(result => { finished = true; return result; }, error => { finished = true; cleanupConfirmed = false; throw error; });
      let cancelWork;
      const abort = () => {
        cancelWork ??= this.client.request('command/exec/terminate', { processId }).catch(() => {});
      };
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      let cancellationTimer;
      const cancelled = new Promise((_, reject) => {
        const timeout = () => { cancellationTimer = setTimeout(() => {
          if (!finished) { cleanupConfirmed = false; reject(new AcquisitionExecutionError('CLEANUP_UNCONFIRMED', 'Native command cancellation did not reach completion', receipt)); }
        }, this.cancellationGraceMs); };
        signal.addEventListener('abort', timeout, { once: true });
        if (signal.aborted) timeout();
        receipt.removeCancellationTimer = () => signal.removeEventListener('abort', timeout);
      });
      let result;
      // The command's final response proves completion; a lost terminate acknowledgement cannot delay cleanup.
      try { result = await Promise.race([completion, cancelled]); }
      finally { unsubscribe(); signal.removeEventListener('abort', abort); receipt.removeCancellationTimer(); delete receipt.removeCancellationTimer; clearTimeout(cancellationTimer); }
      checkAbort(signal);
      if (truncated) throw new AcquisitionExecutionError('INCOMPLETE_RESULT', 'Native output was capped despite disableOutputCap', receipt);
      if (!result || !Number.isInteger(result.exitCode) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string')
        throw new AcquisitionExecutionError('INVALID_NATIVE_RESULT', 'Native command returned an invalid response', receipt);
      return { result: { ...result, stdout: Buffer.concat(chunks.stdout).toString('utf8') + result.stdout,
        stderr: Buffer.concat(chunks.stderr).toString('utf8') + result.stderr }, receipt };
    } catch (error) {
      if (signal.aborted && cleanupConfirmed && error.code !== 'CLEANUP_UNCONFIRMED')
        throw new AcquisitionExecutionError('ABORTED', 'Acquisition was cancelled after native cleanup', receipt);
      if (!cleanupConfirmed) throw new AcquisitionExecutionError('CLEANUP_UNCONFIRMED', 'Native command cleanup could not be confirmed; private copy retained', receipt);
      throw error;
    } finally {
      if (cleanupConfirmed) await rm(privateRoot, { recursive: true, force: true }); else this.retainedRoots.add(privateRoot);
    }
  }
  cancel() { this.abortController.abort(); }
  async settleClose() {
    this.closed = true; this.cancel(); await Promise.allSettled([...this.active]);
    if (this.retainedRoots.size) throw new AcquisitionExecutionError('CLEANUP_UNCONFIRMED', 'Unconfirmed native commands retain private acquisition copies');
    return { quiescent: true, pendingAcquisitions: 0 };
  }
  close() { return this.settleClose(); }
}
