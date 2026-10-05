import test from 'node:test'
import assert from 'node:assert/strict'
import { Swarm } from '../src/scheduler.mjs'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)) }
const user = (prompt = 'Find useful evidence', turn_id = 'turn-1') => ({ hook_event_name: 'UserPromptSubmit', prompt, turn_id })
const native = (response, id = 'actor-tool-1') => ({ hook_event_name: 'PostToolUse', tool_use_id: id,
  tool_name: 'Bash', tool_input: { command: 'cat source.txt' }, tool_response: response })
const action = (tool = 'read', args = { path: 'source.txt' }) => ({ tool, arguments: args })
const receipt = (id = 'copy-1', start = 1, end = 2) => ({ scopeId: id, authoritative: false,
  kind: 'independent_work_copy', snapshotStartedAt: start, snapshotFinishedAt: end })

test('one generation per fixed domain; every completed action dispatches before its stream ends', async () => {
  const gate = deferred(), calls = [], generations = []
  const swarm = new Swarm({
    async *generate(domain, facts, options) {
      generations.push({ domain, facts, options })
      if (domain !== 'read') return
      yield action()
      await gate.promise
    },
    async acquire(value) { calls.push(value); return { result: 'complete', receipt: receipt() } },
  })
  const boundary = swarm.handle(user())
  assert.equal(boundary.boundaryKind, 'hook_event')
  assert.equal(boundary.launched, 3)
  await flush()
  assert.equal(generations.length, 3)
  assert.equal(calls.length, 1)
  assert.equal(swarm.status().pendingWorkers, 1)
  assert.equal(swarm.status().unreviewedObservations, 1)
  assert.deepEqual(swarm.collect(), [])
  gate.resolve(); await flush()
  const next = swarm.handle({ hook_event_name: 'Notification' })
  assert.equal(next.observations.length, 1)
  assert.equal(next.observations[0].sourceBoundary, 1)
  assert.equal(next.boundary, 2)
  assert.equal(next.launched, 0)
  assert.deepEqual(swarm.collect(), [])
  assert.equal(generations.length, 3)
  await swarm.close()
})

test('only real authoritative progress changes revisions; evidence never becomes worker facts', async () => {
  const snapshots = []
  const swarm = new Swarm({ async *generate(domain, facts) { snapshots.push({ domain, facts }) },
    async acquire() { throw new Error('No actions expected') } })
  swarm.handle(user()); await flush()
  assert.equal(swarm.status().revision, 1)
  assert.equal(swarm.handle(user()).launched, 0)
  assert.equal(swarm.handle({ ...native('first'), tool_use_id: undefined }).launched, 0)
  assert.equal(swarm.status().revision, 1)
  swarm.handle(native('first')); await flush()
  assert.equal(swarm.status().revision, 2)
  assert.equal(swarm.handle(native('first')).launched, 0)
  assert.equal(swarm.handle(native('first', 'actor-tool-2')).launched, 0)
  assert.equal(swarm.status().facts, 3)
  swarm.handle(native('changed', 'actor-tool-3')); await flush()
  assert.equal(swarm.status().revision, 3)
  assert.equal(snapshots.length, 9)
  assert.deepEqual(snapshots.at(-1).facts.map(fact => fact.kind), ['user_prompt', 'tool_observation', 'tool_observation', 'tool_observation'])
  snapshots[0].facts[0].prompt = 'mutated private snapshot'
  assert.equal(swarm.factsArray[0].prompt, 'Find useful evidence')
  swarm.handle(user('Find useful evidence', 'turn-2')); await flush()
  assert.equal(swarm.status().revision, 4)
  await swarm.close()
})

