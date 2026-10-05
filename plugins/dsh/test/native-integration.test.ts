import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as Perseus from '../dist/index.js'
import type { AcquisitionProvider, AcquisitionScope } from '../src/execution.ts'

/** These tests load the installed, unmodified DSH services through the desktop launcher. */
const contexts: Context[] = []
const roots: string[] = []
after(async () => {
  for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

type Script = (options: GenerateOptions, ordinal: number) => AsyncIterable<StreamChunk> | readonly StreamChunk[]
class ScriptedNativeAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  actorRequests: GenerateOptions[] = []
  workerRequests: GenerateOptions[] = []
  actor: Script
  worker: Script
  constructor(actor: Script, worker: Script) { super(); this.actor = actor; this.worker = worker }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const worker = options.model === 'perseus-speculator'
    const target = worker ? this.workerRequests : this.actorRequests
    const ordinal = target.length
    target.push(options)
    for await (const chunk of (worker ? this.worker : this.actor)(options, ordinal)) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolResponse(rawId: string, name: string, args: Record<string, unknown>, opaque = false): StreamChunk[] {
  const id = ToolCallId(rawId), json = JSON.stringify(args), index = opaque ? 1 : 0
  return [
    ...(opaque ? [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'provider-owned reasoning' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'provider-owned reasoning' } },
    ] as StreamChunk[] : []),
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id, name, argumentsDelta: json.slice(0, 5) },
    { type: 'tool-call-delta', index, id, argumentsDelta: json.slice(5) },
    { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: json } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' }, ...(opaque ? { replayState: opaqueState } : {}) },
  ]
}

const opaqueState = {
  response: { encrypted: { signature: 'fixture-private-provider-signature', bytes: [13, 44, 5] } },
  blocks: [{ encrypted: 'opaque-reasoning-blob' }, { toolTransport: { cursor: 19 } }],
}
const imageBlock = {
  type: 'image' as const,
  attachment: { attachmentId: 'fixture-image-sha256', mediaType: 'image/png' as const, bytes: 68, width: 1, height: 1, name: 'fixture.png' },
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

async function waitUntil(condition: () => boolean, label: string, milliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

async function abortable(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const stopped = deferred<never>()
  const abort = () => stopped.reject(signal.reason ?? new Error('Acquisition canceled'))
  signal.addEventListener('abort', abort, { once: true })
  try { await Promise.race([promise, stopped.promise]) }
  finally { signal.removeEventListener('abort', abort) }
}

function messagesText(request: GenerateOptions): string {
  return request.messages.flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function assertOpaqueAndImage(request: GenerateOptions): void {
  assert.deepEqual(request.messages.flatMap(message => message.content).find(block => block.type === 'image'), imageBlock)
  const prior = request.messages.find(message => message.role === 'assistant'
    && message.content.some(block => block.type === 'reasoning'))
  assert.ok(prior, 'native reasoning block remains in the Actor transcript')
  assert.deepEqual(prior.source.replayState, opaqueState, 'provider replay envelope remains opaque and lossless')
}

type Diagnostic = { event: string; agentId: string; ordinal?: number; workerCount?: number; [key: string]: unknown }

/** Production loop fixture; it uses official local FS tools, not a hand-written loop. */
async function nativeHarness(adapter: ScriptedNativeAdapter, config: Record<string, unknown> = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'perseus-native-authority-'))
  const acquisitionRoot = await mkdtemp(join(tmpdir(), 'perseus-native-copies-'))
  roots.push(workspace, acquisitionRoot)
  for (const [name, content] of Object.entries({
    'actor0.txt': 'AUTHORITATIVE_ZERO', 'actor1.txt': 'AUTHORITATIVE_ONE',
    'actor2.txt': 'AUTHORITATIVE_TWO', 'speculative.txt': 'FUTURE_SOURCE_EVIDENCE',
  })) await writeFile(join(workspace, name), content)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: workspace })
  await ctx.plugin(ToolFs, {})
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Perseus, {
    tools: ['read'], model: 'perseus-speculator',
    execution: { tempRoot: acquisitionRoot, ...(config.execution as object ?? {}) },
    ...Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'execution')),
  })
  ctx.llm.registerAdapter(['fixture-native'], adapter)
  const diagnostics: Diagnostic[] = []
  ctx.on('perseus/event', (event: Diagnostic) => { diagnostics.push(event) })
  const agent = await ctx.agentLoop.create(SessionId(`native-${roots.length}`), { provider: 'fixture-native', model: 'actor' }, { cwd: workspace })
  return { ctx, agent, workspace, acquisitionRoot, diagnostics }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

