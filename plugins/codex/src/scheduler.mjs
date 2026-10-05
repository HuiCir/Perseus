import { randomUUID } from 'node:crypto'
import { canonicalJSON, DOMAINS } from './cache.mjs'
import { domainId, domainCacheKey } from './tool-registry.mjs'

export { DOMAINS }

const copy = value => structuredClone(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function errorValue(error) {
  if (!(error instanceof Error)) return { message: String(error), value: error }
  return { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}),
    ...Object.fromEntries(Object.entries(error)) }
}

/** Hook-event scheduling. A boundary is deliberately not an internal model-request ordinal. */
export class Swarm {
  constructor({ generate, acquire, emit = () => {}, registry }) {
    if (typeof generate !== 'function' || typeof acquire !== 'function' || typeof emit !== 'function')
      throw new TypeError('Swarm requires generate, acquire, and an optional emit function')
    this.generate = generate
    this.acquire = acquire
    this.emit = emit
    this.registry = registry
    this.domains = registry ? registry.derive([]) : DOMAINS
    this.boundary = 0
    this.revision = 0
    this.epoch = 0
    this.closed = false
    this.factsArray = []
    this.promptEvents = new Set()
    this.toolEvents = new Set()
    this.progress = new Map()
    this.issued = new Map()
    this.generating = new Map()
    this.workers = new Set()
    this.futures = new Map()
    this.allFutures = new Set()
    this.pending = new Set()
    this.knownResults = new Map()
    this.errors = []
    this.counts = { waves: 0, workers: 0, acquisitions: 0, reusedAcquisitions: 0,
      admittedObservations: 0, duplicateObservations: 0, invalidActions: 0, workerFailures: 0, acquisitionFailures: 0 }
  }

  report(event) {
    try { this.emit({ boundary: this.boundary, boundaryKind: 'hook_event', revision: this.revision, epoch: this.epoch, ...event }) }
    catch (error) { this.errors.push({ kind: 'emit', error: errorValue(error) }) }
  }

  /** Advance one hook boundary, collect ready older work, then observe and launch native progress. */
  handle(event) {
    this.boundary++
    const observations = this.collect()
    if (!this.closed) {
      try { this.observe(event) }
      catch (error) { this.errors.push({ kind: 'event', error: errorValue(error) }); this.report({ event: 'invalid_hook_event' }) }
      if (this.registry) this.domains = this.registry.derive(this.factsArray)
    }
    // A busy domain can defer the latest progress revision. It resumes only at
    // a later real host boundary, never from worker completion or SE admission.
    const launched = !this.closed && this.revision > 0 ? this.launch() : 0
    return { boundary: this.boundary, boundaryKind: 'hook_event', revision: this.revision, epoch: this.epoch,
      observations, launched }
  }

  observe(event) {
    if (!object(event)) throw new TypeError('A hook event must be an object')
    const name = event.hook_event_name ?? event.event
    if (name === 'UserPromptSubmit') {
      if (typeof event.prompt !== 'string') throw new TypeError('UserPromptSubmit requires its native prompt')
      const identity = canonicalJSON([event.turn_id ?? null, event.prompt])
      if (this.promptEvents.has(identity)) return false
      this.promptEvents.add(identity)
      this.factsArray.push({ kind: 'user_prompt', prompt: event.prompt,
        ...(event.turn_id ? { turnId: event.turn_id } : {}), boundary: this.boundary })
      this.revision++
      return true
    }
    if (name !== 'PostToolUse') return false
    if (typeof event.tool_use_id !== 'string' || !event.tool_use_id || typeof event.tool_name !== 'string' || !event.tool_name
      || !Object.hasOwn(event, 'tool_input') || !Object.hasOwn(event, 'tool_response'))
      throw new TypeError('PostToolUse requires its real tool_use_id, tool_name, tool_input, and full tool_response')
    const identity = canonicalJSON([event.tool_use_id, event.tool_name, event.tool_input, event.tool_response])
    if (this.toolEvents.has(identity)) return false
    this.toolEvents.add(identity)
    this.factsArray.push({ kind: 'tool_observation', toolUseId: event.tool_use_id, tool: event.tool_name,
      arguments: copy(event.tool_input), result: copy(event.tool_response), boundary: this.boundary })
    const key = canonicalJSON([event.tool_name, event.tool_input]), value = canonicalJSON(event.tool_response)
    if (this.progress.get(key) === value) return false
    this.progress.set(key, value)
    this.revision++
    return true
  }

