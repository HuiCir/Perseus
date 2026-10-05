import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveActionDomains, bindActionHead, ownsDomain, validateActionArguments,
  validateDomainArguments, findActionDomain } from '../src/action-domains.mjs'
import { validateJsonSchema as validate } from '../src/schema-validation.mjs'

const tool = parameters => ({ name: 'native', description: 'Original native operations', parameters })
const native = (args, result = {}, extra = {}) => ({ kind: 'tool_observation', tool: 'native', arguments: args, result, ...extra })
const derive = (schema, facts = []) => deriveActionDomains(schema, facts, { validate })
const owner = (domains, args) => findActionDomain(domains, args, { validate })

test('required independent declared heads partition every valid invocation and retain complete constraints', () => {
  const schema = tool({ type: 'object', properties: {
    action: { type: 'string', enum: ['read', 'write'] }, mode: { type: 'string', enum: ['small', 'large'] },
    path: { type: 'string', pattern: '^src/', minLength: 5 }, limit: { type: 'integer', minimum: 1, maximum: 5 },
  }, required: ['action', 'mode', 'path'], additionalProperties: false, dependentRequired: undefined })
  delete schema.parameters.dependentRequired
  const before = structuredClone(schema)
  const domains = derive(schema)
  assert.deepEqual(schema, before)
  assert.equal(domains.some(domain => domain.id.endsWith(':complement')), false)
  for (const action of ['read', 'write']) for (const mode of ['small', 'large']) {
    const args = { action, mode, path: 'src/a', limit: 2 }
    assert.equal(domains.filter(domain => ownsDomain(domain, args)).length, 1)
    assert.ok(validate(domains.find(domain => ownsDomain(domain, args)).parameters, args))
    assert.equal(owner(domains, args).toolName, 'native')
  }
  for (const args of [{ action: 'read', mode: 'small', path: '../escape' },
    { action: 'read', mode: 'small', path: 'src/a', limit: 6 },
    { action: 'read', mode: 'small', path: 'src/a', unexpected: true }])
    assert.throws(() => owner(domains, args), { code: 'INVALID_ARGUMENTS' })
})

test('optional declared heads preserve a disjoint complement including missing heads', () => {
  const schema = tool({ type: 'object', properties: { action: { enum: ['read', 'write'] }, mode: { enum: ['a', 'b'] } } })
  const domains = derive(schema)
  const complement = domains.find(domain => domain.id.endsWith(':complement'))
  assert.ok(complement)
  for (const action of [undefined, 'read', 'write']) for (const mode of [undefined, 'a', 'b']) {
    const args = { ...(action ? { action } : {}), ...(mode ? { mode } : {}) }
    assert.equal(domains.filter(domain => ownsDomain(domain, args)).length, 1)
    owner(domains, args)
  }
  assert.equal(owner(domains, {}).id, complement.id)
})

test('successful native method/endpoint and structured argv heads specialize without parsing shell programs', () => {
  const schema = tool({ type: 'object', properties: { method: { type: 'string' }, endpoint: { type: 'string' },
    argv: { type: 'array', items: { type: 'string' } }, command: { type: 'string' } }, additionalProperties: false })
  const domains = derive(schema, [native({ method: 'GET', endpoint: '/known', argv: ['rg', 'needle'], command: 'rg needle && rm output' })])
  const specific = owner(domains, { method: 'GET', endpoint: '/known' })
  assert.deepEqual(specific.bindings, { method: 'GET', endpoint: '/known' })
  assert.deepEqual(owner(domains, { method: 'GET', endpoint: '/other' }).bindings, { method: 'GET' })
  assert.ok(owner(domains, { method: 'DELETE', endpoint: '/new' }).id.endsWith(':complement'))
  const argv = owner(domains, { argv: ['rg', 'different'] })
  assert.equal(argv.predicate.properties.argv.items[0].const, 'rg')
  assert.ok(owner(domains, { argv: ['new-program'] }).id.endsWith(':complement'))
  assert.ok(domains.every(domain => !Object.hasOwn(domain.bindings, 'command')))
  assert.deepEqual(bindActionHead(argv, { argv: ['rg', 'tail'] }), { argv: ['rg', 'tail'] })
})