function send(agent: Agent, text = 'Explore the files', image = false): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }, ...(image ? [imageBlock] : [])] as ContentBlock[], source: { kind: 'user' } }))
}

/** Provider gate surrounds real DSH read execution in ExecutionManager's fresh work copy. */
function gatedNativeReadProvider() {
  const release = deferred()
  const allocated: AcquisitionScope[] = []
  const executed: string[] = []
  const closed: string[] = []
  const provider: AcquisitionProvider = {
    id: 'fixture', tools: ['read'],
    async create(scope) {
      allocated.push(scope)
      const copy = new Context()
      await copy.plugin(SystemPrompt, {})
      await copy.plugin(ToolRuntime, { mode: 'native' })
      await copy.plugin(LocalFileSystem, { cwd: scope.isolatedWorkspace })
      await copy.plugin(ToolFs, {})
      let executionScope: ReturnType<typeof createScope>
      const acquisitionAgent = { id: scope.acquisitionId, session: { header: { cwd: scope.isolatedWorkspace } } } as unknown as Agent
      await copy.plugin(Object.assign((inner: Context) => {
        executionScope = createScope(inner, acquisitionAgent)
        acquisitionAgent.ctx = executionScope.ctx
      }, { inject: ['tools', 'systemPrompt'] }))
      return {
        isolation: { kind: 'provider-acquisition-scope', scopeId: scope.acquisitionId, independentWrites: true, network: 'provider-scoped' },
        async execute(call) {
          executed.push(scope.acquisitionId)
          await writeFile(join(scope.isolatedWorkspace, 'copy-only.txt'), 'NO_MERGE')
          await abortable(release.promise, call.signal)
          return copy.tools.execute({ name: call.toolName, arguments: call.arguments, callId: ToolCallId(scope.acquisitionId), agent: acquisitionAgent, signal: call.signal })
        },
        async close() {
          await executionScope!.dispose()
          await copy.fiber.dispose()
          closed.push(scope.acquisitionId)
        },
      }
    },
  }
  return { provider, release, allocated, executed, closed }
}

