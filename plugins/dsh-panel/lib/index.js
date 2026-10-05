/**
 * Perseus panel — node half.
 *
 * Contributes a docked side panel to the live Web UI without joining the client
 * module graph. The HTTP surface comes from the `webServer` carrier and the
 * panel markup rides the `webserver/index-inject` table, so a defect here can
 * never fail the client composition that gates boot.
 *
 * Settings read and write through `configEditor.edit()`, which — unlike the
 * `dsh-settings` write path — imposes no volatile-field restriction.
 */
export const name = 'perseus-panel'

/** Both services are hard requirements; while either is missing this plugin stays pending. */
export const inject = ['webServer', 'configEditor']

/** Settings namespace of the `dsh-plugin-perseus` loader row. */
const NS = 'perseus'

/** Cap on retained feed entries. */
const FEED_LIMIT = 200

/** One-line, cycle-safe summary of an arbitrary event payload. */
function summarize(value, depth = 0) {
  try {
    if (value === null || value === undefined) return value ?? null
    if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 117)}...` : value
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'function') return '[fn]'
    if (depth >= 2) return '[…]'
    if (Array.isArray(value)) return value.slice(0, 6).map((item) => summarize(item, depth + 1))
    if (typeof value === 'object') {
      const out = {}
      let taken = 0
      for (const key of Object.keys(value)) {
        if (taken >= 8) break
        if (/^(signal|agent|session|ctx|context|runtime)$/.test(key)) continue
        const inner = summarize(value[key], depth + 1)
        if (inner === undefined) continue
        out[key] = inner
        taken += 1
      }
      return out
    }
    return String(value)
  } catch {
    return '[unreadable]'
  }
}

function json(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 65536) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(raw === '' ? {} : JSON.parse(raw))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

/** Current raw config of the perseus row: explicit override over the inherited layer. */
function readConfig(ctx) {
  const rows = ctx.configEditor.configuration()
  const row = rows.find((candidate) => candidate.entry?.options?.id === NS)
  if (row === undefined) return undefined
  return { inherited: row.inherited ?? {}, override: row.override ?? {}, merged: { ...row.inherited, ...row.override } }
}

async function writeConfig(ctx, patch) {
  const entry = ctx.configEditor.entries().find((candidate) => candidate.options?.id === NS)
  if (entry === undefined) throw new Error(`no active loader row with patch id "${NS}"`)
  await ctx.configEditor.edit(entry, (current) => {
    const next = { ...current }
    for (const [key, value] of Object.entries(patch)) {
      // JSON cannot carry `undefined`, so the panel sends `null` to mean
      // "drop this override and inherit again".
      if (value === undefined || value === null) Reflect.deleteProperty(next, key)
      else next[key] = value
    }
    return next
  })
}

const PANEL_CSS = `
#perseus-panel-toggle{position:fixed;right:12px;bottom:12px;z-index:2147483000;font:600 12px/1 -apple-system,system-ui,sans-serif;padding:9px 13px;border-radius:999px;border:1px solid rgba(127,127,127,.35);background:rgba(28,28,32,.92);color:#fff;cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.28)}
#perseus-panel{position:fixed;top:0;right:0;bottom:0;width:392px;max-width:92vw;z-index:2147483000;display:none;flex-direction:column;background:#17171b;color:#e9e9ee;border-left:1px solid rgba(127,127,127,.32);box-shadow:-8px 0 32px rgba(0,0,0,.35);font:13px/1.5 -apple-system,system-ui,sans-serif}
#perseus-panel.open{display:flex}
#perseus-panel .pp-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid rgba(127,127,127,.22)}
#perseus-panel .pp-head strong{font-size:13px;flex:1}
#perseus-panel .pp-head span{font-size:11px;opacity:.62}
#perseus-panel .pp-body{overflow:auto;padding:14px;display:flex;flex-direction:column;gap:14px}
#perseus-panel fieldset{border:1px solid rgba(127,127,127,.24);border-radius:9px;padding:11px;margin:0;display:flex;flex-direction:column;gap:9px}
#perseus-panel legend{font-size:11px;letter-spacing:.04em;text-transform:uppercase;opacity:.6;padding:0 5px}
#perseus-panel label{display:flex;flex-direction:column;gap:4px;font-size:12px}
#perseus-panel input[type=text],#perseus-panel select{background:#0f0f12;color:inherit;border:1px solid rgba(127,127,127,.3);border-radius:6px;padding:6px 8px;font:inherit}
#perseus-panel .pp-row{display:flex;gap:8px;align-items:center}
#perseus-panel button{cursor:pointer;border-radius:6px;border:1px solid rgba(127,127,127,.3);background:#26262c;color:inherit;font:inherit;padding:6px 11px}
#perseus-panel button:disabled{opacity:.45;cursor:default}
#perseus-panel .pp-state{font-size:12px;opacity:.75;min-height:16px}
#perseus-panel ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px;font-size:11.5px}
#perseus-panel li{display:flex;gap:7px;align-items:baseline;padding:4px 6px;border-radius:5px;background:rgba(127,127,127,.09)}
#perseus-panel li code{opacity:.6;flex:none}
#perseus-panel li em{font-style:normal;opacity:.85;word-break:break-all}
`

const PANEL_HTML = `
<button id="perseus-panel-toggle" type="button">Perseus</button>
<div id="perseus-panel" role="complementary" aria-label="Perseus">
  <div class="pp-head"><strong>Perseus</strong><span id="pp-conn">connecting…</span>
    <button type="button" id="pp-close" aria-label="close">✕</button></div>
  <div class="pp-body">
    <fieldset><legend>配置</legend>
      <label class="pp-row"><input type="checkbox" id="pp-enabled"> <span>启用 Speculator</span></label>
      <label>工具白名单（逗号分隔，留空=不限制）
        <input type="text" id="pp-tools" placeholder="read, grep, glob, bash"></label>
      <label>Speculator 模型<input type="text" id="pp-model" placeholder="deepseek-flash"></label>
      <label>推理强度
        <select id="pp-effort"><option value="">（继承）</option><option>off</option><option>low</option><option>high</option><option>max</option></select></label>
      <div class="pp-row"><button type="button" id="pp-save" disabled>保存</button>
        <button type="button" id="pp-reload">重新读取</button></div>
      <div class="pp-state" id="pp-state"></div>
    </fieldset>
    <fieldset><legend>任务流程</legend>
      <ul id="pp-feed"></ul>
      <div class="pp-state" id="pp-feed-state">等待事件…</div>
    </fieldset>
  </div>
