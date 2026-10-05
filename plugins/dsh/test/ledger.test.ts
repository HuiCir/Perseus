import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import { EvidenceLedger, type Observation } from '../src/ledger.ts'

const observation = (id: string, text: string, extra: Partial<Observation> = {}): Observation => ({
  id, tool: 'native', arguments: { path: '/source' }, content: [{ type: 'text', text }], isError: false, start: 1, end: 2, ...extra,
})
const copy = (id: string, start = 1, end = 2) => ({ kind: 'independent_work_copy' as const, scopeId: id,
  authoritative: false as const, snapshotStartedAt: start, snapshotFinishedAt: end })

test('opaque output, unsafe JSON, images and metadata are retained completely', () => {
  for (const text of ['中文🙂\n'.repeat(20000), '{"x":1,"x":2}', '{"n":9007199254740993}']) {
    const input = observation('original', text)
    const delta = new EvidenceLedger().ingest(input)
    assert.deepEqual(delta.observation, input)
    assert.equal(delta.units[0].kind, 'native_observation')
    assert.deepEqual(delta.units[0].value, { content: input.content })
  }
  const image: ImageBlock = { type: 'image', attachment: { attachmentId: 'immutable-image' as ImageBlock['attachment']['attachmentId'],
    mediaType: 'image/png', bytes: 100, width: 10, height: 10 } }
  const input = observation('image', 'native caption', { content: [{ type: 'text', text: 'native caption' }, image], meta: { original: ['complete'] } })
  const ledger = new EvidenceLedger(), delta = ledger.ingest(input)
  assert.deepEqual(delta.observation, input)
  input.arguments.path = 'later mutation'
  assert.equal(delta.observation.arguments.path, '/source')
  assert.equal(ledger.ingest({ ...delta.observation, id: 'duplicate', start: 3, end: 4 }).units.length, 0)
})

test('source versions, stale intervals, concurrent conflicts and reversions stay distinguishable', () => {
  const ledger = new EvidenceLedger()
  assert.equal(ledger.ingest(observation('new', 'new', { sourceVersion: 2 })).units.length, 1)
  const stale = ledger.ingest(observation('old', 'old', { sourceVersion: 1, start: 10, end: 11 }))
  assert.equal(stale.units.length, 0)
  assert.equal(stale.decisions[0].reason, 'older_than_known_observation')
  const conflict = ledger.ingest(observation('conflict', 'different', { sourceVersion: 2 }))
  assert.equal(conflict.units.length, 1)
  assert.deepEqual(conflict.decisions[0].concurrentConflicts, ['new'])
  assert.equal(ledger.ingest(observation('revert', 'new', { sourceVersion: 3 })).units.length, 0)
  assert.equal(ledger.ingest(observation('change', 'changed', { sourceVersion: 4 })).units.length, 1)
  assert.equal(ledger.ingest(observation('revert-again', 'new', { sourceVersion: 5 })).units.length, 1)
  const times = new EvidenceLedger()
  times.ingest(observation('confirmed', 'same', { start: 10, end: 11 }))
  assert.equal(times.ingest(observation('causally-old', 'other', { start: 1, end: 2 })).units.length, 0)
  const opaqueVersions = new EvidenceLedger()
  opaqueVersions.ingest(observation('opaque-a', 'a', { sourceVersion: 'hash-a' }))
  assert.equal(opaqueVersions.ingest(observation('opaque-b', 'b', { sourceVersion: 'hash-b', start: 100, end: 101 })).units.length, 1)
})

test('work-copy facts deduplicate across copies but remain separate from authoritative state', () => {
  const ledger = new EvidenceLedger()
  ledger.ingest(observation('actor', 'same'))
  assert.equal(ledger.ingest(observation('copy1', 'same', { environment: copy('copy1') })).units.length, 1)
  assert.equal(ledger.ingest(observation('copy2', 'same', { environment: copy('copy2', 3, 4) })).units.length, 0)
})

test('copy execution origin stays complete while equality compares native metadata and value', () => {
  const ledger = new EvidenceLedger()
  const first = observation('copy1', 'same', { environment: copy('copy1'), meta: {
    nativeMeta: { important: 'native' }, value: { complete: ['record'] },
    execution: { acquisitionId: 'copy1', isolatedWorkspace: '/private/copy1', snapshotStartedAt: 1, snapshotFinishedAt: 2 },
  } })
  const accepted = ledger.ingest(first)
  assert.deepEqual(accepted.observation.meta, first.meta)
  assert.deepEqual(accepted.units[0].value, { content: first.content, meta: first.meta })
  const second = observation('copy2', 'same', { environment: copy('copy2', 3, 4), meta: {
    nativeMeta: { important: 'native' }, value: { complete: ['record'] },
    execution: { acquisitionId: 'copy2', isolatedWorkspace: '/private/copy2', snapshotStartedAt: 3, snapshotFinishedAt: 4 },
  } })
  const duplicate = ledger.ingest(second)
  assert.equal(duplicate.units.length, 0)
  assert.deepEqual(duplicate.observation.meta, second.meta)
  const changed = observation('copy3', 'same', { environment: copy('copy3', 5, 6), meta: {
    nativeMeta: { important: 'changed' }, value: { complete: ['record'] }, execution: { acquisitionId: 'copy3' },
  } })
  assert.equal(ledger.ingest(changed).units.length, 1)
})

test('complete source-addressed search records deduplicate without query-based omission', () => {
  const a = { title: 'A', snippet: 'full text', url: 'https://example.test/a' }
  const b = { title: 'B', snippet: 'full text', url: 'https://example.test/b' }
  const c = { title: 'C', snippet: 'full text', url: 'https://example.test/c' }
  const ledger = new EvidenceLedger()
  const first = observation('search1', JSON.stringify({ count: 2, results: [a, b] }), { arguments: { query: 'one', limit: 2 } })
  assert.equal(ledger.ingest(first).units.length, 2)
  const next = observation('search2', JSON.stringify({ count: 2, results: [b, c], nextPage: 'native-value' }), { arguments: { query: 'two', limit: 2 }, start: 3, end: 4 })
  const delta = ledger.ingest(next)
  assert.equal(delta.units.length, 2)
  assert.deepEqual(delta.units.find(unit => unit.kind === 'search_record')?.value, c)
  assert.deepEqual(delta.observation.content, next.content)
})

test('native errors repeat only after recovery and known observation IDs restore once', () => {
  const ledger = new EvidenceLedger()
  assert.equal(ledger.ingest(observation('error1', 'failed', { isError: true })).units.length, 1)
  assert.equal(ledger.ingest(observation('error2', 'failed', { isError: true, start: 3, end: 4 })).units.length, 0)
  const success = observation('success', JSON.stringify({ results: [{ title: 'A', snippet: 'x', url: 'https://example.test/a' }] }), { start: 5, end: 6 })
  ledger.ingest(success)
  assert.equal(ledger.ingest(observation('error3', 'failed', { isError: true, start: 7, end: 8 })).units.length, 1)
  assert.equal(ledger.ingest(success).units.length, 0)
  ledger.reset()
  assert.equal(ledger.ingest(success).units.length, 1)
})