test('native request admission is durable; pending work survives requests and native Actor execution', { timeout: 20_000 }, async () => {
  const gate = gatedNativeReadProvider()
  let harness!: Awaited<ReturnType<typeof nativeHarness>>
  const adapter = new ScriptedNativeAdapter(async function* (options, ordinal) {
    if (ordinal === 0) {
      await waitUntil(() => gate.executed.length === 1, 'first isolated native acquisition')
      yield* toolResponse('actor-call-0', 'read', { file_path: 'actor0.txt' }, true)
    } else if (ordinal === 1) {
      assert.equal(messagesText(options).includes('FUTURE_SOURCE_EVIDENCE'), false, 'pending evidence is absent')
      await waitUntil(() => harness.diagnostics.some(event => event.event === 'se_execution_reused'), 'cross-request Future reuse')
      assert.equal(gate.allocated.length, 1, 'reuse did not open a second native execution scope')
      yield* toolResponse('actor-call-1', 'read', { file_path: 'actor1.txt' })
    } else if (ordinal === 2) {
      assert.equal(messagesText(options).includes('FUTURE_SOURCE_EVIDENCE'), false, 'request snapshot does not wait for pending work')
      gate.release.resolve()
      await waitUntil(() => harness.diagnostics.some(event => event.event === 'se_tool_completed'), 'independent native result completion')
      yield* toolResponse('actor-call-2', 'read', { file_path: 'actor2.txt' })
    } else if (ordinal === 3) {
      assert.ok(messagesText(options).includes('FUTURE_SOURCE_EVIDENCE'), 'earlier ready evidence is visible in this actual model request')
      assert.ok(harness.agent.session.snapshotEvents().some(event => event.type === 'user/message'
        && JSON.stringify(event.data).includes('FUTURE_SOURCE_EVIDENCE')), 'evidence was durably logged before adapter dispatch')
      assertOpaqueAndImage(options)
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'deterministic retry', code: 'SERVER' } } }
    } else {
      assert.equal(ordinal, 4, 'only one retry is requested')
      assertOpaqueAndImage(options)
      yield* textResponse('done')
    }
  }, async function* (_options, ordinal) {
    if (ordinal < 2) yield* toolResponse(`worker-call-${ordinal}`, 'read', { file_path: 'speculative.txt' })
    else yield* textResponse('no additional acquisition')
  })
  harness = await nativeHarness(adapter, { execution: { routes: { read: 'fixture' } } })
  harness.ctx.perseus.registerAcquisitionProvider(gate.provider)
  const parentPolicyCalls: string[] = []
  harness.ctx.on('tools/pre-execute', async (exec, next) => {
    parentPolicyCalls.push(exec.callId)
    return next()
  })
  harness.ctx.on('agent/request-error', async () => ({ kind: 'retry' as const }))
  const idle = waitForIdle(harness.ctx, harness.agent)
  send(harness.agent, 'Explore the files', true)
  await idle
  assert.equal(adapter.actorRequests.length, 5)
  assert.equal(gate.allocated.length, 1)
  assert.equal(gate.executed.length, 1)
  assert.equal(gate.closed.length, 1)
  assert.equal(parentPolicyCalls.filter(id => id.startsWith('perseus:')).length, 1,
    'an independent acquisition passes through the parent native policy pipeline exactly once')
  assert.equal(parentPolicyCalls.filter(id => id.startsWith('actor-call-')).length, 3)
  assert.deepEqual(adapter.workerRequests[0]!.tools?.[0]?.parameters,
    harness.agent.ctx.tools.schemas(harness.agent).find(tool => tool.name === 'read')!.parameters,
    'a native read domain retains the original schema')
  const toolResults = harness.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
  assert.equal(toolResults.length, 3, 'only the authoritative Actor publishes native tool results to its session')
  assert.equal(harness.ctx.agents.list().length, 1, 'speculators are single model generations and do not create additional Actors')
  for (const expected of ['AUTHORITATIVE_ZERO', 'AUTHORITATIVE_ONE', 'AUTHORITATIVE_TWO']) {
    assert.ok(toolResults.some(event => JSON.stringify(event.data).includes(expected)), `native Actor ${expected} tool result is authoritative`)
  }
  const disclosures = harness.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
    && event.data.source.kind === 'perseus-evidence')
  assert.equal(disclosures.length, 1, 'the same ready observation is persisted once across admission and retry')
  const observation = disclosures[0]!.data.source.observations[0]!
  assert.equal(observation.tool, 'read')
  assert.deepEqual(observation.arguments, { file_path: 'speculative.txt' })
  assert.ok(JSON.stringify(observation.content).includes('FUTURE_SOURCE_EVIDENCE'))
  assert.equal(observation.environment?.authoritative, false)
  assert.ok(Number.isFinite(observation.environment?.snapshotStartedAt))
  assert.ok(observation.environment!.snapshotFinishedAt >= observation.environment!.snapshotStartedAt)
  const receipt = observation.meta as { execution: { provider: string; merged: boolean; isolatedWorkspace: string; sourceWorkspace: string; isolation: { independentWrites: boolean } } }
  assert.equal(receipt.execution.provider, 'fixture')
  assert.equal(receipt.execution.merged, false)
  assert.equal(receipt.execution.isolation.independentWrites, true)
  assert.equal(receipt.execution.isolatedWorkspace, gate.allocated[0]!.isolatedWorkspace)
  assert.equal(receipt.execution.sourceWorkspace, gate.allocated[0]!.sourceWorkspace)
  const waves = harness.diagnostics.filter(event => event.event === 'se_wave_started')
  assert.deepEqual(waves.map(event => event.ordinal), [0, 1, 2, 3], 'SE admission and retry do not open duplicate waves')
  assert.ok(adapter.workerRequests.length >= 2)
  const workerHistory = adapter.workerRequests[1]!.messages
  assert.deepEqual(workerHistory.flatMap(message => message.content).find(block => block.type === 'image'), imageBlock)
  assert.equal(workerHistory.some(message => message.source?.replayState !== undefined), false,
    'an alternate worker route does not replay provider-owned Actor metadata')
  assert.equal(workerHistory.flatMap(message => message.content).some(block => block.type === 'reasoning'), false)
  assert.ok(messagesText(adapter.workerRequests[1]!).includes('Native Actor invocation: read'))
  assert.deepEqual(await readdir(harness.acquisitionRoot), [], 'independent copies were removed after completion')
  assert.equal((await readdir(harness.workspace)).includes('copy-only.txt'), false, 'copy writes never merged into the Actor workspace')
  assert.ok(harness.diagnostics.some(event => event.event === 'se_run_ended'), 'final Actor response ends speculative work')
})

