/** Real dsh CLI instance test. Credentials stay with the default native account provider. */
import { spawn } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runId = process.env.DSH_LIVE_RUN_ID ?? `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('DSH_LIVE_RUN_ID must be a directory name');
const results = resolve(project, 'live-results', runId);
if (existsSync(results)) throw new Error(`Refusing to overwrite live results: ${results}`);
mkdirSync(results, { recursive: true, mode: 0o700 });
const workspace = resolve(results, 'workspace');
cpSync(resolve(project, 'examples/live-pricing-seed'), workspace, { recursive: true });
cpSync(workspace, resolve(results, 'before'), { recursive: true });
const patchPath = resolve(results, 'live.patch.yml');
writeFileSync(patchPath, `- id: agent-default-model\n  config:\n    provider: deepseek-account\n    model: deepseek-flash\n- id: perseus\n  config:\n    enabled: true\n    model: deepseek-flash\n    tools: [read, grep, glob]\n- insert:\n    - id: perseus-live-observer\n      name: ${JSON.stringify(resolve(project, 'scripts/live-observer.mjs'))}\n      config:\n        logPath: ${JSON.stringify(resolve(results, 'diagnostics.jsonl'))}\n`);
if (process.argv.includes('--prepare-only')) {
  console.log(JSON.stringify({ results, workspace, patchPath, prepared: true }));
  process.exit(0);
}
const cli = process.env.DSH_LIVE_CLI ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const args = ['--profile', 'perseus-test', '--patch', patchPath, '--json', '-'];
const started = Date.now();
const output = createWriteStream(resolve(results, 'stdout.jsonl'), { mode: 0o600 });
const errors = createWriteStream(resolve(results, 'stderr.log'), { mode: 0o600 });
const child = spawn(cli, args, { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
writeFileSync(resolve(results, 'process.json'), JSON.stringify({ pid: child.pid, started: new Date(started).toISOString(), cli, args }, null, 2));
child.stdout.pipe(output); child.stderr.pipe(errors);
child.stdin.end(readFileSync(resolve(project, 'examples/live-task.txt')));
let timedOut = false;
let force;
const timeout = setTimeout(() => {
  timedOut = true; child.kill('SIGINT');
  force = setTimeout(() => child.kill('SIGTERM'), 20_000);
}, Number(process.env.DSH_LIVE_TIMEOUT_MS ?? 180_000));
child.once('error', error => { console.error(error.message); });
child.once('close', (code, signal) => {
  clearTimeout(timeout); clearTimeout(force);
  const outcome = { code, signal, timedOut, durationMs: Date.now() - started };
  writeFileSync(resolve(results, 'outcome.json'), JSON.stringify(outcome, null, 2));
  console.log(JSON.stringify({ results, ...outcome }));
  process.exitCode = code ?? 1;
});
