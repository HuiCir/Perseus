import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { bindActionHead, deriveDomains, ownsDomain } from '../src/domains.ts'

const tool = (parameters: Record<string, unknown>): ToolSchema => ({ name: 'native', description: 'native operations', parameters })

test('declared actions retain original constraints and uniquely cover independent required enums', () => {
  const schema = tool({ type: 'object', properties: {
    action: { type: 'string', enum: ['read', 'write'] }, mode: { type: 'string', enum: ['small', 'large'] },
    path: { type: 'string' },
  }, required: ['action', 'mode', 'path'], additionalProperties: false })
  const original = structuredClone(schema)
  const domains = deriveDomains([schema])
  assert.deepEqual(schema, original)
  assert.ok(!domains.some(domain => domain.id.endsWith(':residual')))
  for (const action of ['read', 'write']) for (const mode of ['small', 'large']) {
    const args = { action, mode, path: '/source' }
    assert.equal(domains.filter(domain => ownsDomain(domain, args)).length, 1)
  }
  for (const domain of domains) {
    assert.equal(domain.parameters.additionalProperties, false)
    assert.deepEqual(domain.parameters.required, ['action', 'mode', 'path'])
    assert.ok(!Object.hasOwn(domain.parameters, 'allOf'))
    assert.ok(!Object.hasOwn(domain.parameters, 'not'))
  }
})

test('optional declared actions retain a disjoint residual for omitted and new structured heads', () => {
  const schema = tool({ type: 'object', properties: {
    method: { type: 'string', enum: ['GET', 'POST'] }, operation: { type: 'string', enum: ['a', 'b'] },
  } })
  const domains = deriveDomains([schema])
  const residual = domains.find(domain => domain.id.endsWith(':residual'))!
  assert.ok(residual)
  for (const method of [undefined, 'GET', 'POST']) for (const operation of [undefined, 'a', 'b']) {
    const args = { ...(method === undefined ? {} : { method }), ...(operation === undefined ? {} : { operation }) }
    assert.equal(domains.filter(domain => ownsDomain(domain, args)).length, 1)
  }
  assert.ok(ownsDomain(residual, {}))
})

test('observed structured heads specialize routes and leave opaque shell strings intact', () => {
  const schema = tool({ type: 'object', properties: {
    method: { type: 'string' }, url: { type: 'string' }, argv: { type: 'array', items: { type: 'string' } },
    command: { type: 'string' },
  } })
  const observations = [{ tool: 'native', arguments: { method: 'GET', url: '/known', argv: ['rg', 'needle'], command: 'rg needle && write output' }, isError: false }]
  const domains = deriveDomains([schema], observations)
  for (const args of [{ method: 'GET', url: '/known' }, { method: 'GET', url: '/other' },
    { method: 'DELETE', url: '/new' }, { argv: ['rg', 'different'] }, { argv: ['new-command'] }, { command: 'anything' }])
    assert.equal(domains.filter(domain => ownsDomain(domain, args)).length, 1)
  assert.ok(domains.every(domain => !Object.hasOwn(domain.bindings, 'command')))
  const opaque = tool({ type: 'object', properties: { command: { type: 'string' } }, required: ['command'] })
  assert.deepEqual(deriveDomains([opaque], observations).map(domain => domain.derived), [false])
  assert.deepEqual(deriveDomains([schema], [{ ...observations[0], isError: true }]).map(domain => domain.derived), [false])
})

test('fixed head completion never replaces an explicit different action', () => {
  const domains = deriveDomains([tool({ type: 'object', properties: { action: { type: 'string', enum: ['read', 'write'] } }, required: ['action'] })])
  const read = domains.find(domain => domain.bindings.action === 'read')!
  assert.deepEqual(bindActionHead(read, {}), { action: 'read' })
  const wrong = bindActionHead(read, { action: 'write' })
  assert.deepEqual(wrong, { action: 'write' })
  assert.equal(ownsDomain(read, wrong), false)
})

test('observed oneOf discriminators keep the native supported schema and use runtime ownership', () => {
  const schema = tool({ type: 'object', properties: { method: { oneOf: [
    { type: 'string', const: 'GET' }, { type: 'string', const: 'POST' },
  ] } } })
  const domains = deriveDomains([schema], [{ tool: 'native', arguments: { method: 'GET' }, isError: false }])
  const get = domains.find(domain => domain.bindings.method === 'GET')!
  assert.deepEqual((get.parameters.properties as Record<string, unknown>).method,
    (schema.parameters.properties as Record<string, unknown>).method)
  assert.equal(ownsDomain(get, { method: 'GET' }), true)
  assert.equal(ownsDomain(get, { method: 'POST' }), false)
  assert.equal(domains.filter(domain => ownsDomain(domain, { method: 'POST' })).length, 1)
})
