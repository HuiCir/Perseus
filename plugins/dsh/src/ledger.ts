import { createHash } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Identity and creation interval supplied by the independent execution host. */
export interface AcquisitionProvenance {
  kind: 'independent_work_copy'
  scopeId: string
  authoritative: false
  snapshotStartedAt: number
  snapshotFinishedAt: number
  /** Deferred parent-policy dispatch must confirm that a real copy was allocated. */
  confirmed?: boolean
}

/** Complete native result, retained independently of its model-facing disclosure. */
export interface Observation {
  id: string
  tool: string
  arguments: Record<string, unknown>
  content: readonly ContentBlock[]
  isError: boolean
  start: number
  end: number
  environment?: AcquisitionProvenance
  source?: Record<string, unknown>
  sourceVersion?: number | string
  meta?: unknown
}

/** An exact complete record; arbitrary native formats remain a single unit. */
export interface EvidenceUnit {
  source: Record<string, unknown>
  location: unknown
  value: unknown
  kind: 'native_observation' | 'error_observation' | 'search_record' | 'collection_metadata'
}

/** Why an observation's complete unit was admitted or omitted. */
export interface EvidenceDecision {
  reason: 'novel_complete_unit' | 'known_complete_unit' | 'older_than_known_observation'
  source: Record<string, unknown>
  location: unknown
  knownFrom: string[]
  concurrentConflicts: string[]
}

/** Admission delta plus its complete native observation and execution origin. */
export interface NovelEvidence {
  observation: Observation
  units: EvidenceUnit[]
  decisions: EvidenceDecision[]
}

/** Stable serialization for validated JSON arguments and native content.
 * @param value - JSON-compatible value.
 * @returns A property-order-independent exact identity.
 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}

const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const address = (unit: EvidenceUnit): string => canonical([unit.source, unit.location, unit.kind])

function exactJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text)
  const tokens = (input: string): RegExpMatchArray | null => input.match(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g)
  if (canonical(tokens(text)) !== canonical(tokens(JSON.stringify(parsed)))) throw new Error('Non-lossless JSON')
  return parsed
}

function httpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}

function unitsFor(observation: Observation): EvidenceUnit[] {
  const environment = observation.environment ? { execution_environment: observation.environment.kind } : {}
  const source = { ...(observation.source ?? { tool: observation.tool, arguments: observation.arguments }), ...environment }
  const whole = (kind: EvidenceUnit['kind']): EvidenceUnit[] => [{ source, location: '/',
    value: { content: observation.content, ...(observation.meta === undefined ? {} : { meta: observation.meta }) }, kind }]
  if (observation.isError) return whole('error_observation')
  if (observation.content.length !== 1 || observation.content[0]?.type !== 'text') return whole('native_observation')
  let value: unknown
  try { value = exactJson(observation.content[0].text) } catch { return whole('native_observation') }
  const items = Array.isArray(value) ? value : record(value) ? value.results : undefined
  if (!Array.isArray(items) || !items.length || !items.every(item => record(item)
    && typeof item.title === 'string'
    && ['body', 'snippet', 'description'].some(key => typeof item[key] === 'string')
    && ['url', 'href', 'link'].some(key => httpUrl(item[key])))) return whole('native_observation')
  const scope = Object.fromEntries(Object.entries(observation.arguments)
    .filter(([key]) => !['query', 'q', 'top_k', 'limit', 'offset', 'max_results', 'num_results'].includes(key)))
  const result: EvidenceUnit[] = items.map(item => ({ source: { tool: observation.tool, search_scope: scope,
    document_url: [item.url, item.href, item.link].find(httpUrl), ...environment },
  location: 'record', value: item, kind: 'search_record' }))
  if (record(value)) {
    const extra = Object.fromEntries(Object.entries(value).filter(([key, item]) => key !== 'results'
      && !(key === 'count' && item === items.length)))
    if (Object.keys(extra).length) result.push({ source, location: 'metadata', value: extra, kind: 'collection_metadata' })
  }
  // Native presentation metadata has meaning even when the search records overlap.
  if (observation.meta !== undefined) result.push({ source, location: 'meta', value: observation.meta, kind: 'collection_metadata' })
  return result
}

function equalityValue(unit: EvidenceUnit, observation: Observation): unknown {
  if (!observation.environment) return unit.value
  if (['native_observation', 'error_observation'].includes(unit.kind) && record(unit.value) && record(unit.value.meta)) {
    // The native adapter wraps execution origin separately from nativeMeta and
    // value/error. Origin changes per copy; it remains in the stored unit.
    const { execution: _execution, ...nativeMeta } = unit.value.meta
    return { ...unit.value, meta: nativeMeta }
  }
  if (unit.kind === 'collection_metadata' && unit.location === 'meta' && record(unit.value)) {
    const { execution: _execution, ...nativeMeta } = unit.value
    return nativeMeta
  }
  return unit.value
}

type Order = 'same' | 'older' | 'newer' | 'overlap'
function order(left: Observation, right: Observation): Order {
  if (left.id === right.id) return 'same'
  if (left.sourceVersion !== undefined && right.sourceVersion !== undefined) {
    if (typeof left.sourceVersion === 'number' && typeof right.sourceVersion === 'number')
      return left.sourceVersion === right.sourceVersion ? 'overlap' : left.sourceVersion < right.sourceVersion ? 'older' : 'newer'
    // Opaque version strings establish identity, never ordering.
    return 'overlap'
  }
  const leftStart = left.environment?.snapshotStartedAt ?? left.start
  const leftEnd = left.environment?.snapshotFinishedAt ?? left.end
  const rightStart = right.environment?.snapshotStartedAt ?? right.start
  const rightEnd = right.environment?.snapshotFinishedAt ?? right.end
  if (leftEnd < rightStart) return 'older'
  if (leftStart > rightEnd) return 'newer'
  return 'overlap'
}

/** Session-owned source ledger; no model-written verification or semantic equivalence. */
export class EvidenceLedger {
  private readonly processed = new Set<string>()
  private readonly frontier = new Map<string, { observation: Observation, unit: EvidenceUnit }[]>()

