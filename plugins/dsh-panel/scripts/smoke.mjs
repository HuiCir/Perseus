/**
 * Offline smoke test: run the real apply() against stubbed webServer /
 * configEditor and assert the three surfaces behave. No DSH, no profile.
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

const listeners = new Map()
const routes = []
let stored = { enabled: true, tools: ['read', 'grep'], model: 'deepseek-flash', reasoningEffort: 'high' }
const entry = { options: { id: 'perseus' } }

const ctx = {
  logger: { warn: (e) => { throw new Error(`apply warned: ${e}`) } },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  on: (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event) },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  configEditor: {
    entries: () => [entry],
    configuration: () => [{ entry, inherited: {}, override: { ...stored } }],
    edit: async (target, change) => { if (target !== entry) throw new Error('wrong entry'); stored = change({ ...stored }, {}) }
  }
}

const failures = []
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`); if (!ok) failures.push(label) }

mod.apply(ctx)

// --- surfaces registered -----------------------------------------------------
check('registered exactly one /perseus prefix route', routes.length === 1 && routes[0].kind === 'prefix' && routes[0].path === '/perseus', JSON.stringify(routes.map((r) => [r.kind, r.path])))
check('subscribed webserver/index-inject', listeners.has('webserver/index-inject'))
check('subscribed task-flow events', ['tools/result', 'agent/status', 'agent/error', 'subagent/start', 'subagent/end', 'workflow/start', 'workflow/phase', 'settings/document-updated'].every((e) => listeners.has(e)), [...listeners.keys()].join(','))

// --- index injection ---------------------------------------------------------
const table = []
listeners.get('webserver/index-inject')(table)
const kinds = table.map((row) => row.kind).sort().join(',')
check('injected style+html+script', table.length === 3 && kinds === 'html,script,style', kinds)
check('script carries the panel mount code', typeof table.find((r) => r.kind === 'script').text === 'string' && table.find((r) => r.kind === 'script').text.includes('__perseusPanelMounted'))

// --- fake http ---------------------------------------------------------------
function fakeRes() {
  const res = { code: undefined, headers: undefined, body: '', chunks: [], handlers: {} }
  res.writeHead = (code, headers) => { res.code = code; res.headers = headers }
  res.write = (chunk) => { res.body += chunk; res.chunks.push(chunk); return true }
  res.end = (chunk) => { if (chunk !== undefined) res.body += chunk }
  res.on = (event, handler) => { res.handlers[event] = handler }
  return res
}
function fakeReq(method, url, body) {
  const handlers = {}
  const req = { method, url, on: (event, handler) => { handlers[event] = handler } }
  queueMicrotask(() => {
    if (body !== undefined) handlers.data?.(Buffer.from(body))
    handlers.end?.()
  })
  return req
}
const handler = routes[0].handler

// GET /perseus/state
let res = fakeRes()
await handler(fakeReq('GET', '/perseus/state'), res)
const state = JSON.parse(res.body)
check('GET /state → 200 + merged config', res.code === 200 && state.config?.merged?.model === 'deepseek-flash', `code=${res.code} model=${state.config?.merged?.model}`)

// POST /perseus/config
res = fakeRes()
await handler(fakeReq('POST', '/perseus/config', JSON.stringify({ model: 'deepseek-pro', tools: ['read'], reasoningEffort: 'max' })), res)
check('POST /config → 200', res.code === 200, `code=${res.code} body=${res.body.slice(0, 120)}`)
check('POST /config persisted model', stored.model === 'deepseek-pro', stored.model)
check('POST /config persisted tools', JSON.stringify(stored.tools) === '["read"]', JSON.stringify(stored.tools))
check('POST /config persisted effort', stored.reasoningEffort === 'max', stored.reasoningEffort)

// POST with undefined drops the key
res = fakeRes()
await handler(fakeReq('POST', '/perseus/config', JSON.stringify({ model: null })), res)
check('null drops the key', !Object.hasOwn(stored, 'model'), JSON.stringify(stored))

// rejects disallowed keys
res = fakeRes()
await handler(fakeReq('POST', '/perseus/config', JSON.stringify({ execution: { x: 1 }, model: 'ok' })), res)
check('disallowed key ignored', !Object.hasOwn(stored, 'execution') && stored.model === 'ok', JSON.stringify(stored))

// bad JSON
res = fakeRes()
await handler(fakeReq('POST', '/perseus/config', '{not json'), res)
check('malformed body → 400', res.code === 400, `code=${res.code}`)

// unknown route
res = fakeRes()
await handler(fakeReq('GET', '/perseus/nope'), res)
check('unknown route → 404', res.code === 404, `code=${res.code}`)

// GET /perseus/events
res = fakeRes()
await handler(fakeReq('GET', '/perseus/events'), res)
check('GET /events → SSE headers', res.code === 200 && String(res.headers['content-type']).startsWith('text/event-stream'), JSON.stringify(res.headers?.['content-type']))

// --- live event flows into the SSE stream ------------------------------------
listeners.get('agent/status')({ status: 'running' })
listeners.get('tools/result')({ call: { name: 'grep' } }, { isError: false })
check('events reached the SSE stream', res.body.includes('"kind":"agent"') && res.body.includes('"kind":"tool"'), res.chunks.slice(-2).join('').slice(0, 160))

// --- a throwing service must not break apply ---------------------------------
const throwing = { ...ctx, configEditor: { entries: () => { throw new Error('boom') }, configuration: () => { throw new Error('boom') }, edit: async () => { throw new Error('boom') } } }
try { mod.apply(throwing); check('throwing configEditor does not break apply', true) } catch (e) { check('throwing configEditor does not break apply', false, e.message) }
const throwingHandler = routes[routes.length - 1].handler
check('throwing apply registered its own route', routes.length === 2)
res = fakeRes()
await throwingHandler(fakeReq('GET', '/perseus/state'), res)
check('route answers 500 instead of crashing on service error', res.code === 500, `code=${res.code}`)

console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED: ${failures.join(' | ')}`)
process.exit(failures.length === 0 ? 0 : 1)