test('busy domains launch the latest deferred revision at a later hook boundary, without new progress', async () => {
  const gate = deferred(), generations = []
  const swarm = new Swarm({ async *generate(domain, facts, { revision }) {
    generations.push({ domain, revision, facts })
    if (domain === 'read' && revision === 1) await gate.promise
  }, async acquire() { throw new Error('No actions expected') } })
  swarm.handle(user()); await flush()
  const progressed = swarm.handle(native('new progress')); await flush()
  assert.equal(progressed.revision, 2)
  assert.equal(progressed.launched, 2)
  assert.equal(swarm.handle({ hook_event_name: 'PreToolUse' }).launched, 0)
  assert.equal(swarm.status().waves, 2)
  gate.resolve(); await flush()
  assert.deepEqual(generations.filter(value => value.domain === 'read').map(value => value.revision), [1])
  const later = swarm.handle({ hook_event_name: 'PreToolUse' }); await flush()
  assert.equal(later.revision, 2)
  assert.equal(later.launched, 1)
  assert.equal(swarm.status().waves, 3)
  assert.deepEqual(generations.filter(value => value.domain === 'read').map(value => value.revision), [1, 2])
  assert.equal(swarm.handle({ hook_event_name: 'Notification' }).launched, 0)
  assert.equal(generations.at(-1).facts.at(-1).result, 'new progress')
  await swarm.close()
})

test('canonical pending Futures survive revisions and completed Futures refresh without losing older results', async () => {
  const pending = [], calls = [], facts = []
  const swarm = new Swarm({
    async *generate(domain, snapshot, { revision }) {
      facts.push(snapshot)
      if (domain !== 'read') return
      yield action('read', revision % 2 ? { path: 'source.txt', option: { b: 2, a: 1 } } : { option: { a: 1, b: 2 }, path: 'source.txt' })
    },
    acquire(value) { calls.push(value); const gate = deferred(); pending.push(gate); return gate.promise },
  })
  swarm.handle(user()); await flush()
  swarm.handle(native('new native evidence')); await flush()
  assert.equal(calls.length, 1)
  assert.equal(swarm.status().reusedAcquisitions, 1)
  pending[0].resolve({ result: { content: 'old complete' }, receipt: receipt('copy-old', 1, 2) }); await flush()
  const second = swarm.handle(native('more native evidence', 'actor-tool-2')); await flush()
  assert.equal(second.observations.length, 1)
  assert.equal(second.observations[0].revision, 1)
  assert.equal(calls.length, 2)
  pending[1].resolve({ result: { content: 'fresh complete' }, receipt: receipt('copy-new', 3, 4) }); await flush()
  const third = swarm.handle({ hook_event_name: 'Notification' })
  assert.equal(third.observations.length, 1)
  assert.equal(third.observations[0].revision, 3)
  assert.ok(facts.every(snapshot => snapshot.every(fact => ['user_prompt', 'tool_observation'].includes(fact.kind))))
  await swarm.close()
})

test('same-revision completed calls reuse and exact copied results deduplicate without hiding later reversions', async () => {
  let executions = 0, generationGate = deferred(), acquired = deferred(), nextResult = 'A'
  const swarm = new Swarm({
    async *generate(domain, facts, { revision }) {
      if (domain !== 'read') return
      yield action()
      if (revision === 1) {
        await acquired.promise
        await new Promise(resolve => setImmediate(resolve))
        yield action()
        await generationGate.promise
      }
    },
    async acquire() {
      executions++
      acquired.resolve()
      return { result: nextResult, receipt: receipt(`copy-${executions}`, executions * 10, executions * 10 + 1) }
    },
  })
  swarm.handle(user()); await flush()
  assert.equal(executions, 1)
  assert.equal(swarm.status().reusedAcquisitions, 1)
  generationGate.resolve(); await flush()
  assert.equal(swarm.handle(native('progress-1')).observations.length, 1); await flush()
  assert.equal(executions, 2)
  nextResult = 'B'
  assert.equal(swarm.handle(native('progress-2', 'actor-tool-2')).observations.length, 0); await flush()
  assert.equal(swarm.status().duplicateObservations, 1)
  nextResult = 'A'
  const changed = swarm.handle(native('progress-3', 'actor-tool-3')); await flush()
  assert.equal(changed.observations[0].result, 'B')
  const reverted = swarm.handle({ hook_event_name: 'Notification' })
  assert.equal(reverted.observations[0].result, 'A')
  await swarm.close()
})

