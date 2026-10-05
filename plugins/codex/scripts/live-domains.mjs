// Explicit native-account validation of the dynamic branch and its real Luna cache.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { RpcClient } from '../src/rpc.mjs';
import { WorkerPool } from '../src/worker.mjs';
import { ExecutionManager } from '../src/execution.mjs';
import { ToolRegistry, COMMAND_TOOL } from '../src/tool-registry.mjs';
import { WORKER_HOST_CONFIG, DEFAULT_CONFIG } from '../src/config.mjs';
import { disableInheritedMcp } from '../src/host-policy.mjs';

const output = resolve(process.argv[2] ?? 'live-results/dynamic-domains/worker-validation.json');
const root = await mkdtemp(join(tmpdir(), 'perseus-live-domains-'));
const workspace = join(root, 'workspace'); await mkdir(workspace);
await writeFile(join(workspace, 'calc.mjs'), 'export const sum = (a,b) => a-b;\n');
await writeFile(join(workspace, 'calc.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {sum} from './calc.mjs'; test('adds',()=>assert.equal(sum(4,3),7));\n");
const events = [], acquisitions = [], turns = [];
let client, executor, result;
const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 360000);
try {
  const hostCwd = join(root, 'host'); await mkdir(hostCwd);
  const mcpPolicy = await disableInheritedMcp({ cwd: hostCwd, configOverrides: WORKER_HOST_CONFIG });
  client = await RpcClient.create({ cwd: hostCwd, experimentalApi: true, configOverrides: { ...WORKER_HOST_CONFIG, ...mcpPolicy } });
  executor = new ExecutionManager({ client, sourceRoot: workspace, tempRoot: join(root, 'copies') });
  const registry = new ToolRegistry({ tools: [COMMAND_TOOL], canExecute: tool => executor.canExecute(tool) });
  const pool = new WorkerPool({ client, dataRoot: join(root, 'workers'), emit: event => events.push(event) });
  const seed = { tool: 'command_exec', arguments: { command: [process.execPath, '-e', "console.log(require('fs').readFileSync('calc.mjs','utf8')); console.log(require('fs').readFileSync('calc.test.mjs','utf8'))"] } };
  const native = await executor.acquire(seed, { signal: controller.signal });
  if (native.result.exitCode !== 0) throw new Error('Native fixture inspection failed');
  const facts = [{ kind: 'user_prompt', prompt: 'Inspect this local addition bug. Propose a useful independent test command with the assigned Node executable; use --test --test-isolation=none calc.test.mjs and cwd ".". The Actor owns the fix. Do not produce the final answer.' },
    { kind: 'tool_observation', tool: seed.tool, arguments: seed.arguments, result: native.result }];
  const first = registry.derive(facts), positive = first.find(domain => domain.predicate), complement = first.find(domain => !domain.predicate);
  if (!positive || !complement) throw new Error('Typed native observation did not derive head and complement');
  for (let revision = 1; revision <= 2; revision++) {
    if (revision === 2) {
      // This is a real test-driver native observation, not speculative feedback.
      const other = { tool: 'command_exec', arguments: { command: ['/bin/echo', 'independent native progress'] } };
      const actual = await executor.acquire(other, { signal: controller.signal });
      if (actual.result.exitCode !== 0) throw new Error('Native progress probe failed');
      facts.push({ kind: 'tool_observation', tool: other.tool, arguments: other.arguments, result: actual.result });
    }
    const domains = registry.derive(facts), domain = domains.find(domain => domain.id === positive.id);
    const actions = [];
    for await (const action of pool.generate(domain, facts, { signal: controller.signal, revision, epoch: 0 })) {
      const prepared = registry.prepare(domain, action);
      actions.push(prepared.action);
      const outcome = await executor.acquire(prepared.action, { signal: controller.signal });
      acquisitions.push({ revision, action: prepared.action, ...outcome });
    }
    turns.push({ revision, actions, domainId: domain.id, cacheIdentity: domain.cacheIdentity,
      complementIdentity: domains.find(domain => !domain.predicate)?.cacheIdentity });
  }
  const starts = events.filter(event => event.event === 'worker_model_start');
  const usage = events.filter(event => event.event === 'worker_usage').map(event => ({ revision: event.revision, ...event.usage }));
  const checks = { twoCompletedGenerations: turns.length === 2 && events.filter(event => event.event === 'worker_model_end').length === 2,
    usefulFirstAcquisition: turns[0].actions.length > 0,
    positiveIdentityStable: starts.length === 2 && starts[0].promptIdentity === starts[1].promptIdentity,
    complementChanged: turns[0].complementIdentity !== turns[1].complementIdentity,
    nativeCachedInputReported: usage.some(entry => entry.revision === 2 && entry.cachedInputTokens > 0),
    fullIndependentResults: acquisitions.every(entry => entry.receipt.merged === false && entry.receipt.network === 'denied' && typeof entry.result.stderr === 'string'),
    meaningfulTestResult: acquisitions.some(entry => entry.result.stdout.includes('adds') && entry.result.stdout.includes('1 !== 7')),
    actorSourceUnchanged: await readFile(join(workspace, 'calc.mjs'), 'utf8') === 'export const sum = (a,b) => a-b;\n' };
  result = { passed: Object.values(checks).every(Boolean), kind: 'native-luna-dynamic-domain-validation',
    mainline: 'Test driver records real command/exec observations; this is not an Actor inference benchmark.',
    runtime: client.runtime, models: DEFAULT_CONFIG, checks, turns, usage, acquisitions, events };
  if (!result.passed) process.exitCode = 1;
} catch (error) {
  result = { passed: false, message: error.message, events, turns, acquisitions }; process.exitCode = 1;
} finally {
  clearTimeout(timer); const cleanup = {};
  try { cleanup.executor = await executor?.settleClose(); } catch { cleanup.executor = { quiescent: false }; process.exitCode = 1; }
  try { cleanup.host = await client?.close(); } catch { cleanup.host = { quiescent: false }; process.exitCode = 1; }
  await rm(root, { recursive: true, force: true });
  result.cleanup = cleanup; if (process.exitCode) result.passed = false;
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ output, passed: result.passed, checks: result.checks, usage: result.usage, message: result.message }));
}
