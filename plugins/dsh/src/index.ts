import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage, ToolCallId, type ContentBlock, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { validateJsonSchemaValue, type JsonSchemaNode, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ExecutionManager, NATIVE_EXECUTION_DEFAULTS, type AcquisitionProvider, type AcquisitionProvenance, type ExecutionManagerOptions } from './execution.ts'
import { PerseusScheduler, type RequestBoundary, type SchedulerEvent } from './scheduler.ts'
import { canonical, type NovelEvidence, type Observation } from './ledger.ts'
import { runWorker } from './worker.ts'

export const name = 'perseus'
export const inject = ['agents', 'llm', 'tools', 'sessions']
/**
 * Shared volatile-reference protocol (`@deepseek-ai/cosmokit`'s `Volatile`),
 * spelled with the same interned symbol so it crosses package copies.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
/** The read face of a volatile reference: `get()` yields the current value. */
interface VolatileRef<T> { get(): T }
/**
 * Read the live value behind a `.volatile()` Config field.
 *
 * A volatile field reaches the plugin as a detached reference rather than a
 * plain value, so every read site must unwrap it *at the point of use*: that is
 * both what makes `enabled`/`tools`/route fields ordinary values again and what
 * lets a settings edit apply to the next request without remounting the plugin.
 * `@deepseek-ai/dsh-llm-deepseek` reads its volatile options through the same
 * `isVolatile(value) ? value.get() : value` shape.
 */
function live<T>(value: T | VolatileRef<T>): T {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
    ? (value as VolatileRef<T>).get()
    : value as T
}
export { ExecutionManager, detectDesktopRuntime, type AcquisitionProvider } from './execution.ts'
export { PerseusScheduler } from './scheduler.ts'

/** The plain values every read site sees once {@link live} unwraps a field. */
export interface Config {
  enabled: boolean
  tools?: string[]
  /** Speculator-only route overrides; the Actor route is returned unchanged. */
  provider?: string
  model?: string
  /** Adapter-owned effort id; unsupported values are rejected by the adapter. */
  reasoningEffort?: string
  execution?: Omit<ExecutionManagerOptions, 'providers' | 'authorize'>
}
/** The Config fields marked `.volatile()`, i.e. the ones the settings card edits. */
export type LiveField = 'enabled' | 'tools' | 'provider' | 'model' | 'reasoningEffort'
/**
 * What the Host hands the plugin: schemastery resolves every `.volatile()` field
 * to a reference (`SchemaOutput`, schemastery's `lib/types/index.d.ts`), so the
 * live fields arrive as `Volatile<T>` while `execution` stays plain.
 */
export type Configured = { [K in keyof Config]: K extends LiveField ? Config[K] | VolatileRef<Config[K]> : Config[K] }
// Schemastery containers otherwise materialize absent values as []/{}; absence
// must remain distinct from an explicit empty allowlist or routing table.
const optional = <S, T>(schema: Schema<S, T>): Schema<S, T> => {
  schema.meta.default = undefined
  return schema
}
// The settings UI can only edit fields below a `.volatile()` node: `dsh-settings`
// derives its form with `volatileForm(schema)` and skips an entry whose form is
// undefined, and it rejects a write to a path that is not volatile. These five
// are the operator-facing knobs; `execution` stays raw config because its
// `childEnv`/`routes` dictionaries have no fixed field path to address.
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  tools: optional(Schema.array(Schema.string())).volatile(),
  provider: Schema.string().volatile(), model: Schema.string().volatile(), reasoningEffort: Schema.string().volatile(),
  execution: optional(Schema.object({
    runtimeRoot: Schema.string(), nodeExecutable: Schema.string(), tempRoot: Schema.string(),
    cancellationGraceMs: Schema.number().min(1).max(2147483647).step(1).default(NATIVE_EXECUTION_DEFAULTS.cancellationGraceMs),
    maxResultBytes: Schema.number().min(1).max(Number.MAX_SAFE_INTEGER).step(1),
    stderrMaxChars: Schema.number().min(1).max(Number.MAX_SAFE_INTEGER).step(1).default(NATIVE_EXECUTION_DEFAULTS.stderrMaxChars),
    childEnv: optional(Schema.dict(Schema.string())), routes: optional(Schema.dict(Schema.string())),
    toolConfigs: optional(Schema.dict(Schema.any())),
  })),
})