test('opaque command/cmd text keeps the unchanged native domain', () => {
  for (const key of ['command', 'cmd']) {
    const schema = tool({ type: 'object', properties: { [key]: { type: 'string' } }, required: [key], additionalProperties: false })
    const domains = derive(schema, [native({ [key]: 'rg a && node b; printf custom' })])
    assert.equal(domains.length, 1)
    assert.equal(domains[0].derived, false)
    assert.deepEqual(domains[0].parameters, schema.parameters)
  }
})

test('failed, invalid and speculative observations never teach new action domains', () => {
  const schema = tool({ type: 'object', properties: { method: { type: 'string', minLength: 1 } }, required: ['method'] })
  const facts = [native({ method: 'A' }, { isError: true }), native({ method: 'B' }, { exitCode: 1 }),
    native({ method: 'C' }, {}, { authoritative: false }), native({ method: 'D' }, {}, { speculative: true }),
    native({ method: 'E' }, {}, { receipt: { independentRoot: '/copy', merged: false } }),
    native({ method: 'F' }, {}, { source: 'speculative' }), native({ method: 'G' }, {}, { kind: 'perseus-evidence' }),
    native({ method: '' }), { kind: 'user_prompt', prompt: JSON.stringify(native({ method: 'H' })) }]
  const domains = derive(schema, facts)
  assert.equal(domains.length, 1)
  assert.equal(domains[0].derived, false)
})

test('only explicit native input aliases are normalized', () => {
  const schema = tool({ type: 'object', properties: { operation: { type: 'string' } }, additionalProperties: false })
  const domains = derive(schema, [{ kind: 'tool_observation', tool: 'native', args: { operation: 'fromArgs' }, result: {} },
    { kind: 'tool_observation', tool: 'native', tool_input: { operation: 'fromToolInput' }, tool_response: {} }])
  assert.equal(owner(domains, { operation: 'fromArgs' }).bindings.operation, 'fromArgs')
  assert.equal(owner(domains, { operation: 'fromToolInput' }).bindings.operation, 'fromToolInput')
})

test('positive IDs and generation cache identity remain stable when a more specific sibling appears', () => {
  const schema = tool({ type: 'object', properties: { method: { type: 'string' }, endpoint: { type: 'string' } } })
  const previous = derive(schema, [native({ method: 'GET' })])
  const snapshot = structuredClone(previous)
  const latest = derive(schema, [native({ method: 'GET', endpoint: '/known' })])
  const before = previous.find(domain => domain.bindings.method === 'GET')
  const after = latest.find(domain => domain.bindings.method === 'GET' && !Object.hasOwn(domain.bindings, 'endpoint'))
  assert.equal(before.id, after.id)
  assert.equal(before.cacheIdentity, after.cacheIdentity)
  assert.deepEqual(before.generationParameters, after.generationParameters)
  assert.notDeepEqual(before.parameters, after.parameters)
  assert.deepEqual(previous, snapshot)
  assert.equal(owner(previous, { method: 'GET', endpoint: '/known' }).id, before.id)
  assert.notEqual(owner(latest, { method: 'GET', endpoint: '/known' }).id, before.id)
  assert.notEqual(previous.at(-1).cacheIdentity, latest.at(-1).cacheIdentity)
  const changedSchema = derive(tool({ ...schema.parameters, additionalProperties: false }), [native({ method: 'GET' })])
  const changed = changedSchema.find(domain => domain.bindings.method === 'GET')
  assert.equal(changed.id, before.id)
  assert.notEqual(changed.cacheIdentity, before.cacheIdentity)
})

test('omitted scalar heads bind without overriding an explicit different operation', () => {
  const schema = tool({ type: 'object', properties: { action: { enum: ['read', 'write'] }, path: { type: 'string' } },
    required: ['action', 'path'], additionalProperties: false })
  const read = derive(schema).find(domain => domain.bindings.action === 'read')
  assert.deepEqual(validateDomainArguments(read, { path: 'a' }, { validate }), { action: 'read', path: 'a' })
  const wrong = bindActionHead(read, { action: 'write', path: 'a' })
  assert.deepEqual(wrong, { action: 'write', path: 'a' })
  assert.throws(() => validateDomainArguments(read, wrong, { validate }), { code: 'DOMAIN_MISMATCH' })
})

