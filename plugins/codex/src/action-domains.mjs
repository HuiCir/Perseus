import { createHash } from 'node:crypto'
import { canonicalJSON } from './cache.mjs'

const copy = value => structuredClone(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const scalar = value => value === null || typeof value === 'string' || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value))
const fields = ['method', 'operation', 'action', 'op', 'mode', 'function', 'command']
const hash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex')
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0

export class ActionDomainError extends Error {
  constructor(code, message) { super(message); this.name = 'ActionDomainError'; this.code = code }
}

function schemaOf(tool) {
  if (!object(tool) || typeof tool.name !== 'string' || !tool.name
    || (!object(tool.parameters) && typeof tool.parameters !== 'boolean'))
    throw new ActionDomainError('INVALID_TOOL_SCHEMA', 'A named native tool and its complete JSON Schema are required')
  canonicalJSON(tool.parameters)
  return tool.parameters
}

function localReference(schema, root) {
  if (!object(schema) || typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) return undefined
  let current = root
  for (const token of schema.$ref.slice(2).split('/').map(value => value.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!object(current) || !Object.hasOwn(current, token)) return undefined
    current = current[token]
  }
  return object(current) ? current : undefined
}

function propertySchemas(schema, root, seen = new Set()) {
  const properties = new Map()
  const required = new Set()
  function visit(part) {
    if (!object(part) || seen.has(part)) return
    seen.add(part)
    for (const [key, value] of Object.entries(part.properties ?? {})) {
      if (object(value)) properties.set(key, [...(properties.get(key) ?? []), value])
    }
    for (const key of Array.isArray(part.required) ? part.required : []) if (typeof key === 'string') required.add(key)
    const reference = localReference(part, root)
    if (reference) visit(reference)
    for (const child of Array.isArray(part.allOf) ? part.allOf : []) visit(child)
  }
  visit(schema)
  return { properties, required }
}

function declaredValues(schema, root, seen = new Set()) {
  if (!object(schema) || seen.has(schema)) return []
  seen.add(schema)
  const values = []
  if (Array.isArray(schema.enum) && schema.enum.every(scalar)) values.push(...schema.enum)
  if (Object.hasOwn(schema, 'const') && scalar(schema.const)) values.push(schema.const)
  const branches = schema.oneOf ?? schema.anyOf
  if (Array.isArray(branches) && branches.length && branches.every(branch => object(branch) && Object.hasOwn(branch, 'const') && scalar(branch.const)))
    values.push(...branches.map(branch => branch.const))
  const reference = localReference(schema, root)
  if (reference) values.push(...declaredValues(reference, root, seen))
  for (const child of Array.isArray(schema.allOf) ? schema.allOf : []) values.push(...declaredValues(child, root, seen))
  return [...new Map(values.map(value => [canonicalJSON(value), value])).values()]
}

function hasArraySchema(parts, root) {
  return parts.some(part => part.type === 'array' || (Array.isArray(part.type) && part.type.includes('array'))
    || localReference(part, root)?.type === 'array')
}

/** Only host-admitted native observations teach heads. Explicit SE/error records never do. */
function observationOf(fact, toolName) {
  if (!object(fact) || fact.kind !== 'tool_observation' || fact.tool !== toolName || fact.authoritative === false
    || fact.speculative === true || fact.perseusEvidence || fact.origin === 'speculative' || fact.source === 'speculative'
    || (object(fact.receipt) && fact.receipt.merged === false && fact.receipt.independentRoot)
    || fact.isError === true || fact.is_error === true || fact.success === false) return undefined
  const args = Object.hasOwn(fact, 'arguments') ? fact.arguments : Object.hasOwn(fact, 'args') ? fact.args : fact.tool_input
  const result = Object.hasOwn(fact, 'result') ? fact.result : fact.tool_response
  if (!object(args) || (!Object.hasOwn(fact, 'result') && !Object.hasOwn(fact, 'tool_response'))) return undefined
  if (object(result) && (result.isError === true || result.is_error === true || result.error
    || result.status === 'failed' || result.status === 'error'
    || (typeof result.exitCode === 'number' && result.exitCode !== 0)
    || (typeof result.exit_code === 'number' && result.exit_code !== 0))) return undefined
  return args
}

function equality(values) {
  return { type: 'object', properties: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { const: copy(value) }])),
    required: Object.keys(values) }
}

function arrayHead(key, value, modern) {
  return { type: 'object', properties: { [key]: modern
    ? { type: 'array', minItems: 1, prefixItems: [{ const: value }], items: true }
    : { type: 'array', minItems: 1, items: [{ const: value }], additionalItems: true } }, required: [key] }
}