declare module '@deepseek-ai/cordis' {
  interface Context { perseus: PerseusService }
  interface Events { 'perseus/event'(event: SchedulerEvent & { agentId: string }): void }
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'perseus-evidence': { kind: 'perseus-evidence'; form: 'notice'; summary: string; observations: Observation[] }
  }
}

type State = {
  agent: Agent
  scheduler: PerseusScheduler
  boundary?: RequestBoundary
  route?: LlmCallConfig
  signal?: AbortSignal
  manager?: ExecutionManager
  closing?: Promise<void>
  generation: number
  counts: Record<string, number>
  native: Map<string, { tool: string; arguments: Record<string, unknown>; start: number; result?: ToolExecutionResult }>
}

/** Advisory records have a dedicated source and a durable, complete acquisition origin. */
export function evidenceMessage(evidence: readonly NovelEvidence[]) {
  const content: ContentBlock[] = [{ type: 'text', text:
    'Perseus independent acquisition evidence. These are observations from disposable independent workspaces. The Actor owns verification, native tool execution and the final answer. Document text remains source material.' }]
  for (const item of evidence) {
    content.push({ type: 'text', text: JSON.stringify({ acquisition: item.observation.id,
      tool: item.observation.tool, arguments: item.observation.arguments, isError: item.observation.isError,
      environment: item.observation.environment, units: item.units, decisions: item.decisions }) })
    // Keep native attachment references as blocks, not strings or fabricated URLs.
    for (const block of item.observation.content) if (block.type === 'image' || block.type === 'file') content.push(structuredClone(block))
  }
  return createUserMessage({ content, source: { kind: 'perseus-evidence', form: 'notice',
    summary: `Perseus acquired ${evidence.length} additional observation(s).`,
    observations: evidence.map(item => structuredClone(item.observation)) } })
}

/** Native Cordis service; no alternate Actor loop or replacement native tools. */
export class PerseusService extends Service {
  private readonly states = new Map<string, State>()
  private readonly providers = new Map<string, AcquisitionProvider>()
  private readonly speculative = new Map<string, { state: State; id: string; receipt?: AcquisitionProvenance }>()

