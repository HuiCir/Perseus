import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const sha256 = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const textOf = (item) => (item.content ?? []).map((part) => part.text ?? '').join('');
export const allText = (input) => (input ?? []).map(textOf).join('\n');
export const toolsOf = (body) => [...(body.tools ?? []), ...(body.input ?? []).filter((item) => item.type === 'additional_tools').flatMap((item) => item.tools ?? [])];
export const initialInstructions = (body) => (body.input ?? []).filter((item) => item.type === 'message' && ['developer', 'system'].includes(item.role)).map(textOf);
export function codexBinary() {
  const candidates = [process.env.CODEX_TEST_BINARY, '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', '/Applications/Codex.app/Contents/Resources/codex'];
  return candidates.find((path) => path && existsSync(path));
}
export function cleanEnvironment(home) {
  // Deliberately do not inherit provider credentials, proxy headers, or user
  // auth files. Codex may write its own runtime files only to this temporary home.
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: tmpdir(),
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8',
    CODEX_HOME: home,
    PERSEUS_FAKE_API_KEY: 'test-only',
  };
}
export async function command(binary, args, options) {
  const child = spawn(binary, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
  child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const [code, signal] = await once(child, 'exit');
  clearTimeout(timer);
  if (code !== 0) throw new Error(`Native CLI ${args.slice(0, 3).join(' ')} failed (${code ?? signal}): ${stderr.slice(-4000)}`);
  return { stdout, stderr };
}

export class AppServer {
  constructor(binary, options) {
    // Tests that execute audited fixture hooks supply a transient thread-level
    // bypass_hook_trust config; the host itself never persists hook trust.
    this.child = spawn(binary, ['app-server', '--stdio'], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.notifications = [];
    this.nextId = 1;
    this.stderr = '';
    let buffer = '';
    this.child.stdout.setEncoding('utf8').on('data', (part) => {
      buffer += part;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== undefined && !message.method) {
          const task = this.pending.get(message.id);
          if (task) {
            this.pending.delete(message.id);
            clearTimeout(task.timer);
            message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
          }
        } else if (message.method && message.id !== undefined) {
          this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Fixture has no dynamic client tools.' } });
        } else if (message.method) {
          this.notifications.push(message);
        }
      }
    });
    this.child.stderr.setEncoding('utf8').on('data', (part) => { this.stderr += part; });
    this.child.on('exit', (code) => {
      for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error(`App server exited ${code}: ${this.stderr.slice(-3000)}`)); }
      this.pending.clear();
    });
  }
  send(message) { this.child.stdin.write(JSON.stringify(message) + '\n'); }
  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App-server ${method} timeout: ${this.stderr.slice(-3000)}`));
      }, 20_000);
      this.pending.set(id, { resolve: resolveCall, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  async initialize() {
    const result = await this.call('initialize', {
      clientInfo: { name: 'perseus-native-fixture', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    return result;
  }
  async until(method, predicate = () => true, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const notification = this.notifications.find((entry) => entry.method === method && predicate(entry.params));
      if (notification) return notification.params;
      if (this.child.exitCode !== null) throw new Error(`App server stopped: ${this.stderr.slice(-3000)}`);
      await delay(10);
    }
    throw new Error(`Missing ${method}; methods=${[...new Set(this.notifications.map((entry) => entry.method))].join(',')}; stderr=${this.stderr.slice(-3000)}`);
  }
  async close() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    await once(this.child, 'exit');
    clearTimeout(timer);
  }
}

export async function temporaryMarketplace({ fixtureHooks = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'perseus-native-hooks-'));
  const home = join(root, 'codex-home');
  const workspace = join(root, 'workspace');
  const market = join(root, 'marketplace');
  const plugin = join(market, 'plugins', 'perseus');
  await Promise.all([mkdir(home), mkdir(workspace), mkdir(plugin, { recursive: true }), mkdir(join(market, '.agents', 'plugins'), { recursive: true })]);
  for (const path of ['.codex-plugin', 'hooks']) await cp(join(packageRoot, path), join(plugin, path), { recursive: true });
  await mkdir(join(plugin, 'scripts'));
  if (fixtureHooks) {
    // This fixture replaces only lifecycle hooks; it does not ship the real MCP executor.
    const manifestPath = join(plugin, '.codex-plugin', 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    delete manifest.mcpServers;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    await cp(join(packageRoot, 'test', 'fixtures', 'native-hook.mjs'), join(plugin, 'scripts', 'native-hook-fixture.mjs'));
    const hooks = JSON.parse(await readFile(join(plugin, 'hooks', 'hooks.json'), 'utf8'));
    const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
    for (const groups of Object.values(hooks.hooks)) for (const group of groups) for (const handler of group.hooks) {
      handler.command = `${quote(process.execPath)} "\${PLUGIN_ROOT}/scripts/native-hook-fixture.mjs" ${quote(root)}`;
    }
    await writeFile(join(plugin, 'hooks', 'hooks.json'), JSON.stringify(hooks, null, 2) + '\n');
  } else {
    await cp(join(packageRoot, '.mcp.json'), join(plugin, '.mcp.json'));
    for (const path of ['scripts', 'lib', 'src']) if (existsSync(join(packageRoot, path))) await cp(join(packageRoot, path), join(plugin, path), { recursive: true });
  }
  await writeFile(join(market, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
    name: 'perseus-native-fixture',
    plugins: [{ name: 'perseus', source: { source: 'local', path: './plugins/perseus' }, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Productivity' }],
  }, null, 2) + '\n');
  return { root, home, workspace, market, plugin, env: cleanEnvironment(home) };
}

function findTool(tools, namespace) {
  let codeMode;
  for (const entry of tools ?? []) {
    if (entry.type === 'namespace') { const nested = findTool(entry.tools, entry.name); if (nested?.kind === 'function') return nested; if (nested) codeMode = nested; }
    if (entry.type === 'function' && entry.name === 'exec_command') return { kind: 'function', name: entry.name, ...(namespace ? { namespace } : {}) };
    if (entry.type === 'custom' && entry.name === 'exec') codeMode = { kind: 'custom', name: entry.name, ...(namespace ? { namespace } : {}) };
  }
  return codeMode;
}
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

export async function fakeResponses(fixture) {
  const requests = [];
  const errors = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-6-sol', object: 'model', owned_by: 'fixture' }] })); return;
      }
      if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
      let raw = ''; for await (const part of req) raw += part;
      const request = JSON.parse(raw);
      const index = requests.length;
      requests.push({ body: request, at: Date.now(), authorizationIsFake: req.headers.authorization === 'Bearer test-only' });
      if (index === 0) await writeFile(join(fixture.root, 'request-zero-started'), 'ready\n');
      if (index === 1) await writeFile(join(fixture.root, 'request-one-started'), 'ready\n');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      let sequence = 0;
      const emit = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`);
      const responseId = `resp_perseus_fixture_${index}`;
      emit('response.created', { response: { id: responseId, object: 'response', model: 'gpt-6-sol', status: 'in_progress', output: [] } });
      const output = [];
      if (index < 2) {
        let tool;
        try { tool = findTool(toolsOf(request)); if (!tool) throw new Error('Native execution schema was not offered by Codex.'); }
        catch (error) { throw new Error(`${error.message}; requestKeys=${Object.keys(request).join(',')}; inputTypes=${(request.input ?? []).map((item) => item.type).join(',')}`); }
        const path = join(fixture.workspace, index === 0 ? 'actor-first.txt' : 'actor-second.txt');
        const script = `require('node:fs').writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(`native-${index}`)}); setTimeout(() => console.log('native-tool-ok-${index}'), 450);`;
        const nativeCommand = `${quote(process.execPath)} -e ${quote(script)}`;
        requests[index].nativeCommandHash = sha256(JSON.stringify(nativeCommand));
        const args = JSON.stringify({ cmd: nativeCommand, yield_time_ms: 1000, max_output_tokens: 200 });
        const { kind, ...name } = tool;
        const item = kind === 'custom'
          ? { type: 'custom_tool_call', id: `fc_fixture_${index}`, call_id: `call_fixture_${index}`, ...name, input: `const result = await tools.exec_command(${args}); text(result);` }
          : { type: 'function_call', id: `fc_fixture_${index}`, call_id: `call_fixture_${index}`, ...name, arguments: args };
        emit('response.output_item.added', { output_index: 0, item: { ...item, ...(kind === 'custom' ? { input: '' } : { arguments: '' }) } });
        emit(kind === 'custom' ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', { output_index: 0, item_id: item.id, delta: kind === 'custom' ? item.input : args });
        emit(kind === 'custom' ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done', { output_index: 0, item_id: item.id, ...(kind === 'custom' ? { input: item.input } : { arguments: args }) });
        emit('response.output_item.done', { output_index: 0, item });
        output.push(item);
        // Keep the request open while hooks/work begin. The worker gates above
        // prove Codex sent this request before awaiting async hook completion.
        await delay(350);
      } else {
        const item = { type: 'message', id: 'msg_fixture_final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Native fixture finished.', annotations: [] }] };
        emit('response.output_item.added', { output_index: 0, item: { ...item, content: [] } });
        emit('response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        emit('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: 'Native fixture finished.' });
        emit('response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text: 'Native fixture finished.' });
        emit('response.output_item.done', { output_index: 0, item });
        output.push(item);
      }
      const usage = { input_tokens: 16_384 + index * 1024, input_tokens_details: { cached_tokens: index === 0 ? 0 : 4096 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 16_484 + index * 1024 };
      emit('response.completed', { response: { id: responseId, object: 'response', model: 'gpt-6-sol', status: 'completed', output, usage } });
      res.end();
    } catch (error) {
      errors.push(error.message);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message, type: 'fixture_error' } }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  return { url, requests, errors, close: async () => { server.closeAllConnections(); await new Promise((resolveClose) => server.close(resolveClose)); } };
}

export async function configure(fixture, url) {
  await writeFile(join(fixture.home, 'config.toml'), `model = "gpt-6-sol"\nmodel_provider = "perseus-fake"\ncli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\nweb_search = "disabled"\n\n[features]\nhooks = true\ncode_mode = false\nunified_exec = true\nremote_plugin = false\n\n[model_providers.perseus-fake]\nname = "Perseus local fake Responses fixture"\nbase_url = ${JSON.stringify(url)}\nwire_api = "responses"\nenv_key = "PERSEUS_FAKE_API_KEY"\nrequires_openai_auth = false\nsupports_websockets = false\n\n[analytics]\nenabled = false\n`);
}

export async function installFixture(binary, fixture) {
  const options = { env: fixture.env, cwd: fixture.workspace };
  await command(binary, ['plugin', 'marketplace', 'add', fixture.market], options);
  const installation = JSON.parse((await command(binary, ['plugin', 'add', 'perseus@perseus-native-fixture', '--json'], options)).stdout);
  const listing = JSON.parse((await command(binary, ['plugin', 'list', '--marketplace', 'perseus-native-fixture', '--json'], options)).stdout);
  return { installation, listing };
}