function constrained(original, predicate) {
  // Keep references, IDs, definitions, and every native constraint at its
  // original root. Nesting the original under allOf would break local $refs.
  if (original === true) return copy(predicate)
  if (original === false) return false
  return { ...copy(original), allOf: [...copy(original.allOf ?? []), copy(predicate)] }
}

function predicateMatches(predicate, args) {
  return Object.entries(predicate.properties ?? {}).every(([key, condition]) => {
    if (!Object.hasOwn(args, key)) return false
    if (Object.hasOwn(condition, 'const')) return canonicalJSON(args[key]) === canonicalJSON(condition.const)
    const first = condition.prefixItems?.[0] ?? (Array.isArray(condition.items) ? condition.items[0] : undefined)
    return !!first && Array.isArray(args[key]) && args[key].length > 0 && canonicalJSON(args[key][0]) === canonicalJSON(first.const)
  })
}

/** Partition a native tool, without editing Actor tools or parsing opaque shell text.
 * `parameters` is the current disjoint runtime schema. `generationParameters`
 * retains the stable positive schema; exclusions remain in runtime ownership.
 * Facts must be the host's native tool_observation records, never SE evidence.
 * `validate` is a full strict JSON Schema implementation supplied by the host.
 */
export function deriveActionDomains(tool, facts = [], options = {}) {
  const original = schemaOf(tool)
  if (!Array.isArray(facts)) throw new ActionDomainError('INVALID_OBSERVATIONS', 'Native facts must be an array')
  if (options.validate) runValidation(options.validate, original, {}) // Compile/check the complete schema; {} may validly fail.
  const { properties, required } = propertySchemas(original, original)
  const candidates = new Map()
  let exhaustive = false
  const add = (predicate, specificity) => candidates.set(canonicalJSON(predicate), { predicate, specificity })
  for (const key of fields) {
    const parts = properties.get(key) ?? []
    const values = [...new Map(parts.flatMap(part => declaredValues(part, original)).map(value => [canonicalJSON(value), value])).values()]
    for (const value of values) add(equality({ [key]: value }), 1)
    // A required, finite discriminator in a conjunctive property constraint
    // covers every valid native invocation. Optional heads keep a complement.
    if (values.length && required.has(key)) exhaustive = true
  }
  for (const branch of object(original) ? [...(original.oneOf ?? []), ...(original.anyOf ?? [])] : []) {
    const branchProperties = propertySchemas(branch, original).properties
    const values = {}
    for (const key of fields) for (const part of branchProperties.get(key) ?? []) {
      if (Object.hasOwn(part, 'const') && scalar(part.const)) values[key] = part.const
    }
    if (Object.keys(values).length) add(equality(values), Object.keys(values).length)
  }
  const modern = object(original) && /2020-12/.test(original.$schema ?? options.defaultDraft ?? '')
  for (const fact of facts) {
    const args = observationOf(fact, tool.name)
    if (!args) continue
    if (options.validate && !runValidation(options.validate, original, copy(args))) continue
    const values = {}
    for (const key of fields) {
      const parts = properties.get(key) ?? []
      if (!parts.length || !Object.hasOwn(args, key) || !scalar(args[key])) continue
      if (key === 'command' && !parts.some(part => declaredValues(part, original).length)) continue
      values[key] = args[key]
    }
    if (Object.keys(values).length) {
      add(equality(values), Object.keys(values).length)
      for (const key of ['url', 'endpoint', 'route']) if (properties.has(key) && typeof args[key] === 'string')
        add(equality({ ...values, [key]: args[key] }), Object.keys(values).length + 1)
    }
    for (const key of ['argv', 'command']) if (hasArraySchema(properties.get(key) ?? [], original)
      && Array.isArray(args[key]) && typeof args[key][0] === 'string') add(arrayHead(key, args[key][0], modern), 1)
  }
  const schemaIdentity = hash(original)
  if (!candidates.size) return [{ id: `${tool.name}:native`, toolName: tool.name, parameters: copy(original),
    generationParameters: copy(original), originalParameters: copy(original), bindings: {}, derived: false,
    predicate: undefined, exclude: [], predicateIdentity: 'native', schemaIdentity,
    cacheIdentity: hash([tool.name, original, 'native']) }]
  const ordered = [...candidates.values()].sort((a, b) => b.specificity - a.specificity
    || compare(canonicalJSON(a.predicate), canonicalJSON(b.predicate)))
  const excluded = [], domains = []
  for (const { predicate } of ordered) {
    const predicateIdentity = hash(predicate)
    const constraint = excluded.length ? { allOf: [copy(predicate), { not: { anyOf: copy(excluded) } }] } : predicate
    const bindings = Object.fromEntries(Object.entries(predicate.properties).filter(([, part]) => Object.hasOwn(part, 'const'))
      .map(([key, part]) => [key, copy(part.const)]))
    domains.push({ id: `${tool.name}:${predicateIdentity}`, toolName: tool.name,
      parameters: constrained(original, constraint), generationParameters: constrained(original, predicate),
      originalParameters: copy(original), bindings, derived: true, predicate: copy(predicate), exclude: copy(excluded),
      predicateIdentity, schemaIdentity, cacheIdentity: hash([tool.name, original, predicate]) })
    excluded.push(predicate)
  }
  if (!exhaustive) {
    const constraint = { not: { anyOf: copy(excluded) } }
    const parameters = constrained(original, constraint)
    domains.push({ id: `${tool.name}:complement`, toolName: tool.name, parameters,
      generationParameters: copy(parameters), originalParameters: copy(original), bindings: {}, derived: true,
      predicate: undefined, exclude: copy(excluded), predicateIdentity: 'complement', schemaIdentity,
      cacheIdentity: hash([tool.name, original, constraint]) })
  }
  return domains
}

