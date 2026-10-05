import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, access, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { disableInheritedMcp, disableThreadMcp, mcpDisableOverrides, HostPolicyError } from '../src/host-policy.mjs'
import { DEFAULT_CODEX_PATH, RpcClient } from '../src/rpc.mjs'

const execute = promisify(execFile)

test('MCP policy keeps only literal names and never retains native transport/auth data', () => {
  const policy = mcpDisableOverrides(JSON.stringify([
    { name: 'simple', enabled: true, transport: { env: { PRIVATE_KEY: 'fixture-secret' } }, auth_status: 'logged-in' },
    { name: 'period.name', enabled: true, transport: { url: 'https://example.test/private' } },
    { name: 'quote"name', enabled: false }, { name: '__proto__' }, { name: 'period.name' },
  ]))
  assert.equal(Object.getPrototypeOf(policy.mcp_servers), Object.prototype)
  assert.deepEqual(Object.keys(policy.mcp_servers), ['__proto__', 'period.name', 'quote"name', 'simple'])
  assert.ok(Object.values(policy.mcp_servers).every(value => Object.keys(value).length === 1 && value.enabled === false))
  assert.ok(!JSON.stringify(policy).includes('fixture-secret'))
  assert.deepEqual(mcpDisableOverrides('[]'), {})
})

test('inventory uses the same private cwd/profile/config and hides every native failure payload', async () => {
  let request
  const policy = await disableInheritedMcp({ cwd: '/private/inference', codexBin: '/native/codex', profile: 'worker',
    configOverrides: { 'features.plugins': false }, run: async input => {
      request = input
      return { stdout: '[{"name":"literal.with.dot","transport":{"env":{"SECRET":"fixture-secret"}}}]', stderr: 'private native diagnostic' }
    } })
  assert.equal(request.options.cwd, '/private/inference')
  assert.deepEqual(request.args, ['--profile', 'worker', '-c', 'features.plugins=false', 'mcp', 'list', '--json'])
  assert.deepEqual(policy, { mcp_servers: { 'literal.with.dot': { enabled: false } } })
  await assert.rejects(disableInheritedMcp({ cwd: '/private', codexBin: '/native', run: async () => {
    throw Object.assign(new Error('fixture-secret'), { stdout: 'fixture-secret', stderr: 'fixture-secret' })
  } }), error => error instanceof HostPolicyError && error.code === 'MCP_INVENTORY_UNAVAILABLE' && !error.message.includes('fixture-secret'))
  assert.throws(() => mcpDisableOverrides('{"fixture-secret":true}'), error => error.code === 'INVALID_MCP_INVENTORY' && !error.message.includes('fixture-secret'))
})

test('thread inventory is cwd-aware and retains only names for an atomic thread config overlay', async () => {
  let requested
  const secret = { command: 'private-command', env: { SECRET: 'fixture-secret' } }
  const client = { request: async (...args) => { requested = args; return { config: { mcp_servers: { 'project.with.dot': secret }, other: 'fixture-secret' } } } }
  const abort = new AbortController()
  const policy = await disableThreadMcp(client, { cwd: '/private/thread', signal: abort.signal })
  assert.deepEqual(requested, ['config/read', { cwd: '/private/thread', includeLayers: false }, { signal: abort.signal }])
  assert.deepEqual(policy, { mcp_servers: { 'project.with.dot': { enabled: false } } })
  assert.equal(JSON.stringify(policy).includes('fixture-secret'), false)
  assert.deepEqual(await disableThreadMcp({ request: async () => ({ config: {} }) }, { cwd: '/private' }), {})
  await assert.rejects(disableThreadMcp({ request: async () => { throw new Error('fixture-secret') } }, { cwd: '/private' }),
    error => error.code === 'MCP_INVENTORY_UNAVAILABLE' && !error.message.includes('fixture-secret'))
  await assert.rejects(disableThreadMcp({ request: async () => ({ config: { mcp_servers: [] } }) }, { cwd: '/private' }), { code: 'INVALID_MCP_INVENTORY' })
})

test('installed CLI disables every CLI-visible global/profile table including dotted literal names', async context => {
  try { await access(DEFAULT_CODEX_PATH) } catch { context.skip('Bundled Codex CLI unavailable'); return }
  const fixture = await mkdtemp(join(tmpdir(), 'perseus-host-policy-'))
  const taskHome = join(fixture, 'native-config'), room = join(fixture, 'inference')
  try {
    await mkdir(taskHome)
    await mkdir(join(room, '.git'), { recursive: true })
    await mkdir(join(room, '.codex'))
    await writeFile(join(taskHome, 'config.toml'), `[projects.${JSON.stringify(room)}]\ntrust_level = "trusted"\n[mcp_servers."global.with.dot"]\ncommand = "/usr/bin/true"\n[mcp_servers.global_two]\ncommand = "/usr/bin/true"\n`)
    await writeFile(join(taskHome, 'worker.config.toml'), '[mcp_servers.profile_server]\ncommand = "/usr/bin/true"\n')
    await writeFile(join(room, '.codex', 'config.toml'), '[mcp_servers.project_server]\ncommand = "/usr/bin/true"\n')
    const env = { ...process.env, CODEX_HOME: taskHome }
    const policy = await disableInheritedMcp({ cwd: room, codexBin: DEFAULT_CODEX_PATH, env, profile: 'worker' })
    // This installed CLI omits project servers. Thread policy uses config/read.
    assert.deepEqual(Object.keys(policy.mcp_servers).sort(), ['global.with.dot', 'global_two', 'profile_server'])
    const table = `{ ${Object.entries(policy.mcp_servers).map(([name]) => `${JSON.stringify(name)} = { enabled = false }`).join(', ')} }`
    let stdout, native
    try {
      ({ stdout } = await execute(DEFAULT_CODEX_PATH, ['--profile', 'worker', '-c', `mcp_servers=${table}`, 'mcp', 'list', '--json'],
        { cwd: room, env, timeout: 10000, maxBuffer: 16 * 1024 * 1024 }))
      native = JSON.parse(stdout)
      assert.equal(native.length, 3)
      assert.ok(native.every(server => server.enabled === false))
      // Empty overlay is deliberately not used: native recursive table merge retains servers.
      const empty = await execute(DEFAULT_CODEX_PATH, ['--profile', 'worker', '-c', 'mcp_servers={}', 'mcp', 'list', '--json'],
        { cwd: room, env, timeout: 10000, maxBuffer: 16 * 1024 * 1024 })
      assert.ok(JSON.parse(empty.stdout).some(server => server.enabled === true))
    } finally { stdout = undefined; native = undefined }
  } finally { await rm(fixture, { recursive: true, force: true }) }
})