</div>
`

const PANEL_SCRIPT = `(function(){
  if (window.__perseusPanelMounted) return; window.__perseusPanelMounted = true;
  var $ = function(id){ return document.getElementById(id); };
  var state = $('pp-state'), conn = $('pp-conn'), feed = $('pp-feed'), feedState = $('pp-feed-state');
  var save = $('pp-save'), dirty = false;
  function markDirty(){ dirty = true; save.disabled = false; }
  ['pp-enabled','pp-tools','pp-model','pp-effort'].forEach(function(id){
    var el = $(id); if (el) el.addEventListener('input', markDirty);
  });
  $('perseus-panel-toggle').addEventListener('click', function(){ $('perseus-panel').classList.add('open'); });
  $('pp-close').addEventListener('click', function(){ $('perseus-panel').classList.remove('open'); });
  function render(cfg){
    if (!cfg) { state.textContent = '未找到 perseus 配置行'; return; }
    $('pp-enabled').checked = cfg.enabled !== false;
    $('pp-tools').value = Array.isArray(cfg.tools) ? cfg.tools.join(', ') : '';
    $('pp-model').value = typeof cfg.model === 'string' ? cfg.model : '';
    var eff = typeof cfg.reasoningEffort === 'string' ? cfg.reasoningEffort : '';
    $('pp-effort').value = ['off','low','high','max'].indexOf(eff) >= 0 ? eff : '';
    state.textContent = '已载入'; dirty = false; save.disabled = true;
  }
  function load(){
    state.textContent = '读取中…';
    fetch('perseus/state', { credentials: 'same-origin' })
      .then(function(r){ return r.json(); })
      .then(function(d){ render(d && d.config ? d.config.merged : undefined); })
      .catch(function(e){ state.textContent = '读取失败: ' + e; });
  }
  $('pp-reload').addEventListener('click', load);
  save.addEventListener('click', function(){
    var tools = $('pp-tools').value.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    var patch = {
      enabled: $('pp-enabled').checked,
      tools: tools.length ? tools : null,
      model: $('pp-model').value.trim() || null,
      reasoningEffort: $('pp-effort').value || null
    };
    save.disabled = true; state.textContent = '保存中…';
    fetch('perseus/config', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
      .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
      .then(function(res){ if (!res.ok) throw new Error((res.d && res.d.error) || 'rejected');
        state.textContent = '已保存'; dirty = false; render(res.d.config ? res.d.config.merged : undefined); })
      .catch(function(e){ state.textContent = '保存失败: ' + e.message; save.disabled = false; });
  });
  function line(item){
    var li = document.createElement('li');
    var t = document.createElement('code');
    var d = new Date(item.at); t.textContent = ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)+':'+('0'+d.getSeconds()).slice(-2);
    var e = document.createElement('em'); e.textContent = item.kind + ' ' + JSON.stringify(item.detail);
    li.appendChild(t); li.appendChild(e); return li;
  }
  try {
    var es = new EventSource('perseus/events');
    es.addEventListener('open', function(){ conn.textContent = '已连接'; });
    es.addEventListener('error', function(){ conn.textContent = '重连中…'; });
    es.addEventListener('message', function(ev){
      try {
        var item = JSON.parse(ev.data);
        if (item && item.kind === 'snapshot') { return; }
        feedState.textContent = ''; feed.insertBefore(line(item), feed.firstChild);
        while (feed.childNodes.length > 80) feed.removeChild(feed.lastChild);
      } catch (e) {}
    });
  } catch (e) { conn.textContent = 'SSE 不可用'; }
  load();
})();`

export function apply(ctx) {
  const feed = []
  const streams = new Set()

  const publish = (kind, detail) => {
    const item = { at: Date.now(), kind, detail }
    feed.push(item)
    if (feed.length > FEED_LIMIT) feed.shift()
    const frame = `data: ${JSON.stringify(item)}\n\n`
    for (const res of [...streams]) {
      try {
        res.write(frame)
      } catch {
        streams.delete(res)
      }
    }
  }

  const observe = (event, label, project) => {
    try {
      ctx.effect(() => ctx.on(event, (...args) => {
        try {
          publish(label, project === undefined ? summarize(args) : project(...args))
        } catch {
          /* a feed projection must never disturb the emitting path */
        }
      }), `perseus-panel: ${event}`)
    } catch (error) {
      ctx.logger?.warn?.(error)
    }
  }

  // Emit-mode events only: a waterfall subscription would have to call next().
  observe('tools/result', 'tool', (exec, result) => ({
    name: exec?.call?.name ?? exec?.name ?? exec?.toolName ?? 'tool',
    error: result?.isError === true
  }))
  observe('agent/status', 'agent', (_payload) => summarize(_payload))
  observe('agent/error', 'error', (payload) => summarize(payload))
  observe('subagent/start', 'subagent+', (info) => summarize(info))
  observe('subagent/end', 'subagent-', (info) => summarize(info))
  observe('workflow/start', 'workflow', (info) => summarize(info))
  observe('workflow/phase', 'phase', (_info, title) => summarize(title))
  observe('settings/document-updated', 'settings', (ns, revision) => ({ ns, revision }))

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/perseus',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const route = url.pathname.replace(/^\/perseus/, '') || '/'

          if (route === '/state' && req.method === 'GET') {
            json(res, 200, { ok: true, config: readConfig(ctx), feed: feed.slice(-60) })
            return
          }

          if (route === '/config' && req.method === 'POST') {
            const patch = await readBody(req)
            if (patch === undefined) {
              json(res, 400, { ok: false, error: 'invalid JSON body' })
              return
            }
            const allowed = {}
            for (const key of ['enabled', 'tools', 'model', 'provider', 'reasoningEffort']) {
              if (Object.hasOwn(patch, key)) allowed[key] = patch[key]
            }
            await writeConfig(ctx, allowed)
            json(res, 200, { ok: true, config: readConfig(ctx) })
            return
          }

          if (route === '/events' && req.method === 'GET') {
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              connection: 'keep-alive'
            })
            res.write(`data: ${JSON.stringify({ kind: 'hello', at: Date.now(), detail: { feed: feed.slice(-40) } })}\n\n`)
            streams.add(res)
            const drop = () => streams.delete(res)
            req.on('close', drop)
            res.on('close', drop)
            return
          }

          json(res, 404, { ok: false, error: `no route ${req.method} ${route}` })
        } catch (error) {
          try {
            json(res, 500, { ok: false, error: String(error?.message ?? error) })
          } catch {
            /* response already committed */
          }
        }
      }
    }), 'perseus-panel: routes')

    ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
      try {
        table.push({ kind: 'style', text: PANEL_CSS })
        table.push({ kind: 'html', placement: 'body', html: PANEL_HTML })
        table.push({ kind: 'script', placement: 'body', text: PANEL_SCRIPT })
      } catch (error) {
        ctx.logger?.warn?.(error)
      }
    }), 'perseus-panel: index injection')
  } catch (error) {
    ctx.logger?.warn?.(error)
  }
}