test('stream-complete tool calls dispatch immediately; final response cancels and cleans pending copies', { timeout: 15_000 }, async () => {
  const gate = gatedNativeReadProvider()
  const streamEnd = deferred()
  let harness!: Awaited<ReturnType<typeof nativeHarness>>
  const adapter = new ScriptedNativeAdapter(async function* () {
    await waitUntil(() => gate.executed.length === 1, 'native acquisition before worker finish')
    assert.equal(harness.diagnostics.some(event => event.event === 'se_worker_ended'), false, 'dispatch occurred before worker stream finished')
    yield* textResponse('final Actor answer')
  }, async function* (options) {
    const chunks = toolResponse('worker-before-finish', 'read', { file_path: 'speculative.txt' })
    for (const chunk of chunks.slice(0, -2)) yield chunk
    await abortable(streamEnd.promise, options.signal!)
    yield* chunks.slice(-2)
  })
  harness = await nativeHarness(adapter, { execution: { routes: { read: 'fixture' } } })
  harness.ctx.perseus.registerAcquisitionProvider(gate.provider)
  const idle = waitForIdle(harness.ctx, harness.agent)
  send(harness.agent)
  await idle
  await waitUntil(() => gate.closed.length === 1, 'final-answer cleanup')
  assert.equal(gate.allocated[0]!.signal.aborted, true)
  assert.deepEqual(await readdir(harness.acquisitionRoot), [])
  assert.equal(harness.agent.session.snapshotEvents().some(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes('FUTURE_SOURCE_EVIDENCE')), false, 'canceled late evidence cannot publish')
})

test('native Actor cancellation joins independent cleanup without publishing late evidence', { timeout: 15_000 }, async () => {
  const gate = gatedNativeReadProvider()
  const actorHold = deferred()
  const adapter = new ScriptedNativeAdapter(async function* (options) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'partial' }
    await abortable(actorHold.promise, options.signal!)
  }, () => toolResponse('worker-cancel', 'read', { file_path: 'speculative.txt' }))
  const harness = await nativeHarness(adapter, { execution: { routes: { read: 'fixture' } } })
  harness.ctx.perseus.registerAcquisitionProvider(gate.provider)
  const idle = waitForIdle(harness.ctx, harness.agent)
  send(harness.agent)
  await waitUntil(() => gate.executed.length === 1, 'pending cancellation fixture')
  harness.agent.cancel({ kind: 'user', reason: 'native integration cancellation' })
  await idle
  await harness.ctx.perseus.settle(harness.agent.id)
  await waitUntil(() => gate.closed.length === 1, 'cancel cleanup')
  assert.equal(gate.allocated[0]!.signal.aborted, true)
  assert.deepEqual(await readdir(harness.acquisitionRoot), [])
  assert.ok(harness.agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted'))
  assert.equal(harness.agent.session.snapshotEvents().some(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes('FUTURE_SOURCE_EVIDENCE')), false)
})