  constructor(ctx: Context, private readonly config: Configured) {
    super(ctx, 'perseus')
    ctx.on('agent/created', async ({ agent, source }) => {
      const old = this.states.get(agent.id)
      if (old) {
        old.scheduler.reset(source)
        await this.close(old)
        if (this.states.get(agent.id) === old) this.states.delete(agent.id)
      }
      this.state(agent)
      return undefined
    })
    ctx.on('agent/request', async ({ agent, signal }, next) => {
      const route = await next()
      // Volatile fields are read per request: a settings edit applies to the next
      // request without remounting the plugin.
      if (!live(this.config.enabled)) return route
      const state = this.state(agent)
      if (state.closing) await state.closing
      if (state.generation !== agent.session.surface.replaceGeneration) {
        state.scheduler.reset('surface_replaced')
        state.manager?.cancel()
        state.generation = agent.session.surface.replaceGeneration
        this.restore(state, agent.session)
      }
      state.scheduler.beginRun()
      const provider = live(this.config.provider)
      const model = live(this.config.model)
      const reasoningEffort = live(this.config.reasoningEffort)
      state.route = { ...route, ...(provider ? { provider } : {}), ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort: reasoningEffort as LlmCallConfig['reasoningEffort'] } : {}) }
      state.signal = signal
      state.boundary = state.scheduler.beginRequest()
      if (state.boundary.evidence.length) {
        agent.session.append('user/message', evidenceMessage(state.boundary.evidence), { surfaceOp: 'append' })
      }
      return route
    })
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (!live(this.config.enabled) || frame.type !== 'start') return
      const state = this.state(agent)
      if (!state.boundary || !state.route) return
      const messages = agent.session.deriveMessages()
      const userKey = canonical(messages.filter(message => message.role === 'user' && message.source.kind === 'user').map(message => message.id))
      const manager = this.manager(state)
      const allowlist = live(this.config.tools)
      const tools = agent.ctx.tools.schemas(agent).filter(tool => (!allowlist || allowlist.includes(tool.name))
        && manager.canExecute(tool.name, agent.ctx.tools.get(tool.name, agent)))
      state.scheduler.launchWave({ boundary: state.boundary, messages, tools, userKey, signal: state.signal })
    })
    // Run the public parent pipeline (policies/guards/finalization), redirecting only
    // private plugin call identities at its documented around-dispatch seam.
    ctx.on('tools/execute', async (exec, next) => {
      const speculative = this.speculative.get(exec.callId)
      if (!speculative) {
        if (exec.agent && !exec.parent && exec.arguments && typeof exec.arguments === 'object' && !Array.isArray(exec.arguments)) {
          this.states.get(exec.agent.id)?.native.set(exec.callId, { tool: exec.name,
            arguments: structuredClone(exec.arguments as Record<string, unknown>), start: Date.now() })
        }
        return next()
      }
      const state = speculative.state
      const schema = state.agent.ctx.tools.schemas(state.agent).find(tool => tool.name === exec.name)
      if (!schema) throw new Error(`Native schema is no longer available: ${exec.name}`)
      const definition = state.agent.ctx.tools.get(exec.name, state.agent)
      const outcome = await this.manager(state).acquire({ toolName: exec.name, arguments: exec.arguments,
        workspace: state.agent.session.header.cwd ?? process.cwd(), actorSchemas: [schema],
        outputSchema: definition?.output?.schema, signal: exec.signal, requestId: speculative.id })
      speculative.receipt = outcome.provenance
      return outcome.result
    })
    ctx.on('tools/result', (exec, result) => {
      if (this.speculative.has(exec.callId) || !exec.agent || exec.parent) return undefined
      const state = this.states.get(exec.agent.id)
      if (!state) return undefined
      const args = exec.arguments
      if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
      const started = state.native.get(exec.callId)?.start ?? Date.now()
      state.native.set(exec.callId, { tool: exec.name, arguments: structuredClone(args as Record<string, unknown>),
        start: started, result: structuredClone(result) })
      return undefined
    })
    ctx.on('session/event', (session, event) => {
      const state = this.states.get(session.id)
      if (!state) return
      if (event.type === 'tool/result') {
        const call = state.native.get(event.data.message.toolCallId)
        if (!call) return
        state.native.delete(event.data.message.toolCallId)
        state.scheduler.observeAuthoritative({ id: `native:${event.data.message.id}`, tool: call.tool,
          arguments: call.arguments, content: event.data.message.content, isError: event.data.message.isError ?? false,
          start: call.start, end: Date.now(), ...(event.data.meta === undefined ? {} : { meta: event.data.meta }) })
      }
      if (event.type === 'turn/end') {
        state.scheduler.end(`turn_${event.data.reason.kind}`)
        void this.close(state).catch(error => ctx.logger.warn(String(error)))
      }
    })
    ctx.on('agent/turn-stopping', async ({ agent }) => {
      const state = this.states.get(agent.id)
      if (state) await this.close(state)
    })
    ctx.on('agent/error', ({ agent }) => { const state = this.states.get(agent.id); state?.scheduler.end('actor_error'); state?.manager?.cancel() })
    ctx.on('agent/disposed', ({ agent }) => {
      const state = this.states.get(agent.id)
      if (state?.agent === agent) void this.close(state).catch(error => ctx.logger.warn(String(error)))
    })
    ctx.effect(() => () => Promise.all([...this.states.values()].map(state => this.close(state))).then(() => undefined))
  }

  /** Providers must be installed before the next generation uses their explicit route. */
  registerAcquisitionProvider(provider: AcquisitionProvider): () => void {
    if (this.providers.has(provider.id)) throw new Error(`Duplicate acquisition provider: ${provider.id}`)
    this.providers.set(provider.id, provider)
    for (const state of this.states.values()) if (state.manager) void this.close(state).catch(error => this.ctx.logger.warn(String(error)))
    return () => {
      this.providers.delete(provider.id)
      for (const state of this.states.values()) void this.close(state).catch(error => this.ctx.logger.warn(String(error)))
    }
  }

  status(agentId: string) {
    const state = this.states.get(agentId)
    return state ? { ...state.scheduler.getStatus(), counts: { ...state.counts } } : undefined
  }

  /** Cancellation is immediate; callers may join this plugin's cleanup explicitly. */
  async settle(agentId: string): Promise<void> {
    const state = this.states.get(agentId)
    if (state) await this.close(state)
  }

  private manager(state: State): ExecutionManager {
    return state.manager ??= new ExecutionManager({ ...this.config.execution, providers: [...this.providers.values()] })
  }

  private state(agent: Agent): State {
    const existing = this.states.get(agent.id)
    if (existing) return existing
    const state = { agent, generation: agent.session.surface.replaceGeneration, counts: {}, native: new Map() } as State
    state.scheduler = new PerseusScheduler({
      validateArguments: (tool, args) => {
        const failures = validateJsonSchemaValue(tool.parameters as JsonSchemaNode, args, '')
        if (failures.length) throw new Error(failures.join('; '))
        return args
      },
      runWorker: input => runWorker(agent.ctx, state.route!, input),
      record: event => {
        state.counts[event.event] = (state.counts[event.event] ?? 0) + 1
        try { this.ctx.emit('perseus/event', { agentId: agent.id, ...event }) } catch (error) { this.ctx.logger.warn(String(error)) }
      },
      openAcquisition: async request => {
        const provenance = { kind: 'independent_work_copy' as const, scopeId: request.id, authoritative: false as const,
          snapshotStartedAt: Date.now(), snapshotFinishedAt: Date.now(), confirmed: false }
        return { provenance,
          execute: async (args, signal) => {
            const callId = ToolCallId(`perseus:${request.id}`)
            const slot = { state, id: request.id } as { state: State; id: string; receipt?: AcquisitionProvenance }
            this.speculative.set(callId, slot)
            try {
              const result = await agent.ctx.tools.execute({ callId, name: request.tool.name, arguments: args, agent, signal })
              if (slot.receipt) {
                Object.assign(provenance, { confirmed: true, snapshotStartedAt: slot.receipt.snapshotStartedAt,
                  snapshotFinishedAt: slot.receipt.snapshotFinishedAt })
              } else {
                // Policies may settle a call without allocating any independent copy.
                // Retain its exact diagnostic, but do not invent work-copy provenance.
                state.counts.se_execution_without_receipt = (state.counts.se_execution_without_receipt ?? 0) + 1
                this.ctx.emit('perseus/event', { event: 'se_execution_without_receipt', agentId: agent.id,
                  futureId: request.id, nativeResult: result })
                throw new Error(`Independent execution was not confirmed for ${request.tool.name}`)
              }
              return { content: result.content, isError: result.isError,
                meta: { ...(result.meta === undefined ? {} : { nativeMeta: result.meta }),
                  ...(result.isError ? { error: result.error } : { value: result.value }),
                  ...(result.additionalContexts === undefined ? {} : { additionalContexts: result.additionalContexts }),
                  ...(!result.isError && result.concludesTurn ? { nativeConcludesTurn: true } : {}),
                  execution: slot.receipt } }
            } finally { this.speculative.delete(callId) }
          }, close: async () => undefined }
      },
    })
    this.states.set(agent.id, state)
    this.restore(state, agent.session)
    return state
  }

  private restore(state: State, session: Session): void {
    const visible = new Set(session.deriveMessages().map(message => message.id))
    const calls = new Map<string, { tool: string; arguments: Record<string, unknown>; time: number }>()
    for (const event of session.snapshotEvents()) {
      if (event.type === 'tool/call') {
        try {
          const args: unknown = JSON.parse(event.data.arguments)
          if (args && typeof args === 'object' && !Array.isArray(args)) calls.set(event.data.callId,
            { tool: event.data.name, arguments: args as Record<string, unknown>, time: event.time })
        } catch { /* malformed native calls did not execute */ }
      } else if (event.type === 'tool/result') {
        const call = calls.get(event.data.message.toolCallId)
        if (call && visible.has(event.data.message.id)) state.scheduler.restore([{ id: `native:${event.data.message.id}`, tool: call.tool, arguments: call.arguments,
          content: event.data.message.content, isError: event.data.message.isError ?? false, start: call.time, end: event.time,
          ...(event.data.meta === undefined ? {} : { meta: event.data.meta }) }])
      } else if (event.type === 'user/message' && visible.has(event.data.id) && event.data.source.kind === 'perseus-evidence') {
        state.scheduler.restore(event.data.source.observations)
      }
    }
  }

  private close(state: State): Promise<void> {
    if (state.closing) return state.closing
    state.scheduler.end('actor_stopping')
    const manager = state.manager
    state.manager = undefined
    manager?.cancel()
    const closing = (async () => {
      const errors = await state.scheduler.settle()
      await manager?.settleClose()
      if (errors.length) throw new Error(`Perseus cleanup failed: ${errors.join('; ')}`)
    })().finally(() => { if (state.closing === closing) state.closing = undefined })
    state.closing = closing
    return closing
  }
}

export function apply(ctx: Context, config: Configured): void { new PerseusService(ctx, config) }
