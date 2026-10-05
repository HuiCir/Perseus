import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { discoverCodex } from './rpc.mjs'

const execute = promisify(execFile)

export class HostPolicyError extends Error {
  constructor(code) { super('Private inference host MCP policy could not be confirmed'); this.name = 'HostPolicyError'; this.code = code }
}

function toml(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return String(value)
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`
  if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}`).join(', ')} }`
  throw new HostPolicyError('INVALID_POLICY_CONFIG')
}

function disableNames(names) {
  if (!names.every(name => typeof name === 'string' && name && !name.includes('\0'))) throw new HostPolicyError('INVALID_MCP_INVENTORY')
  const unique = [...new Set(names)].sort()
  return unique.length ? { mcp_servers: Object.fromEntries(unique.map(name => [name, { enabled: false }])) } : {}
}

/** Inventory data can contain secrets. Retain literal names only, never server values. */
export function mcpDisableOverrides(raw) {
  let inventory
  try {
    inventory = JSON.parse(raw)
    if (!Array.isArray(inventory)) throw new Error('Invalid inventory')
    const names = []
    for (const entry of inventory) {
      if (!entry || typeof entry.name !== 'string' || !entry.name || entry.name.includes('\0')) throw new Error('Invalid server name')
      names.push(entry.name)
    }
    // Dotted override paths cannot quote individual literal segments. A root
    // inline TOML table preserves server names containing periods or quotes.
    return disableNames(names)
  } catch {
    throw new HostPolicyError('INVALID_MCP_INVENTORY')
  } finally {
    inventory = undefined
  }
}

/** Disable CLI-visible global/profile servers before the owned host starts.
 * This is not a complete project inventory: disableThreadMcp must additionally
 * run for each thread cwd before thread/start, whose config applies atomically.
 * The CLI lists configuration without starting a model or invoking an MCP tool.
 * Raw stdout/stderr are never logged, persisted, or included in thrown errors.
 */
export async function disableInheritedMcp({ cwd, codexBin, env = process.env, profile, configOverrides = {}, run,
  timeoutMs = 10000 } = {}) {
  if (typeof cwd !== 'string' || !cwd || !Number.isInteger(timeoutMs) || timeoutMs < 1
    || (profile !== undefined && (typeof profile !== 'string' || !profile))) throw new HostPolicyError('INVALID_HOST_POLICY_OPTIONS')
  let output, raw
  try {
    const executable = codexBin ?? (await discoverCodex({ env })).executable
    const args = [
      ...(profile ? ['--profile', profile] : []),
      ...Object.entries(configOverrides).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]),
      'mcp', 'list', '--json',
    ]
    output = await (run ?? ((request) => execute(request.executable, request.args, request.options)))({ executable, args,
      options: { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', windowsHide: true } })
    raw = output?.stdout
    if (typeof raw !== 'string') throw new HostPolicyError('INVALID_MCP_INVENTORY')
    return mcpDisableOverrides(raw)
  } catch (error) {
    if (error instanceof HostPolicyError) throw error
    throw new HostPolicyError('MCP_INVENTORY_UNAVAILABLE')
  } finally {
    raw = undefined
    output = undefined
  }
}

/** Native config/read is cwd-aware; unlike mcp list it includes project layers.
 * Return only an overlay for thread/start.config. Never mutate user settings,
 * persist native configuration, or return its transport/credential values.
 */
export async function disableThreadMcp(client, { cwd, signal } = {}) {
  if (!client || typeof client.request !== 'function' || typeof cwd !== 'string' || !cwd) throw new HostPolicyError('INVALID_HOST_POLICY_OPTIONS')
  let response, servers
  try {
    response = await client.request('config/read', { cwd, includeLayers: false }, { signal })
    if (!response?.config || typeof response.config !== 'object' || Array.isArray(response.config)) throw new HostPolicyError('INVALID_MCP_INVENTORY')
    servers = response.config.mcp_servers
    if (servers === undefined) return {}
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new HostPolicyError('INVALID_MCP_INVENTORY')
    return disableNames(Object.keys(servers))
  } catch (error) {
    if (error instanceof HostPolicyError) throw error
    throw new HostPolicyError(signal?.aborted ? 'MCP_INVENTORY_CANCELLED' : 'MCP_INVENTORY_UNAVAILABLE')
  } finally {
    servers = undefined
    response = undefined
  }
}
