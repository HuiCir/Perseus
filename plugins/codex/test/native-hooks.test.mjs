import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_EVIDENCE, POST_EVIDENCE } from './fixtures/native-hook.mjs';
import { AppServer, allText, codexBinary, command, configure, fakeResponses, initialInstructions, installFixture, sha256, temporaryMarketplace, textOf, toolsOf } from './fixtures/native-harness.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const json = async (path) => JSON.parse(await readFile(join(root, path), 'utf8'));

test('portable and compatibility manifests declare the same bounded native hook contract', async () => {
  const manifest = await json('packaging/portable-plugin.json');
  const fallback = await json('.codex-plugin/plugin.json');
  const hooks = (await json('hooks/hooks.json')).hooks;
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, fallback.name);
  assert.equal(manifest.version, fallback.version);
  assert.equal(manifest.extensions['com.openai'].hooks, fallback.hooks);
  await assert.rejects(stat(join(root, 'plugin.json')), { code: 'ENOENT' }, 'portable template must not mask native compatibility hooks');
  assert.deepEqual(Object.keys(hooks).sort(), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Interrupt', 'PreCompact', 'PostCompact', 'SessionEnd'].sort());
  for (const [event, groups] of Object.entries(hooks)) {
    const handler = groups[0].hooks[0];
    assert.equal(handler.type, 'command');
    assert.equal(handler.command, 'node "${PLUGIN_ROOT}/scripts/hook.mjs"');
    assert.equal(handler.async === true, ['UserPromptSubmit', 'PostToolUse'].includes(event));
    assert.equal(handler.timeout, handler.async ? 120 : 3);
    if (['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'].includes(event)) assert.equal(handler.additionalContextLimit, 0);
    else assert.equal(handler.additionalContextLimit, undefined);
  }
});

