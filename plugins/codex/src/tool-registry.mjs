import { deriveActionDomains, bindActionHead, findActionDomain, validateActionArguments } from './action-domains.mjs';
import { validateJsonSchema } from './schema-validation.mjs';
import { canonicalJSON, DOMAINS } from './cache.mjs';

export const COMMAND_TOOL = Object.freeze({ name: 'command_exec',
  description: 'Execute structured command argv in an independent disposable workspace copy. Run local tests, inspections or computations; return full stdout, stderr and an isolation receipt. No network or merges into the Actor workspace. Session/group detachment and posix_spawn are denied; Node tests must use --test-isolation=none. Fork/exec subprocesses retain the managed process group.',
  parameters: { type: 'object', properties: {
    command: { type: 'array', items: { type: 'string' }, minItems: 1 },
    cwd: { type: 'string', minLength: 1 },
  }, required: ['command'], additionalProperties: false } });

export const BUILTIN_TOOLS = Object.freeze([
  { name: 'read', legacy: true, parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false } },
  ...['grep', 'glob'].map(name => ({ name, legacy: true, parameters: { type: 'object', properties: {
    pattern: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 },
  }, required: ['pattern', 'path'], additionalProperties: false } })),
  COMMAND_TOOL,
]);

/** Explicit executable contracts. Public hooks do not expose all Actor tool schemas. */
export class ToolRegistry {
  constructor({ tools = BUILTIN_TOOLS, validate = validateJsonSchema, canExecute = () => true } = {}) {
    this.validate = validate;
    this.tools = new Map();
    for (const raw of tools) {
      const tool = structuredClone(raw);
      if (!tool.name || this.tools.has(tool.name)) throw new TypeError('Tool contracts require unique names');
      // Compile even when {} is not a valid instance: unsupported schemas must fail at registration.
      validate(tool.parameters, {});
      if (canExecute(tool.name)) this.tools.set(tool.name, tool);
    }
    this.frontier = [];
  }
  derive(facts) {
    const native = facts.map(fact => {
      const name = fact.tool === 'mcp__perseus__command_exec' ? 'command_exec' : fact.tool;
      return name === fact.tool ? fact : { ...fact, tool: name };
    });
    this.frontier = [...this.tools.values()].flatMap(tool => {
      const domains = deriveActionDomains(tool, native, { validate: this.validate });
      return domains.map(domain => tool.legacy && DOMAINS.includes(tool.name)
        ? { ...domain, id: tool.name, legacy: true, cacheIdentity: `legacy:${tool.name}:1` }
        : { ...domain, description: tool.description });
    });
    return structuredClone(this.frontier);
  }
  prepare(snapshot, action) {
    if (!action || action.tool !== snapshot.toolName || !action.arguments || typeof action.arguments !== 'object' || Array.isArray(action.arguments))
      throw new TypeError('A completed action must belong to its registered native tool');
    const tool = this.tools.get(snapshot.toolName);
    if (!tool) throw new TypeError('No isolated executor is registered for this tool');
    const args = bindActionHead(snapshot, action.arguments);
    if (!this.validate(snapshot.generationParameters, args)) throw new TypeError('Worker arguments escaped its generation schema');
    validateActionArguments(tool, args, { validate: this.validate });
    // Workers retain immutable generation snapshots. Current partition decides ownership.
    const owner = findActionDomain(this.frontier.filter(domain => domain.toolName === tool.name), args, { validate: this.validate });
    return { action: { tool: tool.name, arguments: args }, ownerId: owner.id, sourceDomainId: snapshot.id };
  }
}

export function domainId(domain) { return typeof domain === 'string' ? domain : domain.id; }
export function domainCacheKey(domain) {
  return typeof domain === 'string' || domain.legacy ? domainId(domain) : canonicalJSON([domain.id, domain.cacheIdentity]);
}