test('installed stable config/read finds project-only MCP and thread/start overlay prevents its startup', { timeout: 30000 }, async context => {
  try { await access(DEFAULT_CODEX_PATH) } catch { context.skip('Bundled Codex CLI unavailable'); return }
  const fixture = await mkdtemp(join(tmpdir(), 'perseus-thread-policy-'))
  const taskHome = join(fixture, 'native-config'), room = join(fixture, 'inference'), marker = join(fixture, 'mcp-started')
  let client
  try {
    await mkdir(taskHome)
    await mkdir(join(room, '.git'), { recursive: true })
    await mkdir(join(room, '.codex'))
    const trust = `[projects.${JSON.stringify(room)}]\ntrust_level = "trusted"\n`
    await writeFile(join(taskHome, 'config.toml'), trust + '[mcp_servers.global_server]\ncommand = "/usr/bin/true"\n')
    const program = join(fixture, 'fixture-mcp.cjs')
    await writeFile(program, `require('node:fs').writeFileSync(process.argv[2], 'started');\nconst rl=require('node:readline').createInterface({input:process.stdin});\nrl.on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result={};if(r.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};if(r.method==='tools/list')result={tools:[]};if(r.method==='resources/list')result={resources:[]};if(r.method==='resources/templates/list')result={resourceTemplates:[]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')});\n`)
    await writeFile(join(room, '.codex', 'config.toml'), `[mcp_servers."project.with.dot"]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(program)}, ${JSON.stringify(marker)}]\n`)
    const env = { ...process.env, CODEX_HOME: taskHome }
    const globalPolicy = await disableInheritedMcp({ cwd: room, codexBin: DEFAULT_CODEX_PATH, env })
    client = await RpcClient.create({ codexBin: DEFAULT_CODEX_PATH, cwd: room, env, maxStderrChars: 0,
      configOverrides: { ...globalPolicy, 'features.plugins': false, 'features.apps': false } })
    const threadPolicy = await disableThreadMcp(client, { cwd: room })
    assert.deepEqual(Object.keys(threadPolicy.mcp_servers).sort(), ['global_server', 'project.with.dot'])
    const disabled = await client.request('thread/start', { cwd: room, model: 'gpt-6-sol', ephemeral: true, approvalPolicy: 'never',
      sandbox: 'read-only', config: threadPolicy })
    await client.request('mcpServerStatus/list', { threadId: disabled.thread.id })
    await assert.rejects(access(marker), { code: 'ENOENT' })
    // Positive control: the same harmless fixture starts when its thread overlay is omitted.
    const enabled = await client.request('thread/start', { cwd: room, model: 'gpt-6-sol', ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' })
    await client.request('mcpServerStatus/list', { threadId: enabled.thread.id })
    assert.equal(await readFile(marker, 'utf8'), 'started')
  } finally {
    if (client) await client.close()
    await rm(fixture, { recursive: true, force: true })
  }
})

test('installed experimental thread environments can explicitly disable environment access without a model call', { timeout: 30000 }, async context => {
  try { await access(DEFAULT_CODEX_PATH) } catch { context.skip('Bundled Codex CLI unavailable'); return }
  const fixture = await mkdtemp(join(tmpdir(), 'perseus-no-environment-'))
  const taskHome = join(fixture, 'native-config'), room = join(fixture, 'inference')
  let stable, experimental
  try {
    await mkdir(taskHome)
    await mkdir(room)
    await writeFile(join(taskHome, 'config.toml'), '')
    const options = { codexBin: DEFAULT_CODEX_PATH, cwd: room, env: { ...process.env, CODEX_HOME: taskHome }, maxStderrChars: 0,
      configOverrides: { 'features.plugins': false, 'features.apps': false, 'features.hooks': false } }
    const parameters = { cwd: room, model: 'gpt-6-sol', ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', environments: [] }
    stable = await RpcClient.create(options)
    await assert.rejects(stable.request('thread/start', parameters))
    await stable.close(); stable = undefined
    experimental = await RpcClient.create({ ...options, experimentalApi: true })
    const result = await experimental.request('thread/start', parameters)
    assert.deepEqual(result.thread.environments, [])
    const read = await experimental.request('thread/read', { threadId: result.thread.id, includeTurns: false })
    assert.deepEqual(read.thread.environments, [])
    // No turn/start: the selected empty environment is confirmed by the native
    // response. Native tool-registry construction is source-audited separately.
  } finally {
    if (stable) await stable.close()
    if (experimental) await experimental.close()
    await rm(fixture, { recursive: true, force: true })
  }
})