/** Ownership is deterministic, but is not a substitute for native schema validation. */
export function ownsDomain(domain, args) {
  if (!object(args)) return false
  return (!domain.predicate || predicateMatches(domain.predicate, args))
    && !(domain.exclude ?? []).some(predicate => predicateMatches(predicate, args))
}

export function bindActionHead(domain, args) {
  if (!object(args)) throw new ActionDomainError('INVALID_ARGUMENTS', 'Native arguments must be an object')
  const bound = copy(args)
  for (const [key, value] of Object.entries(domain.bindings ?? {})) if (!Object.hasOwn(bound, key)) bound[key] = copy(value)
  return bound
}

function runValidation(validate, schema, args) {
  if (typeof validate !== 'function') throw new ActionDomainError('VALIDATOR_UNAVAILABLE', 'A complete JSON Schema validator is required')
  const before = canonicalJSON(args)
  let valid
  try { valid = validate(copy(schema), args) }
  catch { throw new ActionDomainError('SCHEMA_UNSUPPORTED', 'The native JSON Schema could not be fully validated') }
  if (typeof valid !== 'boolean') throw new ActionDomainError('INVALID_VALIDATOR', 'The JSON Schema validator must return a synchronous boolean')
  if (before !== canonicalJSON(args)) throw new ActionDomainError('VALIDATOR_MUTATED_ARGUMENTS', 'Native argument coercion and defaults are forbidden')
  return valid
}

export function validateActionArguments(tool, args, { validate } = {}) {
  const original = schemaOf(tool)
  if (!object(args)) throw new ActionDomainError('INVALID_ARGUMENTS', 'Native arguments must be an object')
  const prepared = copy(args)
  if (!runValidation(validate, original, prepared)) throw new ActionDomainError('INVALID_ARGUMENTS', 'Arguments do not satisfy the complete native schema')
  return prepared
}

export function validateDomainArguments(domain, args, { validate } = {}) {
  const prepared = validateActionArguments({ name: domain.toolName, parameters: domain.originalParameters }, bindActionHead(domain, args), { validate })
  if (!ownsDomain(domain, prepared) || !runValidation(validate, domain.parameters, prepared))
    throw new ActionDomainError('DOMAIN_MISMATCH', 'Arguments do not belong to the selected action domain')
  return prepared
}

/** A generation owns its snapshot. Pass that snapshot, never silently retarget it. */
export function findActionDomain(domains, args, { validate } = {}) {
  if (!Array.isArray(domains) || !domains.length) throw new ActionDomainError('MISSING_DOMAINS', 'An action-domain snapshot is required')
  const first = domains[0]
  if (domains.some(domain => domain.toolName !== first.toolName || domain.schemaIdentity !== first.schemaIdentity))
    throw new ActionDomainError('MIXED_DOMAINS', 'Domains must belong to one native tool and schema snapshot')
  const prepared = validateActionArguments({ name: first.toolName, parameters: first.originalParameters }, args, { validate })
  const owners = domains.filter(domain => ownsDomain(domain, prepared))
  if (owners.length !== 1) throw new ActionDomainError('AMBIGUOUS_DOMAIN', 'A validated invocation must have exactly one action-domain owner')
  if (!runValidation(validate, owners[0].parameters, prepared))
    throw new ActionDomainError('DOMAIN_MISMATCH', 'The complete domain schema rejected its owner')
  return owners[0]
}