  launch() {
    if (this.closed || this.revision <= 0 || !this.factsArray.length) return 0
    const stamp = domain => canonicalJSON([this.revision, domainCacheKey(domain)])
    const selected = this.domains.filter(domain => this.issued.get(domainId(domain)) !== stamp(domain) && !this.generating.has(domainId(domain)))
    if (!selected.length) return 0
    const revision = this.revision, epoch = this.epoch, sourceBoundary = this.boundary, facts = copy(this.factsArray)
    this.counts.waves++
    this.report({ event: 'wave_started', workerCount: selected.length, sourceBoundary })
    for (const domain of selected) {
      const id = domainId(domain)
      this.issued.set(id, stamp(domain))
      const controller = new AbortController(), token = randomUUID()
      const worker = { domain, revision, epoch, sourceBoundary, controller, token, promise: undefined }
      this.generating.set(id, token)
      this.workers.add(worker)
      this.counts.workers++
      const promise = Promise.resolve().then(async () => {
        if (this.closed || epoch !== this.epoch || controller.signal.aborted) return
        this.report({ event: 'worker_started', domain: id, revision, epoch, sourceBoundary })
        // The port owns Codex's turn transport. One generate invocation does not
        // assert that Codex internally made exactly one model request.
        const actions = await this.generate(domain, copy(facts), { signal: controller.signal, revision, epoch })
        for await (const action of actions) {
          if (this.closed || epoch !== this.epoch || controller.signal.aborted) break
          this.dispatch(domain, action, { revision, epoch, sourceBoundary })
        }
      }).catch(error => {
        if (!controller.signal.aborted && epoch === this.epoch) {
          this.counts.workerFailures++
          this.errors.push({ kind: 'worker', domain: id, revision, epoch, error: errorValue(error) })
        }
        this.report({ event: controller.signal.aborted ? 'worker_cancelled' : 'worker_failed', domain: id, revision, epoch, sourceBoundary })
      }).finally(() => {
        if (this.generating.get(id) === token) this.generating.delete(id)
        this.workers.delete(worker)
        this.pending.delete(promise)
        this.report({ event: 'worker_ended', domain: id, revision, epoch, sourceBoundary })
      })
      worker.promise = promise
      this.pending.add(promise)
    }
    return selected.length
  }

  dispatch(domain, action, { revision, epoch, sourceBoundary }) {
    let nativeAction, ownerId
    try {
      if (this.registry) {
        const prepared = this.registry.prepare(domain, action)
        nativeAction = prepared.action; ownerId = prepared.ownerId
        if (ownerId !== domainId(domain)) this.report({ event: 'action_reassigned', domain: domainId(domain), ownerId, revision, epoch, sourceBoundary })
      } else {
        if (!object(action) || action.tool !== domain || !DOMAINS.includes(action.tool) || !object(action.arguments))
          throw new TypeError('A completed action must belong to its fixed acquisition domain')
        canonicalJSON(action.arguments)
        nativeAction = { tool: action.tool, arguments: copy(action.arguments) }
      }
    } catch (error) {
      this.counts.invalidActions++
      this.report({ event: 'invalid_action', domain: domainId(domain), revision, epoch, sourceBoundary, error: errorValue(error) })
      return
    }
    const key = canonicalJSON(nativeAction), prior = this.futures.get(key)
    if (prior && (!prior.settled || prior.revision === revision)) {
      this.counts.reusedAcquisitions++
      this.report({ event: 'acquisition_reused', id: prior.id, tool: action.tool, revision, epoch, sourceBoundary })
      return prior.promise
    }
    const future = { id: randomUUID(), key, action: nativeAction, domainId: ownerId ?? domainId(domain), revision, epoch, sourceBoundary,
      controller: new AbortController(), settled: false, reviewed: false, observation: undefined, promise: undefined }
    this.futures.set(key, future)
    this.allFutures.add(future)
    this.counts.acquisitions++
    const startedAt = Date.now()
    this.report({ event: 'acquisition_started', id: future.id, tool: action.tool, revision, epoch, sourceBoundary })
    const promise = Promise.resolve().then(async () => {
      if (this.closed || epoch !== this.epoch || future.controller.signal.aborted) return
      let output
      try {
        output = await this.acquire(copy(nativeAction), { signal: future.controller.signal, revision, epoch })
        if (!object(output) || !Object.hasOwn(output, 'result') || !Object.hasOwn(output, 'receipt'))
          throw new TypeError('Acquisition must return its complete result and receipt')
        if (!object(output.receipt) || output.receipt.confirmed === false || output.receipt.merged === true
          || output.receipt.authoritative === true)
          throw new TypeError('Acquisition did not confirm an independent result receipt')
      } catch (error) {
        if (this.closed || epoch !== this.epoch || future.controller.signal.aborted) return
        this.counts.acquisitionFailures++
        const failure = errorValue(error)
        this.errors.push({ kind: 'acquisition', id: future.id, error: failure })
        future.failed = true
        return
      }
      if (!this.closed && epoch === this.epoch && !future.controller.signal.aborted) {
        future.observation = { id: future.id, tool: nativeAction.tool, arguments: copy(nativeAction.arguments),
          domainId: future.domainId,
          result: copy(output.result), receipt: copy(output.receipt), revision, epoch, sourceBoundary,
          startedAt, completedAt: Date.now(), authoritative: false }
      }
    }).catch(error => {
      this.counts.acquisitionFailures++
      future.failed = true
      this.errors.push({ kind: 'acquisition_result', id: future.id, error: errorValue(error) })
      this.report({ event: 'acquisition_failed', id: future.id, tool: action.tool, revision, epoch, sourceBoundary })
    }).finally(() => {
      future.settled = true
      this.pending.delete(promise)
      this.report({ event: future.observation ? 'acquisition_completed' : future.failed ? 'acquisition_failed' : 'acquisition_cancelled',
        id: future.id, tool: action.tool, revision, epoch, sourceBoundary })
    })
    future.promise = promise
    this.pending.add(promise)
    return promise
  }