test('unreviewed old completion survives a fresh same-action allocation', async () => {
  const pending = []
  const swarm = new Swarm({ async *generate(domain, facts, { revision }) {
    if (domain !== 'read') return
    if (revision === 2) await new Promise(resolve => setImmediate(resolve))
    yield action()
  },
    acquire() { const gate = deferred(); pending.push(gate); return gate.promise } })
  swarm.handle(user()); await flush()
  const previousBoundary = swarm.handle(native('progress-1'))
  assert.deepEqual(previousBoundary.observations, [])
  // It finishes after admission, but before the new generation emits the same action.
  pending[0].resolve({ result: 'older', receipt: receipt() }); await flush()
  assert.equal(pending.length, 2)
  pending[1].resolve({ result: 'newer', receipt: receipt('new', 3, 4) }); await flush()
  const boundary = swarm.handle({ hook_event_name: 'Notification' })
  assert.deepEqual(boundary.observations.map(value => value.result), ['older', 'newer'])
  await swarm.close()
})

test('acquisition transport errors remain complete while diagnostic callback failures cannot orphan work', async () => {
  const failure = Object.assign(new Error('native transport failed'), { code: 'ECONNRESET', nativeDetail: { full: '保存完整错误' } })
  const swarm = new Swarm({ async *generate(domain) { if (domain === 'read') yield action() },
    async acquire() { throw failure }, emit() { throw new Error('diagnostics unavailable') } })
  swarm.handle(user()); await flush()
  assert.deepEqual(swarm.handle({ hook_event_name: 'Notification' }).observations, [])
  const status = await swarm.close()
  assert.equal(status.hasPending, false)
  assert.equal(status.acquisitionFailures, 1)
  const diagnostic = status.errors.find(error => error.kind === 'acquisition')
  assert.equal(diagnostic.error.code, 'ECONNRESET')
  assert.deepEqual(diagnostic.error.nativeDetail, { full: '保存完整错误' })
  assert.ok(status.errors.some(error => error.kind === 'emit'))
})

test('unconfirmed or merged receipts never become evidence, while complete native errors can', async () => {
  const outputs = [
    { result: { exitCode: 1, stderr: 'missing file' }, receipt: null },
    { result: 'unconfirmed', receipt: { confirmed: false } },
    { result: 'merged', receipt: { independentRoot: '/copy', merged: true } },
    { result: { exitCode: 1, stderr: 'missing file', isError: true }, receipt: { independentRoot: '/copy', merged: false, provider: 'native' } },
  ]
  let count = 0
  const swarm = new Swarm({ async *generate(domain) {
    if (domain === 'read') for (let i = 0; i < outputs.length; i++) yield action('read', { path: `file-${i}` })
  }, async acquire() { return outputs[count++] } })
  swarm.handle(user()); await flush()
  const observed = swarm.handle({ hook_event_name: 'Notification' }).observations
  assert.equal(observed.length, 1)
  assert.deepEqual(observed[0].result, outputs[3].result)
  assert.deepEqual(observed[0].receipt, outputs[3].receipt)
  assert.equal(swarm.status().acquisitionFailures, 3)
  await swarm.close()
})

