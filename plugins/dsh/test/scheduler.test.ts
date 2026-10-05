import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { PerseusScheduler, type AcquisitionRequest, type AcquisitionResult, type AcquisitionScope,
  type SchedulerEvent, type SchedulerPorts, type WorkerRequest } from '../src/scheduler.ts'
import type { Observation } from '../src/ledger.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
const tick = async () => { for (let index = 0; index < 6; index++) await setImmediate() }
const result = (text = 'complete native observation'): AcquisitionResult => ({ content: [{ type: 'text', text }], isError: false, meta: { unchanged: true } })
const native: ToolSchema = { name: 'native', description: 'native', parameters: { type: 'object', properties: { query: { type: 'string' } } } }
const user = (text: string): Message => ({ id: text as Message['id'], role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const actor = (id: string, text: string, args: Record<string, unknown> = {}): Observation => ({
  id, tool: 'native', arguments: args, content: [{ type: 'text', text }], isError: false, start: 10, end: 11,
})

test('deferred parent dispatch cannot publish evidence without confirming a real work copy', async () => {
  let closed = 0
  const f = fixture({ openAcquisition: async request => ({
    provenance: { kind: 'independent_work_copy', scopeId: request.id, authoritative: false,
      snapshotStartedAt: 1, snapshotFinishedAt: 2, confirmed: false },
    execute: async () => result('policy denied before allocating any work copy'),
    close: async () => { closed++ },
  }) })
  f.launch(); await tick()
  const denied = await f.workers[0].dispatch({ query: 'unconfirmed' })
  assert.equal(denied.isError, true)
  assert.equal(closed, 1)
  assert.equal(f.scheduler.beginRequest().evidence.length, 0)
  assert.ok(f.events.some(event => event.event === 'se_tool_failed'))
  f.scheduler.end('finished'); await f.scheduler.settle()
})

function fixture(overrides: Partial<SchedulerPorts> = {}) {
  const workers: WorkerRequest[] = [], opened: AcquisitionRequest[] = [], closed: string[] = [], events: SchedulerEvent[] = []
  let id = 0, time = 100
  const scheduler = new PerseusScheduler({
    now: () => ++time, newId: () => `id-${++id}`,
    record: event => { events.push(event); overrides.record?.(event) },
    validateArguments: overrides.validateArguments ?? ((_tool, args) => args),
    runWorker: async request => { workers.push(request); await overrides.runWorker?.(request) },
    openAcquisition: async request => {
      opened.push(request)
      if (overrides.openAcquisition) return overrides.openAcquisition(request)
      return { provenance: { kind: 'independent_work_copy', scopeId: request.id, authoritative: false,
        snapshotStartedAt: 1, snapshotFinishedAt: 2 }, execute: async () => result(), close: async () => { closed.push(request.id) } }
    },
  })
  const launch = (key = 'task', tools: readonly ToolSchema[] = [native], messages: readonly Message[] = [user(key)], signal?: AbortSignal) => {
    const boundary = scheduler.beginRequest()
    const count = scheduler.launchWave({ boundary, tools, messages, userKey: key, signal })
    return { boundary, count }
  }
  return { scheduler, workers, opened, closed, events, launch }
}

test('admission is synchronous, ready earlier-request only and persistent evidence does not trigger a wave', async () => {
  const f = fixture()
  const { boundary: first } = f.launch()
  await tick()
  assert.equal(f.workers.length, 1)
  await f.workers[0].dispatch({ query: 'missing fact' })
  assert.equal(first.evidence.length, 0)
  assert.equal(f.scheduler.getStatus().readyObservations, 1)
  assert.equal(f.scheduler.launchWave({ boundary: first, tools: [native], messages: [user('task')], userKey: 'task' }), 0)
  const second = f.scheduler.beginRequest()
  assert.equal(second.evidence.length, 1)
  assert.deepEqual(second.evidence[0].observation.content, result().content)
  assert.equal(second.evidence[0].observation.environment?.authoritative, false)
  assert.equal(f.scheduler.launchWave({ boundary: second, tools: [native], messages: [user('task'), user('historical evidence')], userKey: 'task' }), 0)
  assert.equal(f.scheduler.beginRequest().evidence.length, 0)
  assert.equal(f.scheduler.getStatus().evidence, 1)
  f.scheduler.end('finished'); await f.scheduler.settle()
})

test('Futures survive requests; canonical inflight calls coalesce while completed calls refresh after native progress', async () => {
  const gate = deferred<AcquisitionResult>()
  let executions = 0
  const f = fixture({ openAcquisition: async request => ({
    provenance: { kind: 'independent_work_copy', scopeId: request.id, authoritative: false, snapshotStartedAt: 1, snapshotFinishedAt: 2 },
    execute: async () => { executions++; return gate.promise }, close: async () => {},
  }) })
  f.launch(); await tick()
  const one = f.workers[0].dispatch({ a: 1, b: 2 }), two = f.workers[0].dispatch({ b: 2, a: 1 })
  assert.equal(one, two)
  await tick()
  const boundary = f.scheduler.beginRequest()
  assert.equal(boundary.evidence.length, 0)
  assert.equal(f.scheduler.getStatus().pendingAcquisitions, 1)
  assert.equal(f.scheduler.launchWave({ boundary, tools: [native], messages: [user('task')], userKey: 'task' }), 0)
  f.scheduler.observeAuthoritative(actor('actor-1', 'new frontier'))
  const changed = f.scheduler.beginRequest()
  assert.equal(f.scheduler.launchWave({ boundary: changed, tools: [native], messages: [user('task')], userKey: 'task' }), 1)
  await tick()
  const reused = f.workers[1].dispatch({ a: 1, b: 2 })
  assert.equal(reused, one)
  gate.resolve(result()); await one
  assert.equal(executions, 1)
  assert.equal(f.scheduler.beginRequest().evidence.length, 1)
  f.scheduler.observeAuthoritative(actor('actor-2', 'different frontier'))
  const refreshed = f.scheduler.beginRequest()
  f.scheduler.launchWave({ boundary: refreshed, tools: [native], messages: [user('task')], userKey: 'task' })
  await tick(); await f.workers[2].dispatch({ a: 1, b: 2 })
  assert.equal(executions, 2)
  assert.equal(f.scheduler.getStatus().reusedExecutions, 2)
  f.scheduler.end('finished'); await f.scheduler.settle()
})

test('each request uses the committed current user snapshot; unchanged retries and native observations do not repeat generation', async () => {
  const f = fixture()
  const messages = [user('current user')]
  f.launch('current user', [native], messages)
  messages[0] = user('later mutation')
  await tick()
  assert.deepEqual(f.workers[0].messages, [user('current user')])
  assert.equal(f.launch('current user').count, 0)
  f.scheduler.observeAuthoritative(actor('a', 'native information'))
  assert.equal(f.launch('current user').count, 1)
  await tick()
  f.scheduler.observeAuthoritative(actor('same-result', 'native information'))
  assert.equal(f.launch('current user').count, 0)
  assert.equal(f.launch('new real user').count, 1)
  await tick()
  assert.equal(f.workers.length, 3)
  f.scheduler.end('finished'); await f.scheduler.settle()
})

test('native validation and domain ownership reject an explicit sibling action before allocation', async () => {
  const tool: ToolSchema = { name: 'native', description: 'native', parameters: { type: 'object', properties: {
    action: { type: 'string', enum: ['read', 'write'] },
  }, required: ['action'] } }
  const f = fixture({ validateArguments: (_schema, args) => {
    if (typeof args.action !== 'string') throw new Error('native action schema failed')
    return args
  } })
  f.launch('task', [tool]); await tick()
  const read = f.workers.find(worker => worker.domain.bindings.action === 'read')!
  const rejected = await read.dispatch({ action: 'write' })
  assert.equal(rejected.isError, true)
  assert.equal(f.opened.length, 0)
  assert.equal(f.scheduler.getStatus().invalidCalls, 1)
  assert.equal((await read.dispatch({})).isError, false)
  assert.equal(f.opened.length, 1)
  f.scheduler.end('finished'); await f.scheduler.settle()
})

test('no implicit concurrency cap is imposed on domains or acquisitions', async () => {
  const gate = deferred<AcquisitionResult>()
  const tool: ToolSchema = { name: 'native', description: 'native', parameters: { type: 'object', properties: {
    action: { type: 'string', enum: Array.from({ length: 12 }, (_, index) => `action-${index}`) },
  }, required: ['action'] } }
  const f = fixture({ runWorker: async input => { void input.dispatch({}) }, openAcquisition: async request => ({
    provenance: { kind: 'independent_work_copy', scopeId: request.id, authoritative: false, snapshotStartedAt: 1, snapshotFinishedAt: 2 },
    execute: async () => gate.promise, close: async () => {},
  }) })
  assert.equal(f.launch('task', [tool]).count, 12)
  await tick()
  assert.equal(f.opened.length, 12)
  assert.equal(f.scheduler.getStatus().pendingAcquisitions, 12)
  assert.equal(f.scheduler.beginRequest().evidence.length, 0)
  gate.resolve(result()); await f.scheduler.settle()
  assert.equal(f.scheduler.beginRequest().evidence.length, 12)
  f.scheduler.end('finished')
})

test('cancellation during opening settles the late scope and prevents old-epoch publication', async () => {
  const gate = deferred<AcquisitionScope>()
  const signal = new AbortController()
  let executed = 0, closed = 0
  const f = fixture({ openAcquisition: async () => gate.promise })
  f.launch('task', [native], [user('task')], signal.signal); await tick()
  const pending = f.workers[0].dispatch({})
  await tick()
  signal.abort()
  assert.equal(f.scheduler.getStatus().closed, true)
  assert.equal(f.opened[0].signal.aborted, true)
  assert.equal(f.scheduler.getStatus().pendingAcquisitions, 1)
  gate.resolve({ provenance: { kind: 'independent_work_copy', scopeId: f.opened[0].id, authoritative: false,
    snapshotStartedAt: 1, snapshotFinishedAt: 2 }, execute: async () => { executed++; return result() }, close: async () => { closed++ } })
  await pending; assert.deepEqual(await f.scheduler.settle(), [])
  assert.equal(executed, 0); assert.equal(closed, 1)
  assert.equal(f.scheduler.getStatus().pendingAcquisitions, 0)
  f.scheduler.beginRun()
  assert.equal(f.scheduler.beginRequest().evidence.length, 0)
  assert.equal((await f.workers[0].dispatch({})).isError, true)
  assert.equal(f.opened.length, 1)
  f.scheduler.end('finished')
})

test('all dispatched calls join cleanup even after their worker stream fails, and cleanup errors are reported', async () => {
  const gate = deferred<AcquisitionResult>()
  let closed = 0
  const f = fixture({ runWorker: async input => {
    void input.dispatch({ query: 'one' }); void input.dispatch({ query: 'two' }); void input.dispatch({ query: 'three' })
    throw new Error('stream failed after emitting calls')
  }, openAcquisition: async request => ({
    provenance: { kind: 'independent_work_copy', scopeId: request.id, authoritative: false, snapshotStartedAt: 1, snapshotFinishedAt: 2 },
    execute: async () => gate.promise,
    close: async () => { closed++; if (closed === 1) throw new Error('cleanup failed') },
  }) })
  f.launch(); await tick()
  assert.equal(f.scheduler.getStatus().pendingWorkers, 0)
  assert.equal(f.scheduler.getStatus().pendingAcquisitions, 3)
  f.scheduler.reset('session_replaced')
  gate.resolve(result())
  const errors = await f.scheduler.settle()
  assert.equal(closed, 3); assert.equal(errors.length, 1); assert.match(errors[0], /cleanup failed/)
  assert.ok(f.events.some(event => event.event === 'se_worker_failed'))
  assert.ok(f.events.some(event => event.event === 'se_cleanup_failed'))
  f.scheduler.beginRun()
  assert.equal(f.scheduler.beginRequest().evidence.length, 0)
})

test('native error blocks are preserved, invalid receipts close, and completed failures refresh after progress', async () => {
  let open = 0, closed = 0
  const f = fixture({ openAcquisition: async request => {
    open++
    return { provenance: { kind: 'independent_work_copy', scopeId: open === 1 ? 'wrong-scope' : request.id,
      authoritative: false, snapshotStartedAt: 1, snapshotFinishedAt: 2 },
    execute: async () => ({ content: [{ type: 'text', text: 'native failure stderr complete' }], isError: true, meta: { nativeFailure: true } }),
    close: async () => { closed++ } }
  } })
  f.launch(); await tick()
  assert.equal((await f.workers[0].dispatch({})).isError, true)
  assert.equal(closed, 1)
  assert.equal(f.scheduler.beginRequest().evidence.length, 0)
  f.scheduler.observeAuthoritative(actor('new-progress', 'progress'))
  f.launch(); await tick()
  await f.workers[1].dispatch({})
  assert.equal(open, 2)
  const evidence = f.scheduler.beginRequest().evidence
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].observation.isError, true)
  assert.deepEqual(evidence[0].observation.content, [{ type: 'text', text: 'native failure stderr complete' }])
  assert.deepEqual(evidence[0].observation.meta, { nativeFailure: true })
  f.scheduler.end('finished'); await f.scheduler.settle()
})