test('parent native policy can deny speculation before any independent provider executes', { timeout: 10_000 }, async () => {
  const gate = gatedNativeReadProvider()
  let harness!: Awaited<ReturnType<typeof nativeHarness>>
  let denied = 0, actorPolicyCalls = 0
  const adapter = new ScriptedNativeAdapter(async function* (_options, ordinal) {
    if (ordinal === 0) {
      await waitUntil(() => harness.diagnostics.some(event => ['se_execution_without_receipt', 'se_tool_failed'].includes(event.event)), 'policy-denied acquisition settlement')
      yield* toolResponse('policy-actor-call', 'read', { file_path: 'actor0.txt' })
    } else yield* textResponse('policy test complete')
  }, (_options, ordinal) => ordinal === 0
    ? toolResponse('policy-worker-call', 'read', { file_path: 'speculative.txt' }) : textResponse('no more work'))
  harness = await nativeHarness(adapter, { execution: { routes: { read: 'fixture' } } })
  harness.ctx.perseus.registerAcquisitionProvider(gate.provider)
  harness.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.callId.startsWith('perseus:')) {
      denied++
      return { kind: 'deny' as const, reason: 'fixture native policy denied speculation' }
    }
    actorPolicyCalls++
    return next()
  })
  const idle = waitForIdle(harness.ctx, harness.agent)
  send(harness.agent)
  await idle
  assert.equal(denied, 1)
  assert.equal(actorPolicyCalls, 1)
  assert.equal(gate.allocated.length, 0, 'parent denial never allocates a work copy or starts a provider')
  assert.equal(harness.agent.session.snapshotEvents().some(event => event.type === 'user/message'
    && event.data.source.kind === 'perseus-evidence'), false,
    'policy denial has no independent acquisition receipt and cannot mint speculative evidence')
  assert.ok(harness.agent.session.snapshotEvents().some(event => event.type === 'tool/result'
    && JSON.stringify(event.data).includes('AUTHORITATIVE_ZERO')), 'native Actor execution remains governed by its normal policy')
  assert.deepEqual(await readdir(harness.acquisitionRoot), [])
})

