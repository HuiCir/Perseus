import { createHash } from 'node:crypto'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { canonical } from './ledger.ts'

type Scalar = string | number | boolean | null
/** Structured equality or executable head, without parsing a shell program. */
export type ActionHead = Record<string, { kind: 'value', value: Scalar } | { kind: 'array_head', value: string }>

/** Internal worker schema and disjoint runtime ownership rules. */
export interface ActionDomain {
  id: string
  tool: ToolSchema
  parameters: Record<string, unknown>
  include?: ActionHead
  exclude: ActionHead[]
  bindings: Record<string, Scalar>
  derived: boolean
}

/** Only successful native Actor invocations may teach an action head. */
export interface ObservedHead {
  tool: string
  arguments: Record<string, unknown>
  isError: boolean
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const scalar = (value: unknown): value is Scalar => value === null || typeof value === 'string' || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value))
const fields = ['method', 'operation', 'action', 'op', 'mode', 'function', 'command']
const identity = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')

function declaredValues(property: Record<string, unknown>): Scalar[] {
  if (Array.isArray(property.enum) && property.enum.every(scalar)) return property.enum
  if (Object.hasOwn(property, 'const') && scalar(property.const)) return [property.const]
  return []
}

function matches(head: ActionHead, args: Record<string, unknown>): boolean {
  return Object.entries(head).every(([key, condition]) => condition.kind === 'value'
    ? Object.hasOwn(args, key) && canonical(args[key]) === canonical(condition.value)
    : Array.isArray(args[key]) && args[key][0] === condition.value)
}

function project(schema: Record<string, unknown>, head: ActionHead): Record<string, unknown> {
  const result = structuredClone(schema)
  // DSH validates a JSON Schema subset without allOf/not/tuple items. The
  // runtime owns exclusions; scalar heads can also narrow its native schema.
  if (result.type !== 'object' || !record(result.properties)) return result
  const properties = { ...result.properties }
  const required = Array.isArray(result.required) ? [...result.required] : []
  for (const [key, condition] of Object.entries(head)) {
    if (condition.kind !== 'value' || !record(properties[key])) continue
    // oneOf cannot have a const sibling in DSH's enforced subset. Its native
    // alternatives remain intact; deterministic ownership still fixes the head.
    if (Array.isArray(properties[key].oneOf)) continue
    properties[key] = { ...properties[key], const: condition.value }
    if (!required.includes(key)) required.push(key)
  }
  return { ...result, properties, required }
}

/** Derive disjoint internal variants; the Actor's registered schema stays intact.
 * @param tools - native schemas visible to the Actor request.
 * @param observations - successful native invocation heads from this session.
 * @returns One worker domain per declared or observed action, plus a residual when needed.
 */
export function deriveDomains(tools: readonly ToolSchema[], observations: readonly ObservedHead[] = []): ActionDomain[] {
  return tools.flatMap(tool => {
    const schema = tool.parameters
    const properties = record(schema.properties) ? schema.properties : {}
    const heads = new Map<string, ActionHead>()
    const add = (head: ActionHead): void => { if (Object.keys(head).length) heads.set(canonical(head), head) }
    let exhaustive = false
    for (const key of fields) {
      const property = properties[key]
      if (!record(property)) continue
      const values = declaredValues(property)
      for (const value of values) add({ [key]: { kind: 'value', value } })
      if (values.length && Array.isArray(schema.required) && schema.required.includes(key)) exhaustive = true
    }
    for (const branch of Array.isArray(schema.oneOf) ? schema.oneOf : []) {
      if (!record(branch) || !record(branch.properties)) continue
      const head: ActionHead = {}
      for (const key of fields) {
        const property = branch.properties[key]
        if (record(property) && Object.hasOwn(property, 'const') && scalar(property.const)) head[key] = { kind: 'value', value: property.const }
      }
      add(head)
    }
    for (const observation of observations) {
      if (observation.tool !== tool.name || observation.isError) continue
      const head: ActionHead = {}
      for (const key of fields) {
        const property = properties[key], value = observation.arguments[key]
        if (!record(property) || !scalar(value)) continue
        if (key === 'command' && !declaredValues(property).length) continue
        head[key] = { kind: 'value', value }
      }
      add(head)
      if (Object.keys(head).length) for (const key of ['url', 'endpoint', 'route']) {
        const property = properties[key], value = observation.arguments[key]
        if (record(property) && property.type === 'string' && typeof value === 'string') add({ ...head, [key]: { kind: 'value', value } })
      }
      for (const key of ['argv', 'command']) {
        const property = properties[key], value = observation.arguments[key]
        if (record(property) && property.type === 'array' && Array.isArray(value) && typeof value[0] === 'string')
          add({ [key]: { kind: 'array_head', value: value[0] } })
      }
    }
    if (!heads.size) return [{ id: `${tool.name}:native`, tool, parameters: structuredClone(schema), exclude: [], bindings: {}, derived: false }]
    const ordered = [...heads.values()].sort((left, right) => Object.keys(right).length - Object.keys(left).length
      || canonical(left).localeCompare(canonical(right)))
    const excluded: ActionHead[] = [], domains: ActionDomain[] = []
    for (const head of ordered) {
      const bindings: Record<string, Scalar> = {}
      for (const [key, condition] of Object.entries(head)) if (condition.kind === 'value') bindings[key] = condition.value
      domains.push({ id: `${tool.name}:${identity(head)}`, tool, parameters: project(schema, head), include: head,
        exclude: structuredClone(excluded), bindings, derived: true })
      excluded.push(head)
    }
    if (!exhaustive) domains.push({ id: `${tool.name}:residual`, tool, parameters: structuredClone(schema),
      exclude: structuredClone(excluded), bindings: {}, derived: true })
    return domains
  })
}

/** Test a validated native invocation against exactly one domain's ownership.
 * @param domain - internal acquisition variant.
 * @param args - arguments already validated against the original native schema.
 * @returns Whether the invocation belongs to this variant.
 */
export function ownsDomain(domain: ActionDomain, args: Record<string, unknown>): boolean {
  return (!domain.include || matches(domain.include, args)) && !domain.exclude.some(head => matches(head, args))
}

/** Supply omitted fixed discriminators without replacing an explicit action.
 * @param domain - internal worker variant.
 * @param raw - model-produced JSON arguments.
 * @returns A new argument object, ready for native schema validation.
 */
export function bindActionHead(domain: ActionDomain, raw: Record<string, unknown>): Record<string, unknown> {
  const args = structuredClone(raw)
  for (const [key, value] of Object.entries(domain.bindings)) if (!Object.hasOwn(args, key)) args[key] = value
  return args
}
