import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalJSON, promptIdentity, actionOutputSchema, acquisitionInstructions, workerPrompt, DOMAINS } from '../src/cache.mjs'

test('canonical identity ignores object key order and preserves array order and exact native text', () => {
  assert.equal(canonicalJSON({ z: [1, 2], a: { y: '原文', x: true } }), canonicalJSON({ a: { x: true, y: '原文' }, z: [1, 2] }))
  assert.notEqual(canonicalJSON([1, 2]), canonicalJSON([2, 1]))
  assert.notEqual(canonicalJSON({ output: 'text\n' }), canonicalJSON({ output: 'text' }))
  assert.throws(() => canonicalJSON({ value: Infinity }), /finite/)
  assert.throws(() => canonicalJSON({ value: 1n }), /JSON values/)
  const cycle = {}; cycle.self = cycle
  assert.throws(() => canonicalJSON(cycle), /cycles/)
})

test('prompt identity includes model, effort, instructions, native schema and domain version', () => {
  const config = { model: 'gpt-6-sol', effort: 'low', instructions: acquisitionInstructions('read'),
    outputSchema: actionOutputSchema('read'), domainVersion: 'read-v1' }
  const identity = promptIdentity(config)
  assert.match(identity, /^[a-f0-9]{64}$/)
  assert.equal(identity, promptIdentity({ domainVersion: 'read-v1', outputSchema: actionOutputSchema('read'),
    instructions: config.instructions, effort: 'low', model: 'gpt-6-sol' }))
  for (const change of [{ model: 'different-as-model' }, { effort: 'high' }, { instructions: `${config.instructions}\nchanged` },
    { outputSchema: actionOutputSchema('grep') }, { domainVersion: 'read-v2' }])
    assert.notEqual(identity, promptIdentity({ ...config, ...change }))
})

test('each strict output schema fixes its domain and requires every object property', () => {
  for (const domain of DOMAINS) {
    const schema = actionOutputSchema(domain)
    assert.equal(schema.type, 'object')
    assert.deepEqual(schema.required, ['actions'])
    assert.equal(schema.additionalProperties, false)
    assert.equal(schema.properties.actions.type, 'array')
    const action = schema.properties.actions.items
    assert.deepEqual(action.properties.tool.enum, [domain])
    assert.deepEqual(action.required.sort(), Object.keys(action.properties).sort())
    assert.equal(action.additionalProperties, false)
    const args = action.properties.arguments
    assert.deepEqual(args.required.sort(), Object.keys(args.properties).sort())
    assert.equal(args.additionalProperties, false)
    assert.deepEqual(Object.keys(args.properties).sort(), domain === 'read' ? ['path'] : ['path', 'pattern'])
  }
  assert.throws(() => actionOutputSchema('exec'), /Unsupported/)
})

test('AS input is a separate projection and never rewrites native Actor history', () => {
  const facts = [{ kind: 'user_prompt', prompt: '查原文件' }, { kind: 'tool_observation', toolUseId: 'actor-call-1',
    tool: 'Bash', arguments: { command: 'cat original.txt' }, result: { content: [{ type: 'text', text: '完整原文' }] } }]
  const original = structuredClone(facts)
  const prompt = workerPrompt({ domain: 'read', facts })
  assert.deepEqual(facts, original)
  assert.deepEqual(JSON.parse(prompt.input), original)
  const later = workerPrompt({ domain: 'read', facts: [...facts, { kind: 'user_prompt', prompt: '继续' }] })
  assert.equal(prompt.instructions, later.instructions)
  assert.deepEqual(JSON.parse(later.input).slice(0, facts.length), original)
  assert.match(prompt.instructions, /Do not call native tools/)
  assert.match(acquisitionInstructions('grep'), /path "\."/)
})
