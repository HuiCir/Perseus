import { randomUUID } from 'node:crypto'
import type { ContentBlock, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { bindActionHead, deriveDomains, ownsDomain, type ActionDomain, type ObservedHead } from './domains.ts'
import { canonical, EvidenceLedger, type AcquisitionProvenance, type NovelEvidence, type Observation } from './ledger.ts'

/** Unmodified native tool result, including durable image/file references. */
export interface AcquisitionResult {
  content: readonly ContentBlock[]
  isError: boolean
  meta?: unknown
}

/** One isolated allocation per executable acquisition; separate calls never share it. */
export interface AcquisitionScope {
  provenance: AcquisitionProvenance
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<AcquisitionResult>
  close(): Promise<void>
}

/** Facts passed to the host that allocates an independent native executor. */
export interface AcquisitionRequest {
  id: string
  tool: ToolSchema
  arguments: Record<string, unknown>
  signal: AbortSignal
}

/** One model generation frontier. Dispatch starts work immediately without an Actor join. */
export interface WorkerRequest {
  domain: ActionDomain
  messages: readonly Message[]
  ordinal: number
  revision: number
  epoch: number
  signal: AbortSignal
  dispatch(args: Record<string, unknown>): Promise<AcquisitionResult>
}

/** Runtime events contain acquisition facts, never extra model-visible instructions. */
export interface SchedulerEvent {
  event: string
  ordinal?: number
  revision?: number
  epoch?: number
  [key: string]: unknown
}

/** Host-owned models, native validation, independent execution, and diagnostics. */
export interface SchedulerPorts {
  /** Resolve after the single model stream ends; the scheduler owns tool settlement. */
  runWorker(input: WorkerRequest): Promise<void>
  /** Validate/preprocess against the original native schema, never a weaker worker projection. */
  validateArguments(tool: ToolSchema, args: Record<string, unknown>): Record<string, unknown>
  openAcquisition(request: AcquisitionRequest): Promise<AcquisitionScope>
  /** Must not throw; reporting failure must not orphan native allocations. */
  record(event: SchedulerEvent): void
  now?: () => number
  newId?: () => string
}

/** Synchronous admission result. The host persists evidence before launching the wave. */
export interface RequestBoundary {
  ordinal: number
  revision: number
  epoch: number
  evidence: NovelEvidence[]
}

/** Actor history after current user input and all boundary evidence have been committed. */
export interface WaveRequest {
  boundary: RequestBoundary
  messages: readonly Message[]
  tools: readonly ToolSchema[]
  userKey: string
  signal?: AbortSignal
  deriveTools?: boolean
}

/** Current asynchronous state and cumulative session acquisition counts. */
export interface SchedulerStatus {
  ordinal: number
  revision: number
  epoch: number
  closed: boolean
  pendingWorkers: number
  pendingAcquisitions: number
  readyObservations: number
  waves: number
  workers: number
  executions: number
  reusedExecutions: number
  evidence: number
  invalidCalls: number
  cleanupErrors: readonly string[]
}

type Future = {
  id: string
  key: string
  revision: number
  origin: number
  epoch: number
  abort: AbortController
  promise: Promise<AcquisitionResult>
  observation?: Observation
  settled: boolean
  reviewed: boolean
}

type Worker = { abort: AbortController, promise: Promise<void>, token: string }
const failed = (error: unknown): AcquisitionResult => ({ content: [{ type: 'text', text: String(error) }], isError: true })

/** Session-owned asynchronous acquisitions; request boundaries never await pending work. */
export class PerseusScheduler {
  private ordinal = -1
  private revision = 0
  private epoch = 0
  private closed = false
  private lastWaveRevision = -1
  private userKey?: string
  private readonly ledger = new EvidenceLedger()
  private readonly progress = new Map<string, string>()
  private readonly observed = new Map<string, ObservedHead>()
  private readonly issued = new Map<string, number>()
  private readonly generating = new Map<string, string>()
  private readonly workers = new Set<Worker>()
  private readonly futures = new Map<string, Future>()
  private readonly allFutures = new Map<string, Future>()
  private readonly activeAcquisitions = new Set<Future>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly signals = new Map<AbortSignal, () => void>()
  private readonly cleanupErrors: string[] = []
  private readonly counts = { waves: 0, workers: 0, executions: 0, reusedExecutions: 0, evidence: 0, invalidCalls: 0 }
  private readonly now: () => number
  private readonly newId: () => string

  constructor(private readonly ports: SchedulerPorts) {
    this.now = ports.now ?? Date.now
    this.newId = ports.newId ?? randomUUID
  }

  /** Start a new host run while preserving already admitted session knowledge. */
  beginRun(): void { this.closed = false }

  /** Inspect asynchronous state without joining any worker or executor.
   * @returns A detached session status snapshot.
   */
  getStatus(): SchedulerStatus {
    return { ordinal: this.ordinal, revision: this.revision, epoch: this.epoch, closed: this.closed,
      pendingWorkers: this.workers.size,
      pendingAcquisitions: this.activeAcquisitions.size,
      readyObservations: [...this.allFutures.values()].filter(future => future.settled && future.observation && !future.reviewed).length,
      ...this.counts, cleanupErrors: [...this.cleanupErrors] }
  }

  /** Advance the request ordinal and synchronously admit ready earlier-request observations.
   * @returns Evidence that the host must append to its durable Actor history.
   */
  beginRequest(): RequestBoundary {
    const ordinal = ++this.ordinal
    const evidence: NovelEvidence[] = []
    const ready = [...this.allFutures.values()].filter(future => future.settled && future.observation && !future.reviewed
      && future.origin < ordinal && future.epoch === this.epoch)
      .sort((left, right) => left.observation!.end - right.observation!.end || left.id.localeCompare(right.id))
    for (const future of ready) {
      future.reviewed = true
      const delta = this.ledger.ingest(future.observation!)
      this.ports.record({ event: 'se_delta_selected', ordinal, revision: this.revision, epoch: this.epoch,
        futureId: future.id, sourceRequestOrdinal: future.origin, units: delta.units.length, decisions: delta.decisions })
      if (delta.units.length) { evidence.push(delta); this.counts.evidence++ }
    }
    return { ordinal, revision: this.revision, epoch: this.epoch, evidence }
  }

  /** Launch a single generation per domain/revision after admission and current-user persistence.
   * @param input - the native Actor snapshot for this request.
   * @returns The number of immediately scheduled worker streams.
   */
  launchWave(input: WaveRequest): number {
    if (this.closed || input.boundary.epoch !== this.epoch || input.boundary.ordinal !== this.ordinal) return 0
    if (input.signal?.aborted) { this.end('host_aborted'); return 0 }
    if (input.signal && !this.signals.has(input.signal)) {
      const signal = input.signal, abort = (): void => this.end('host_aborted')
      signal.addEventListener('abort', abort, { once: true }); this.signals.set(signal, abort)
    }
    if (this.userKey !== input.userKey) { this.userKey = input.userKey; this.revision++ }
    if (this.lastWaveRevision === this.revision) {
      this.ports.record({ event: 'se_wave_deferred', ordinal: this.ordinal, revision: this.revision, epoch: this.epoch, reason: 'no_new_progress' })
      return 0
    }
    this.lastWaveRevision = this.revision
    const domains = input.deriveTools === false ? input.tools.map(tool => ({ id: `${tool.name}:native`, tool,
      parameters: structuredClone(tool.parameters), bindings: {}, exclude: [], derived: false } satisfies ActionDomain))
      : deriveDomains(input.tools, [...this.observed.values()])
    const messages = structuredClone(input.messages)
    const revision = this.revision, epoch = this.epoch, ordinal = this.ordinal
    const selected = domains.filter(domain => this.issued.get(domain.id) !== revision && !this.generating.has(domain.id))
    this.counts.waves++; this.counts.workers += selected.length
    this.ports.record({ event: 'se_wave_started', ordinal, revision, epoch, workerCount: selected.length, domainCount: domains.length })
    for (const domain of selected) {
      this.issued.set(domain.id, revision)
      const abort = new AbortController(), token = this.newId()
      this.generating.set(domain.id, token)
      const worker: Worker = { abort, token, promise: Promise.resolve() }
      const promise = Promise.resolve().then(() => {
        if (this.closed || epoch !== this.epoch || abort.signal.aborted) return
        this.ports.record({ event: 'se_worker_started', ordinal, revision, epoch, domainId: domain.id, tool: domain.tool.name })
        return this.ports.runWorker({ domain: structuredClone(domain), messages: structuredClone(messages), ordinal,
          revision, epoch, signal: abort.signal,
          dispatch: args => this.dispatch(domain, args, ordinal, revision, epoch, abort.signal) })
      }).catch(error => {
        this.ports.record({ event: abort.signal.aborted ? 'se_worker_cancelled' : 'se_worker_failed', ordinal,
          revision, epoch, domainId: domain.id, error: String(error) })
      }).finally(() => {
        if (this.generating.get(domain.id) === token) this.generating.delete(domain.id)
        this.workers.delete(worker); this.pending.delete(promise)
        this.ports.record({ event: 'se_worker_ended', ordinal, revision, epoch, domainId: domain.id })
      })
      worker.promise = promise; this.workers.add(worker); this.pending.add(promise)
    }
    return selected.length
  }

  /** Observe a complete finalized native Actor result; SE observations never use this method.
   * @param observation - authoritative tool name, prepared arguments, native blocks/error and interval.
   */
  observeAuthoritative(observation: Observation): void {
    if (observation.environment) throw new Error('Independent evidence is not authoritative progress')
    this.ledger.ingest(observation)
    const key = canonical([observation.tool, observation.arguments])
    const value = canonical([observation.isError, observation.content, observation.meta])
    if (this.progress.get(key) !== value) { this.progress.set(key, value); this.revision++ }
    if (!observation.isError) this.observed.set(key, { tool: observation.tool,
      arguments: structuredClone(observation.arguments), isError: false })
  }

  /** Restore source knowledge from durable native/evidence records, never process-global caches.
   * @param observations - complete persisted observations in session order.
   */
  restore(observations: readonly Observation[]): void {
    for (const observation of observations) {
      if (observation.environment) this.ledger.ingest(observation)
      else this.observeAuthoritative(observation)
    }
  }

  private dispatch(domain: ActionDomain, raw: Record<string, unknown>, origin: number, revision: number,
    epoch: number, signal: AbortSignal): Promise<AcquisitionResult> {
    if (this.closed || epoch !== this.epoch || signal.aborted) return Promise.resolve(failed('Acquisition cancelled'))
    let args: Record<string, unknown>
    try {
      args = structuredClone(this.ports.validateArguments(domain.tool, bindActionHead(domain, raw)))
      if (!ownsDomain(domain, args)) throw new Error('Invocation does not belong to its acquisition domain')
    } catch (error) {
      this.ports.record({ event: 'se_invalid_arguments', ordinal: origin, revision, epoch,
        domainId: domain.id, tool: domain.tool.name, error: String(error) })
      this.counts.invalidCalls++
      return Promise.resolve(failed(error))
    }
    const key = canonical([domain.tool.name, args]), previous = this.futures.get(key)
    if (previous && (!previous.settled || previous.revision === revision)) {
      this.counts.reusedExecutions++
      this.ports.record({ event: 'se_execution_reused', ordinal: origin, revision, epoch, futureId: previous.id, tool: domain.tool.name })
      return previous.promise
    }
    const id = this.newId(), abort = new AbortController(), cancel = (): void => abort.abort()
    signal.addEventListener('abort', cancel, { once: true })
    const start = this.now()
    const future: Future = { id, key, revision, origin, epoch, abort, settled: false, reviewed: false, promise: Promise.resolve(failed('Not started')) }
    this.futures.set(key, future); this.allFutures.set(id, future)
    this.activeAcquisitions.add(future)
    this.counts.executions++
    this.ports.record({ event: 'se_tool_started', ordinal: origin, revision, epoch, futureId: id, tool: domain.tool.name, arguments: args })
    const promise = Promise.resolve().then(async (): Promise<AcquisitionResult> => {
      if (abort.signal.aborted || this.closed || epoch !== this.epoch) return failed('Acquisition cancelled')
      const scope = await this.ports.openAcquisition({ id, tool: domain.tool, arguments: args, signal: abort.signal })
      let result: AcquisitionResult
      try {
        const receipt = scope.provenance
        if (receipt.kind !== 'independent_work_copy' || receipt.authoritative !== false || receipt.scopeId !== id
          || !Number.isFinite(receipt.snapshotStartedAt) || !Number.isFinite(receipt.snapshotFinishedAt)
          || receipt.snapshotFinishedAt < receipt.snapshotStartedAt) throw new Error('Executor did not confirm independent acquisition')
        if (abort.signal.aborted || this.closed || epoch !== this.epoch) return failed('Acquisition cancelled')
        try { result = await scope.execute(args, abort.signal) } catch (error) {
          this.ports.record({ event: 'se_native_execution_failed', ordinal: origin, revision, epoch, futureId: id, error: String(error) })
          result = failed(error)
        }
        if (receipt.confirmed === false || receipt.kind !== 'independent_work_copy' || receipt.authoritative !== false
          || receipt.scopeId !== id || !Number.isFinite(receipt.snapshotStartedAt)
          || !Number.isFinite(receipt.snapshotFinishedAt) || receipt.snapshotFinishedAt < receipt.snapshotStartedAt)
          throw new Error('Executor did not confirm an independent acquisition after dispatch')
        if (!abort.signal.aborted && !this.closed && epoch === this.epoch) future.observation = {
          id, tool: domain.tool.name, arguments: args, content: structuredClone(result.content), isError: result.isError,
          start, end: this.now(), environment: structuredClone(receipt), ...(result.meta === undefined ? {} : { meta: structuredClone(result.meta) }) }
        return result
      } finally {
        try { await scope.close() } catch (error) {
          const description = `${id}: ${String(error)}`
          this.cleanupErrors.push(description)
          this.ports.record({ event: 'se_cleanup_failed', ordinal: origin, revision, epoch, futureId: id, error: String(error) })
        }
      }
    }).catch(error => {
      this.ports.record({ event: abort.signal.aborted ? 'se_tool_cancelled' : 'se_tool_failed', ordinal: origin,
        revision, epoch, futureId: id, tool: domain.tool.name, error: String(error) })
      return failed(error)
    }).then(result => {
      future.settled = true
      this.ports.record({ event: future.observation ? 'se_tool_completed' : 'se_tool_cancelled', ordinal: origin,
        revision, epoch, futureId: id, tool: domain.tool.name, isError: result.isError })
      return result
    }).finally(() => { signal.removeEventListener('abort', cancel); this.pending.delete(promise); this.activeAcquisitions.delete(future) })
    future.promise = promise; this.pending.add(promise)
    return promise
  }

  /** Cancel generations and every native allocation; late old-epoch results cannot publish.
   * @param reason - host task completion, cancellation, or session disposal reason.
   */
  end(reason: string): void {
    if (this.closed) return
    this.closed = true; this.epoch++; this.lastWaveRevision = -1
    for (const worker of this.workers) worker.abort.abort()
    for (const future of this.allFutures.values()) future.abort.abort()
    for (const [signal, handler] of this.signals) signal.removeEventListener('abort', handler)
    this.signals.clear(); this.futures.clear(); this.allFutures.clear(); this.issued.clear(); this.generating.clear()
    this.ports.record({ event: 'se_run_ended', ordinal: this.ordinal, revision: this.revision, epoch: this.epoch, reason })
  }

  /** Cancel prior work and clear knowledge after a host session/context replacement.
   * @param reason - explicit replacement reason.
   */
  reset(reason: string): void {
    this.end(reason); this.ledger.reset(); this.progress.clear(); this.observed.clear(); this.userKey = undefined; this.revision++
  }

  /** Wait only at teardown for generation and native-copy cleanup.
   * @returns Every cleanup failure, so the host can report unsettled allocations.
   */
  async settle(): Promise<string[]> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
    return [...this.cleanupErrors]
  }
}
