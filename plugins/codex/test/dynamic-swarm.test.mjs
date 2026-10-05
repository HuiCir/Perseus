import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, COMMAND_TOOL } from '../src/tool-registry.mjs';
import { Swarm } from '../src/scheduler.mjs';
import { acquisitionInstructions, actionOutputSchema, promptIdentity } from '../src/cache.mjs';

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const event = (command, result = { exitCode: 0 }, id = command[0]) => ({ hook_event_name: 'PostToolUse', tool_use_id: id,
  tool_name: 'mcp__perseus__command_exec', tool_input: { command }, tool_response: result });
const identity = domain => promptIdentity({ model: 'gpt-6-luna', effort: 'high', instructions: acquisitionInstructions(domain),
  outputSchema: actionOutputSchema(domain), domainVersion: 2 });

test('real typed native progress widens domains; speculative evidence and opaque shell never teach heads', async () => {
  const registry = new ToolRegistry(); const generations = [], executed = [];
  const swarm = new Swarm({ registry, async *generate(domain, facts) {
    generations.push({ domain, facts });
    if (domain.toolName === 'command_exec' && domain.id.endsWith(':native'))
      yield { tool: 'command_exec', arguments: { command: ['speculator-only', 'inspect'] } };
  }, async acquire(action) { executed.push(action); return { result: { exitCode: 0 }, receipt: { independentRoot: '/copy', merged: false } }; } });
  assert.equal(swarm.handle({ hook_event_name: 'UserPromptSubmit', prompt: 'Inspect tests' }).launched, 4); await flush();
  assert.equal(executed.length, 1);
  assert.equal(swarm.handle(event(['node', '--test'])).launched, 5); await flush();
  assert.equal(swarm.status().domainCount, 5);
  assert.ok(generations.at(-1).facts.every(fact => !JSON.stringify(fact).includes('speculator-only')));
  assert.equal(registry.frontier.some(domain => JSON.stringify(domain.predicate ?? {}).includes('speculator-only')), false);
  swarm.handle(event(['python3', 'inspect.py'], { isError: true }, 'failed')); await flush();
  assert.equal(swarm.status().domainCount, 5);
  swarm.handle({ hook_event_name: 'PostToolUse', tool_use_id: 'opaque', tool_name: 'Bash', tool_input: { command: 'python3 inspect.py' }, tool_response: { exitCode: 0 } }); await flush();
  assert.equal(swarm.status().domainCount, 5);
  swarm.handle(event(['python3', 'inspect.py'], { exitCode: 0 }, 'success')); await flush();
  assert.equal(swarm.status().domainCount, 6);
  await swarm.close();
});

test('stable positive prefix survives added siblings; complement gets a fresh prefix and complete schema', () => {
  const registry = new ToolRegistry({ tools: [COMMAND_TOOL] });
  const fact = command => ({ kind: 'tool_observation', tool: 'command_exec', arguments: { command }, result: { exitCode: 0 } });
  const first = registry.derive([fact(['node', '--test'])]);
  const second = registry.derive([fact(['node', '--test']), fact(['python3', 'inspect.py'])]);
  const node1 = first.find(domain => domain.predicate), node2 = second.find(domain => domain.id === node1.id);
  assert.equal(identity(node1), identity(node2));
  assert.notEqual(identity(first.find(domain => !domain.predicate)), identity(second.find(domain => !domain.predicate)));
  for (const name of ['read', 'grep', 'glob']) {
    const domain = new ToolRegistry().derive([]).find(domain => domain.id === name);
    assert.equal(acquisitionInstructions(domain), acquisitionInstructions(name));
    assert.deepEqual(actionOutputSchema(domain), actionOutputSchema(name));
  }
});

test('old immutable complement actions are reassigned by current unique ownership; invalid native arguments never execute', async () => {
  const registry = new ToolRegistry({ tools: [COMMAND_TOOL] }); let release;
  const gate = new Promise(resolve => { release = resolve; }); const calls = [], logs = [];
  const swarm = new Swarm({ registry, emit: entry => logs.push(entry), async *generate(domain, facts, { revision }) {
    if (revision !== 1) return;
    await gate;
    yield { tool: 'command_exec', arguments: { command: ['node', '--test'] } };
    yield { tool: 'command_exec', arguments: { command: ['node'], extra: 'not-native' } };
  }, async acquire(action) { calls.push(action); return { result: 'complete', receipt: { merged: false, independentRoot: '/copy' } }; } });
  swarm.handle({ hook_event_name: 'UserPromptSubmit', prompt: 'Inspect tests' }); await flush();
  const old = structuredClone(swarm.domains);
  swarm.handle(event(['node', '--test'])); await flush(); release(); await flush();
  assert.equal(calls.length, 1); assert.equal(swarm.status().invalidActions, 1);
  assert.ok(logs.some(entry => entry.event === 'action_reassigned' && entry.ownerId !== entry.domain));
  assert.equal(old[0].id, 'command_exec:native');
  const admitted = swarm.handle({ hook_event_name: 'PreToolUse' }).observations;
  assert.equal(admitted.length, 1); assert.notEqual(admitted[0].domainId, old[0].id);
  await swarm.close();
});

test('explicit wrong heads cannot escape a positive generation domain and unsupported registered constraints fail closed', () => {
  const registry = new ToolRegistry({ tools: [{ name: 'native', parameters: { type: 'object', properties: {
    operation: { enum: ['read', 'write'] }, path: { type: 'string', pattern: '^src/' },
  }, required: ['operation', 'path'], additionalProperties: false } }] });
  const domain = registry.derive([]).find(domain => domain.bindings.operation === 'read');
  assert.equal(registry.prepare(domain, { tool: 'native', arguments: { path: 'src/a' } }).action.arguments.operation, 'read');
  assert.throws(() => registry.prepare(domain, { tool: 'native', arguments: { operation: 'write', path: 'src/a' } }), /generation schema/);
  assert.throws(() => registry.prepare(domain, { tool: 'native', arguments: { path: '../a' } }), /generation schema/);
  assert.throws(() => new ToolRegistry({ tools: [{ name: 'invalid', parameters: { unknownConstraint: true } }] }), /unknown keyword/);
});