test('built-in provider uses the actual Desktop native read and removes its independent work copy', { timeout: 20_000 }, async () => {
  let harness!: Awaited<ReturnType<typeof nativeHarness>>
  const adapter = new ScriptedNativeAdapter(async function* (options, ordinal) {
    if (ordinal === 0) {
      await waitUntil(() => harness.diagnostics.some(event => ['se_tool_completed', 'se_tool_failed', 'se_worker_failed', 'se_invalid_arguments'].includes(event.event)), 'Desktop native isolated read', 12_000)
      assert.ok(harness.diagnostics.some(event => event.event === 'se_tool_completed'), JSON.stringify(harness.diagnostics))
      yield* toolResponse('native-actor-read', 'read', { file_path: 'actor0.txt' })
    } else {
      assert.ok(messagesText(options).includes('FUTURE_SOURCE_EVIDENCE'), 'native provider evidence reached the next actual request')
      yield* textResponse('native provider complete')
    }
  }, (_options, ordinal) => ordinal === 0
    ? toolResponse('native-worker-read', 'read', { file_path: 'speculative.txt' }) : textResponse('finished'))
  harness = await nativeHarness(adapter)
  const idle = waitForIdle(harness.ctx, harness.agent)
  send(harness.agent)
  await idle
  assert.equal(adapter.actorRequests.length, 2, JSON.stringify({ diagnostics: harness.diagnostics,
    end: harness.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end') }))
  assert.equal(harness.diagnostics.some(event => event.event === 'se_tool_failed'), false)
  assert.deepEqual(await readdir(harness.acquisitionRoot), [])
  assert.equal(await readFile(join(harness.workspace, 'speculative.txt'), 'utf8'), 'FUTURE_SOURCE_EVIDENCE')
  assert.ok(harness.agent.session.snapshotEvents().some(event => event.type === 'tool/result'
    && JSON.stringify(event.data).includes('AUTHORITATIVE_ZERO')))
})

test('native Config preserves omitted containers and explicit empty allowlists', () => {
  // The five operator-facing fields are `.volatile()`, so the schema resolves them
  // to cosmokit references; read through them exactly as the plugin's `live()` does.
  const live = <T>(value: T | { get(): T }): T => typeof value === 'object' && value !== null && 'get' in value
    ? (value as { get(): T }).get() : value as T
  const omitted = Perseus.Config({})
  assert.equal(live(omitted.enabled), true)
  assert.equal(live(omitted.tools), undefined)
  assert.equal(omitted.execution, undefined)
  const partial = Perseus.Config({ execution: { tempRoot: '/tmp/fixture-config-only' } })
  assert.equal(partial.execution?.routes, undefined)
  assert.equal(partial.execution?.childEnv, undefined)
  const explicit = Perseus.Config({ tools: [], execution: { routes: {}, childEnv: {} } })
  assert.deepEqual(live(explicit.tools), [])
  assert.deepEqual(explicit.execution?.routes, {})
  assert.deepEqual(explicit.execution?.childEnv, {})
})

test('surface replacement and same-id seeded restoration do not revive hidden speculative knowledge', { timeout: 15_000 }, async () => {
  let harness!: Awaited<ReturnType<typeof nativeHarness>>
  let replacement!: Agent
  const restoredId = SessionId('native-same-id-replacement')
  const adapter = new ScriptedNativeAdapter(async function* (options, ordinal) {
    if (ordinal === 0) yield* textResponse('original session bootstrap')
    else if (ordinal === 1) {
      await waitUntil(() => harness.diagnostics.some(event => event.agentId === restoredId
        && event.event === 'se_tool_completed'), 'restored Actor independent native read')
      yield* toolResponse('replacement-actor-read', 'read', { file_path: 'actor0.txt' })
    } else {
      assert.equal(ordinal, 2)
      assert.ok(messagesText(options).includes('FUTURE_SOURCE_EVIDENCE'),
        'removed ledger knowledge cannot suppress a newly acquired complete observation')
      assert.equal(JSON.stringify(options.messages).includes('HIDDEN_REMOVED_OBSERVATION'), false,
        'compacted evidence stays outside the restored model-visible surface')
      yield* textResponse('restored session complete')
    }
  }, (_options, ordinal) => ordinal === 1
    ? toolResponse('replacement-worker-read', 'read', { file_path: 'speculative.txt' }) : textResponse('no acquisition'))
  harness = await nativeHarness(adapter)
  const original = await harness.ctx.agents.create({ sessionId: restoredId,
    agentOptions: { provider: 'fixture-native', model: 'actor' }, meta: { cwd: harness.workspace } })
  const initialIdle = waitForIdle(harness.ctx, original.agent)
  send(original.agent, 'bootstrap a native session before replacement')
  await initialIdle
  const futureTime = Date.now() + 1_000_000
  const hiddenObservation = { id: 'fixture-hidden-observation', tool: 'read', arguments: { file_path: 'speculative.txt' },
    content: [{ type: 'text' as const, text: 'HIDDEN_REMOVED_OBSERVATION' }], isError: false,
    start: futureTime, end: futureTime + 1,
    environment: { kind: 'independent_work_copy' as const, scopeId: 'fixture-hidden-observation', authoritative: false as const,
      snapshotStartedAt: futureTime, snapshotFinishedAt: futureTime + 1 } }
  const hidden = original.agent.session.append('user/message', Perseus.evidenceMessage([{
    observation: hiddenObservation, units: [{ source: { tool: 'read', arguments: hiddenObservation.arguments },
      location: '/', value: { content: hiddenObservation.content }, kind: 'native_observation' }], decisions: [],
  }]), { surfaceOp: 'append' })
  original.agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Compacted acquisition notice; the previous observation was removed.' }],
    source: { kind: 'perseus-history' },
  }), { surfaceOp: { op: 'replace', startSeq: hidden.seq, endSeq: hidden.seq }, sourceEventSeqs: [hidden.seq] })
  const seed = [...original.agent.session.snapshotEvents()]
  assert.ok(seed.some(event => event.type === 'user/message' && JSON.stringify(event.data).includes('HIDDEN_REMOVED_OBSERVATION')),
    'hidden evidence remains auditable in the append-only log')
  assert.equal(JSON.stringify(original.agent.session.deriveMessages()).includes('HIDDEN_REMOVED_OBSERVATION'), false)
  await original.dispose()
  const restored = await harness.ctx.agents.create({ sessionId: restoredId, seed,
    agentOptions: { provider: 'fixture-native', model: 'actor' }, meta: { cwd: harness.workspace } })
  replacement = restored.agent
  assert.notEqual(replacement, original.agent)
  harness.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.callId.startsWith('perseus:')) assert.equal(exec.agent, replacement,
      'same-id restoration dispatches through the new Actor scope')
    return next()
  })
  const idle = waitForIdle(harness.ctx, replacement)
  send(replacement, 'continue after restoring compacted history')
  await idle
  assert.equal(adapter.actorRequests.length, 3)
  assert.ok(harness.ctx.perseus.status(restoredId)?.counts.se_delta_selected,
    'the resumed session selected newly completed evidence')
  await restored.dispose()
  await harness.ctx.perseus.settle(restoredId)
  assert.deepEqual(await readdir(harness.acquisitionRoot), [])
})