test('the actual distributable installs and exposes all production hook definitions', { timeout: 45_000 }, async (t) => {
  const binary = codexBinary();
  if (!binary) { t.skip('Set CODEX_TEST_BINARY to a Codex runtime with native Hooks support.'); return; }
  const fixture = await temporaryMarketplace({ fixtureHooks: false });
  let app;
  t.after(async () => { await app?.close(); await rm(fixture.root, { recursive: true, force: true }); });
  const packageResult = await command(process.execPath, [join(root, 'scripts', 'pack.mjs'), join(fixture.root, 'packed')], { cwd: root, env: fixture.env });
  const packed = JSON.parse(packageResult.stdout);
  assert.equal(packed.layout, 'codex-compatibility');
  assert.match(packed.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(stat(join(packed.marketplace, 'plugins', 'perseus', 'plugin.json')), { code: 'ENOENT' });
  await configure(fixture, 'http://127.0.0.1:1/v1');
  const options = { env: fixture.env, cwd: fixture.workspace };
  await command(binary, ['plugin', 'marketplace', 'add', packed.marketplace], options);
  await command(binary, ['plugin', 'add', 'perseus@perseus-local', '--json'], options);
  const listing = JSON.parse((await command(binary, ['plugin', 'list', '--marketplace', 'perseus-local', '--json'], options)).stdout);
  assert.equal(listing.installed[0].enabled, true);
  app = new AppServer(binary, options);
  await app.initialize();
  const hooks = await app.call('hooks/list', { cwds: [fixture.workspace] });
  assert.deepEqual(hooks.data.flatMap((entry) => entry.errors), []);
  assert.deepEqual(hooks.data.flatMap((entry) => entry.warnings), []);
  const loaded = hooks.data.flatMap((entry) => entry.hooks).filter((hook) => hook.pluginId === 'perseus@perseus-local');
  assert.equal(loaded.length, 9);
  assert.ok(loaded.every((hook) => hook.command.includes('/scripts/hook.mjs') && !hook.command.includes('fixture')));
  assert.ok(loaded.every((hook) => hook.trustStatus === 'untrusted'), 'installation does not persist hook trust');
  assert.equal(loaded.filter((hook) => hook.async).length, 2);
  assert.ok(!(await readdir(fixture.home)).includes('auth.json'));
});

test('installed native Codex appends ready async context, preserves its actor calls and old prefix', { timeout: 60_000 }, async (t) => {
  const binary = codexBinary();
  if (!binary) { t.skip('Set CODEX_TEST_BINARY to a Codex runtime with native Hooks support.'); return; }
  const fixture = await temporaryMarketplace();
  if (process.env.PERSEUS_KEEP_NATIVE_FIXTURE === '1') t.diagnostic(`Fixture directory: ${fixture.root}`);
  const fake = await fakeResponses(fixture);
  let app;
  t.after(async () => {
    await app?.close();
    await fake.close();
    if (process.env.PERSEUS_KEEP_NATIVE_FIXTURE !== '1') await rm(fixture.root, { recursive: true, force: true });
  });
  await configure(fixture, fake.url);
  const installed = await installFixture(binary, fixture);
  assert.match(JSON.stringify(installed.listing), /perseus/);
  app = new AppServer(binary, { env: fixture.env, cwd: fixture.workspace });
  const initialization = await app.initialize();
  const listed = await app.call('hooks/list', { cwds: [fixture.workspace] });
  assert.deepEqual(listed.data.flatMap((entry) => entry.errors), []);
  const loaded = listed.data.flatMap((entry) => entry.hooks).filter((hook) => hook.source === 'plugin');
  assert.equal(loaded.length, 9, `all installed plugin handlers discovered: ${JSON.stringify(listed)}`);
  assert.equal(loaded.find((hook) => hook.eventName === 'userPromptSubmit').async, true);
  assert.equal(loaded.find((hook) => hook.eventName === 'postToolUse').additionalContextLimit, 0);

  const started = await app.call('thread/start', {
    model: 'gpt-6-sol', modelProvider: 'perseus-fake', cwd: fixture.workspace,
    approvalPolicy: 'never', sandbox: 'danger-full-access',
    baseInstructions: 'FIXED_NATIVE_ACTOR_INSTRUCTIONS. Execute the requested native fixture tool and report completion.',
    developerInstructions: 'FIXED_NATIVE_DEVELOPER_INSTRUCTIONS.',
    config: { bypass_hook_trust: true },
  });
  const threadId = started.thread.id;
  await app.call('turn/start', { threadId, input: [{ type: 'text', text: 'Run the native fake-provider fixture.', text_elements: [] }] });
  const completed = await app.until('turn/completed', (params) => params.threadId === threadId);
  assert.equal(completed.turn.status, 'completed', JSON.stringify(completed.turn.error));
  assert.deepEqual(fake.errors, []);
  assert.equal(fake.requests.length, 3);
  assert.ok(fake.requests.every((request) => request.authorizationIsFake));
  const bodies = fake.requests.map((request) => request.body);
  assert.ok(bodies.every((body) => body.model === 'gpt-6-sol'));
  assert.ok(initialInstructions(bodies[0]).join('\n').includes('FIXED_NATIVE_ACTOR_INSTRUCTIONS'));
  assert.ok(toolsOf(bodies[0]).length > 0, 'native tool schemas are present in the request');
  for (let index = 1; index < bodies.length; index++) {
    const next = bodies[index];
    const previous = bodies[index - 1];
    assert.equal(next.instructions, bodies[0].instructions, 'native instructions remain fixed');
    assert.deepEqual(toolsOf(next), toolsOf(bodies[0]), 'native offered tool schemas remain fixed');
    assert.deepEqual(next.input.slice(0, previous.input.length), previous.input, 'the complete preceding native request remains an exact prefix');
  }
  assert.ok(!allText(bodies[0].input).includes('USER_EVIDENCE_END'));
  assert.ok(allText(bodies[1].input).includes(USER_EVIDENCE), 'first async evidence delivered complete, without spilling');
  assert.ok(!allText(bodies[1].input).includes('POST_EVIDENCE_END'), 'pending second evidence is not awaited');
  assert.ok(allText(bodies[2].input).includes(USER_EVIDENCE), 'earlier evidence persists across requests');
  assert.ok(allText(bodies[2].input).includes(POST_EVIDENCE), 'late evidence delivered to a subsequent native request');
  const evidence = bodies[2].input.filter((item) => textOf(item).includes('EVIDENCE_END'));
  assert.ok(evidence.every((item) => item.role === 'developer'), 'evidence is a later developer message');
  assert.equal((await readFile(join(fixture.workspace, 'actor-first.txt'), 'utf8')), 'native-0');
  assert.equal((await readFile(join(fixture.workspace, 'actor-second.txt'), 'utf8')), 'native-1');
  for (const [index, marker] of [[1, 'native-tool-ok-0'], [2, 'native-tool-ok-1']]) {
    const results = bodies[index].input.filter((item) => ['function_call_output', 'custom_tool_call_output'].includes(item.type));
    assert.ok(JSON.stringify(results).includes(marker), 'original native tool result preserved');
  }
  const events = (await readFile(join(fixture.root, 'hook-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(events.filter((event) => ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'].includes(event.event)).every((event) => event.model === 'gpt-6-sol'), 'native loop hook inputs carry the authoritative actor model');
  assert.ok(events.filter((event) => event.event === 'PreToolUse').every((event) => event.hasPluginRoot && event.hasPluginData));
  assert.deepEqual(events.filter((event) => event.event === 'PreToolUse').map((event) => event.commandHash).sort(), fake.requests.slice(0, 2).map((request) => request.nativeCommandHash).sort(), 'native commands reach PreToolUse unchanged');
  assert.ok(fake.requests[0].at < events.find((event) => event.event === 'UserEvidenceReady').at, 'first model request starts while async hook is pending');
  assert.ok(fake.requests[1].at < events.find((event) => event.event === 'PostEvidenceReady').at, 'next model request starts without awaiting late async hook');
  const tokenUsage = app.notifications.filter((event) => event.method === 'thread/tokenUsage/updated');
  assert.ok(JSON.stringify(tokenUsage).includes('4096'), 'mock cached-token usage reported through native protocol');
  // Developer context is not necessarily rendered as a chat item by thread/read.
  // Restart the native host and replay the saved thread to test durable model
  // history directly, using the runtime's default history mode throughout.
  await app.close();
  app = new AppServer(binary, { env: fixture.env, cwd: fixture.workspace });
  await app.initialize();
  await app.call('thread/resume', { threadId, model: 'gpt-6-sol', modelProvider: 'perseus-fake', config: { bypass_hook_trust: true }, approvalPolicy: 'never', sandbox: 'danger-full-access' });
  await app.call('turn/start', { threadId, input: [{ type: 'text', text: 'Verify the saved native fixture evidence.', text_elements: [] }] });
  const resumed = await app.until('turn/completed', (params) => params.threadId === threadId);
  assert.equal(resumed.turn.status, 'completed', JSON.stringify(resumed.turn.error));
  assert.equal(fake.requests.length, 4);
  assert.ok(allText(fake.requests[3].body.input).includes(USER_EVIDENCE), 'first evidence persists after native host restart/resume');
  assert.ok(allText(fake.requests[3].body.input).includes(POST_EVIDENCE), 'late evidence persists after native host restart/resume');
  const proof = {
    kind: 'native-hooks-local-fake-responses',
    mockCacheOnly: true,
    initialization,
    hookCount: loaded.length,
    requestCount: fake.requests.length,
    historyMode: 'native-default',
    requests: fake.requests.map(({ body }, index) => ({ scope: index < 3 ? 'active-turn' : 'resume', model: body.model, instructionsHash: sha256(body.instructions ?? initialInstructions(bodies[0])), toolsHash: sha256(toolsOf(body)), inputHash: sha256(body.input), oldPrefixHash: sha256(body.input.slice(0, bodies[0].input.length)), previousInputHash: index > 0 && index < 3 ? sha256(bodies[index - 1].input) : null, preservedPreviousInputHash: index > 0 && index < 3 ? sha256(body.input.slice(0, bodies[index - 1].input.length)) : null, hasUserEvidence: allText(body.input).includes(USER_EVIDENCE), hasPostEvidence: allText(body.input).includes(POST_EVIDENCE) })),
    nativeMarkers: await Promise.all(['actor-first.txt', 'actor-second.txt'].map(async (name) => ({ name, sha256: sha256(await readFile(join(fixture.workspace, name), 'utf8')) }))),
    checks: ['complete-adjacent-active-request-prefix-identical', 'native-tools-executed', 'async-pending-not-awaited', 'late-context-persisted-after-restart-resume', 'additional-context-limit-zero', 'mock-cached-tokens-reported'],
  };
  await writeFile(join(fixture.root, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
  await mkdir(join(root, 'live-results'), { recursive: true });
  await writeFile(join(root, 'live-results', 'native-hooks-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  if (process.env.PERSEUS_KEEP_NATIVE_FIXTURE === '1') t.diagnostic(`Sanitized proof: ${join(fixture.root, 'proof.json')}`);
  assert.ok(!(await readdir(fixture.home)).includes('auth.json'), 'fixture created no real-account auth file');
});