test('complete native outputs, images, errors, prepared arguments and copy receipts are not truncated', async () => {
  const full = { isError: true, content: [{ type: 'text', text: '原始错误'.repeat(10000) },
    { type: 'image', data: 'full-image-reference', mimeType: 'image/png' }], meta: { code: 'FS_NOT_FOUND', native: { extra: [1, 2, 3] } } }
  const origin = { ...receipt(), sandbox: { inheritedPolicy: 'native', privateWorkspace: '/isolated/workspace' } }
  const swarm = new Swarm({ async *generate(domain) { if (domain === 'read') yield action() },
    async acquire() { return { result: full, receipt: origin } } })
  swarm.handle(user()); await flush()
  const observed = swarm.handle({ hook_event_name: 'Notification' }).observations[0]
  assert.deepEqual(observed.result, full)
  assert.deepEqual(observed.receipt, origin)
  assert.deepEqual(observed.arguments, { path: 'source.txt' })
  assert.equal(observed.authoritative, false)
  observed.result.meta.code = 'mutated'
  assert.equal(full.meta.code, 'FS_NOT_FOUND')
  await swarm.close()
})

test('invalid fixed heads never execute, and failing generation retains already dispatched acquisitions', async () => {
  const gate = deferred(), calls = []
  const swarm = new Swarm({ async *generate(domain) {
    if (domain !== 'read') return
    yield action('grep', { pattern: 'wrong', path: '.' })
    yield action()
    throw new Error('generation transport failed')
  }, acquire(value) { calls.push(value); return gate.promise } })
  swarm.handle(user()); await flush()
  assert.equal(calls.length, 1)
  assert.equal(swarm.status().invalidActions, 1)
  assert.equal(swarm.status().workerFailures, 1)
  assert.equal(swarm.status().pendingAcquisitions, 1)
  gate.resolve({ result: 'complete despite generation failure', receipt: receipt() }); await flush()
  assert.equal(swarm.handle({ hook_event_name: 'Notification' }).observations.length, 1)
  await swarm.close()
})

test('close waits for every acquisition cleanup and rejects late old-epoch publication', async () => {
  const pending = [], cleanup = [], ended = [], started = deferred()
  const swarm = new Swarm({ async *generate(domain) {
    if (domain !== 'read') return
    yield action('read', { path: 'one.txt' })
    yield action('read', { path: 'two.txt' })
  }, acquire(value, { signal }) {
    const gate = deferred(); pending.push(gate)
    signal.addEventListener('abort', () => { ended.push(value.arguments.path) }, { once: true })
    if (pending.length === 2) started.resolve()
    return gate.promise.then(output => { cleanup.push(value.arguments.path); return output })
  } })
  swarm.handle(user()); await started.promise; await flush()
  const closing = swarm.close('user_cancelled')
  assert.equal(swarm.status().closed, true)
  assert.equal(swarm.status().pendingAcquisitions, 2)
  assert.equal(ended.length, 2)
  for (const gate of pending) gate.resolve({ result: 'late', receipt: receipt() })
  const status = await closing
  assert.equal(cleanup.length, 2)
  assert.equal(status.pendingAcquisitions, 0)
  assert.equal(status.pendingWorkers, 0)
  assert.equal(status.hasPending, false)
  assert.deepEqual(swarm.handle({ hook_event_name: 'Notification' }).observations, [])
})

test('reset creates a new epoch and fresh authoritative snapshot without old results or facts', async () => {
  const snapshots = []
  const swarm = new Swarm({ async *generate(domain, facts) { snapshots.push(facts); if (domain === 'read') yield action() },
    async acquire() { return { result: 'full', receipt: receipt() } } })
  swarm.handle(user()); await flush()
  const epoch = swarm.status().epoch
  await swarm.reset('native_compaction')
  assert.equal(swarm.status().epoch, epoch + 1)
  assert.equal(swarm.status().facts, 0)
  assert.deepEqual(swarm.collect(), [])
  assert.equal(swarm.handle({ hook_event_name: 'Notification' }).launched, 0)
  swarm.handle(user('Compacted task objective', 'turn-2')); await flush()
  assert.equal(snapshots.at(-1)[0].prompt, 'Compacted task objective')
  assert.equal(snapshots.at(-1).length, 1)
  assert.equal(swarm.handle({ hook_event_name: 'Notification' }).observations.length, 1)
  await swarm.close()
})