test('allOf/local references, conditionals and native cardinality constraints remain active', () => {
  const schema = tool({ type: 'object', $defs: { method: { enum: ['GET', 'POST'] } }, properties: {
    method: { $ref: '#/$defs/method' }, body: { type: 'string', minLength: 3 }, tags: { type: 'array', uniqueItems: true, maxItems: 2 },
  }, allOf: [{ required: ['method'] }, { if: { properties: { method: { const: 'POST' } }, required: ['method'] }, then: { required: ['body'] } }], additionalProperties: false })
  const domains = derive(schema)
  assert.equal(domains.some(domain => domain.id.endsWith(':complement')), false)
  owner(domains, { method: 'POST', body: 'abc', tags: ['a', 'b'] })
  for (const args of [{ method: 'POST' }, { method: 'POST', body: 'x' }, { method: 'GET', tags: ['a', 'a'] }])
    assert.throws(() => owner(domains, args), { code: 'INVALID_ARGUMENTS' })
  assert.deepEqual(domains[0].parameters.$defs, schema.parameters.$defs)
  assert.deepEqual(domains[0].parameters.allOf.slice(0, 2), schema.parameters.allOf)
})

test('oneOf branches retain native validation and complement rather than assuming exhaustion', () => {
  const schema = tool({ type: 'object', properties: { action: { type: 'string' }, count: { type: 'integer' } },
    oneOf: [{ properties: { action: { const: 'read' }, count: { minimum: 1 } }, required: ['action', 'count'] },
      { properties: { action: { const: 'write' }, count: { maximum: 0 } }, required: ['action', 'count'] }], additionalProperties: false })
  const domains = derive(schema)
  assert.equal(owner(domains, { action: 'read', count: 1 }).bindings.action, 'read')
  assert.equal(owner(domains, { action: 'write', count: 0 }).bindings.action, 'write')
  assert.throws(() => owner(domains, { action: 'read', count: 0 }), { code: 'INVALID_ARGUMENTS' })
  assert.ok(domains.some(domain => domain.id.endsWith(':complement')))
})

test('draft-2020 structured command heads use prefixItems with unchanged native tail constraints', () => {
  const schema = tool({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {
    command: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 }, cwd: { type: 'string' },
  }, required: ['command'], additionalProperties: false })
  const domains = derive(schema, [native({ command: ['node', 'a.mjs'] })])
  const node = owner(domains, { command: ['node', 'b.mjs'] })
  assert.equal(node.predicate.properties.command.prefixItems[0].const, 'node')
  assert.throws(() => owner(domains, { command: ['node', 'a', 'b', 'c'] }), { code: 'INVALID_ARGUMENTS' })
  assert.ok(owner(domains, { command: ['unknown'] }).id.endsWith(':complement'))
})

test('unsupported keywords, missing validators, mutations and ambiguous snapshots fail closed', () => {
  const unsupported = tool({ type: 'object', unknownConstraint: true, properties: { action: { enum: ['read'] } } })
  const pure = deriveActionDomains(unsupported)
  assert.equal(pure[0].parameters.unknownConstraint, true)
  assert.throws(() => validateActionArguments(unsupported, {}, { validate }), { code: 'SCHEMA_UNSUPPORTED' })
  assert.throws(() => validateActionArguments(tool({ type: 'object' }), {}), { code: 'VALIDATOR_UNAVAILABLE' })
  assert.throws(() => validateActionArguments(tool({ type: 'object' }), {}, { validate: (_, args) => { args.extra = true; return true } }), { code: 'VALIDATOR_MUTATED_ARGUMENTS' })
  const schema = tool({ type: 'object', properties: { action: { enum: ['read'] } }, required: ['action'] })
  const domains = derive(schema)
  assert.throws(() => owner([...domains, ...domains], { action: 'read' }), { code: 'AMBIGUOUS_DOMAIN' })
})