  /** Compare complete records while retaining the unmodified native observation.
   * @param input - an authoritative or independent acquisition result.
   * @returns Only novel complete units, with duplicate, stale and conflict decisions.
   */
  ingest(input: Observation): NovelEvidence {
    const observation = structuredClone(input)
    const units: EvidenceUnit[] = [], decisions: EvidenceDecision[] = []
    if (this.processed.has(observation.id)) return { observation, units, decisions }
    if (!observation.isError) this.frontier.delete(address({ source: {
      ...(observation.source ?? { tool: observation.tool, arguments: observation.arguments }),
      ...(observation.environment ? { execution_environment: observation.environment.kind } : {}) },
    location: '/', value: null, kind: 'error_observation' }))
    for (const unit of unitsFor(observation)) {
      const key = address(unit)
      const comparisons = (this.frontier.get(key) ?? []).map(item => ({ ...item, order: order(observation, item.observation) }))
      const newer = comparisons.filter(item => item.order === 'older')
      if (newer.length) {
        decisions.push({ reason: 'older_than_known_observation', source: unit.source, location: unit.location,
          knownFrom: newer.map(item => item.observation.id), concurrentConflicts: [] })
        continue
      }
      const fingerprint = digest(equalityValue(unit, observation))
      const identical = comparisons.filter(item => digest(equalityValue(item.unit, item.observation)) === fingerprint)
      const conflicts = comparisons.filter(item => item.order === 'overlap' && digest(equalityValue(item.unit, item.observation)) !== fingerprint)
      decisions.push({ reason: identical.length ? 'known_complete_unit' : 'novel_complete_unit',
        source: unit.source, location: unit.location, knownFrom: identical.map(item => item.observation.id),
        concurrentConflicts: conflicts.map(item => item.observation.id) })
      if (!identical.length) units.push(unit)
      const retained = comparisons.filter(item => item.order !== 'newer' && item.order !== 'same')
        .map(({ observation: prior, unit: priorUnit }) => ({ observation: prior, unit: priorUnit }))
      // Update an identical value's interval: an older future must not displace a recent confirmation.
      retained.push({ observation, unit })
      this.frontier.set(key, retained)
    }
    this.processed.add(observation.id)
    return { observation, units, decisions }
  }

  /** Clear source knowledge when the host replaces the session. */
  reset(): void { this.processed.clear(); this.frontier.clear() }
}