test('public dsh profile loader installs and imports the packed external plugin bundle', { timeout: 45_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'perseus-profile-smoke-'))
  roots.push(home)
  const project = fileURLToPath(new URL('..', import.meta.url))
  const resources = process.env.DSH_DESKTOP_RESOURCES ?? '/Applications/DeepSeek Harness.app/Contents/Resources'
  const npmConfig = join(home, 'empty.npmrc')
  await writeFile(npmConfig, '')
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', NPM_CONFIG_USERCONFIG: npmConfig }
  const cli = (args: string[]) => spawnSync(join(resources, 'runtime', 'cli', 'bin', 'dsh'), args,
    { cwd: home, encoding: 'utf8', timeout: 15_000, env })
  const initialize = cli(['perseus-smoke', '--from-default-profile', 'headless', '--dump-config'])
  assert.equal(initialize.error, undefined)
  assert.equal(initialize.status, 0, initialize.stderr)
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', home],
    { cwd: project, encoding: 'utf8', timeout: 15_000, env })
  assert.equal(packed.error, undefined)
  assert.equal(packed.status, 0, packed.stderr)
  const tarball = join(home, JSON.parse(packed.stdout)[0].filename)
  const installed = cli(['plugin', '--profile', 'perseus-smoke', 'add', tarball, '--offline', '--ignore-scripts'])
  assert.equal(installed.error, undefined)
  assert.equal(installed.status, 0, installed.stderr)
  const result = cli(['perseus-smoke', '--dump-config-schema'])
  assert.equal(result.error, undefined, 'public CLI profile smoke completed within its deadline')
  assert.equal(result.status, 0, result.stderr)
  const schema = JSON.parse(result.stdout)
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.ok(result.stdout.includes('dsh-plugin-perseus'), 'official schema dump resolved the installed external bundle')
  assert.ok(result.stdout.includes('"enabled"'), 'official schema dump imported the external Config declaration')
  assert.equal(result.stdout.includes('fixture-private-provider-signature'), false)
})