  /** Synchronous, ready-only review; never advances the hook boundary or joins pending work. */
  collect() {
    const observations = []
    for (const future of this.allFutures) {
      if (!future.settled || !future.observation || future.reviewed || future.epoch !== this.epoch
        || future.sourceBoundary >= this.boundary) continue
      future.reviewed = true
      const observation = future.observation
      // Copy receipts are provenance. They never make identical complete native
      // evidence novel, and remain intact on every admitted observation.
      let fingerprint
      try { fingerprint = canonicalJSON(observation.result) }
      catch { fingerprint = `uncomparable:${observation.id}` }
      const source = canonicalJSON([observation.tool, observation.arguments])
      const known = this.knownResults.get(source) ?? []
      const receipt = observation.receipt
      const interval = object(receipt) && Number.isFinite(receipt.snapshotStartedAt) && Number.isFinite(receipt.snapshotFinishedAt)
        && receipt.snapshotStartedAt <= receipt.snapshotFinishedAt
        ? { start: receipt.snapshotStartedAt, end: receipt.snapshotFinishedAt }
        : { start: observation.startedAt, end: observation.completedAt }
      const duplicate = known.some(item => item.fingerprint === fingerprint)
      if (!known.some(item => interval.end < item.start)) {
        this.knownResults.set(source, [...known.filter(item => item.end >= interval.start), { fingerprint, ...interval }])
      }
      if (duplicate) {
        this.counts.duplicateObservations++
        this.report({ event: 'observation_duplicate', id: observation.id, sourceBoundary: observation.sourceBoundary })
        continue
      }
      observations.push(copy(observation))
      this.counts.admittedObservations++
      this.report({ event: 'observation_admitted', id: observation.id, sourceBoundary: observation.sourceBoundary })
    }
    return observations
  }

  status() {
    const futures = [...this.allFutures]
    const pendingAcquisitions = futures.filter(future => !future.settled).length
    return { boundary: this.boundary, boundaryKind: 'hook_event', revision: this.revision, epoch: this.epoch, closed: this.closed,
      pendingWorkers: this.workers.size, pendingAcquisitions, hasPending: this.workers.size + pendingAcquisitions > 0,
      readyObservations: futures.filter(future => future.observation && future.settled && !future.reviewed
        && future.epoch === this.epoch && future.sourceBoundary < this.boundary).length,
      unreviewedObservations: futures.filter(future => future.observation && future.settled && !future.reviewed && future.epoch === this.epoch).length,
      activeDomains: [...new Set([...this.workers].map(worker => domainId(worker.domain)))],
      domainCount: this.domains.length, domains: this.domains.map(domain => ({ id: domainId(domain), tool: typeof domain === 'string' ? domain : domain.toolName })),
      facts: this.factsArray.length, ...this.counts, errors: copy(this.errors) }
  }

  stop(reason) {
    if (this.closed) return
    this.closed = true
    this.epoch++
    for (const worker of this.workers) worker.controller.abort(reason)
    for (const future of this.allFutures) future.controller.abort(reason)
    this.futures.clear()
    this.issued.clear()
    this.generating.clear()
    this.report({ event: 'swarm_closed', reason })
  }

  /** Await cancellation/port cleanup only at explicit teardown, never on a hook admission. */
  async close(reason = 'closed') {
    this.stop(reason)
    while (this.pending.size) await Promise.allSettled([...this.pending])
    this.allFutures.clear()
    return this.status()
  }

  /** Compaction is an epoch replacement; old facts/Futures cannot restart the frontier. */
  async reset(reason = 'compaction') {
    await this.close(reason)
    this.factsArray = []
    this.promptEvents.clear()
    this.toolEvents.clear()
    this.progress.clear()
    this.knownResults.clear()
    this.revision++
    this.closed = false
    this.report({ event: 'swarm_reset', reason })
    return this.status()
  }
}
