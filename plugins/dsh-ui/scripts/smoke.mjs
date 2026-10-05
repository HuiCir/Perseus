#!/usr/bin/env node
/**
 * Offline smoke test for the hand-written client bundle.
 *
 * The real page needs the browser module table and React, so this harness stubs
 * both: it captures the `window.__ModuleLoader__.load` registration, executes the
 * factory, mounts the card through a tiny stateful `createElement`/hook shim, and
 * drives the staged form against a fake `ConfigFormController`. It proves the
 * bundle parses, exports the plugin face, registers into `plugins.item`, renders
 * every field, and emits the expected path ops and row outcomes — it cannot prove
 * the live browser UI.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(project, 'lib', 'client.js'), 'utf8');

let registration;
globalThis.window = { __ModuleLoader__: { load: (value) => { registration = value; } } };

/**
 * Minimal hook runtime: one flat cell list stands in for a mounted tree, and
 * every top-level render restarts the hook cursor. Component order and hook
 * order are deterministic, so index-addressed cells behave like `useState`.
 */
let cells = [];
let cursor = 0;
const React = {
  createElement(type, props, ...children) {
    const flat = children.flat().filter((child) => child !== undefined && child !== null && child !== false);
    if (typeof type === 'function') return type({ ...(props ?? {}), children: flat.length <= 1 ? flat[0] : flat });
    return { type, props: props ?? {}, children: flat };
  },
  useMemo: (compute) => compute(),
  useState(initial) {
    const index = cursor++;
    if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
    return [cells[index], (next) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next; }];
  },
  useEffect: () => {},
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot()
};

const requireShim = (specifier) => {
  if (specifier === 'react') return React;
  throw new Error(`smoke: unexpected require(${JSON.stringify(specifier)})`);
};

// eslint-disable-next-line no-new-func
new Function('window', source)(globalThis.window);
if (registration === undefined) throw new Error('smoke: the bundle did not register with window.__ModuleLoader__');
if (registration.id !== 'dsh-plugin-perseus-ui') throw new Error(`smoke: unexpected bundle id ${registration.id}`);
const plugin = registration.factory(requireShim);
if (typeof plugin.apply !== 'function') throw new Error('smoke: apply is not a function');
if (!Array.isArray(plugin.inject)) throw new Error('smoke: inject is not an array');
for (const service of ['slots', 'locale', 'configForms', 'remote']) {
  if (!plugin.inject.includes(service)) throw new Error(`smoke: inject is missing ${service}`);
}

const writes = [];
const snapshot = {
  status: 'ready', writable: true, revision: 7,
  value: { enabled: true, tools: ['read', 'grep'], model: 'deepseek-flash', reasoningEffort: 'high' }
};
const form = {
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
  mutate: async (ops, revision) => { writes.push({ ops, revision }); return true; }
};

const rowCalls = [];
let rowAnswer = { ok: true, value: { stage: 'enable', target: 'include:perseus', enabled: false, changed: true, application: 'restart-required' } };
let registered;
let watched;
const ctx = {
  locale: { bind: () => (key) => key, register: () => () => {} },
  configForms: {
    get: (ns) => { if (ns !== 'perseus') throw new Error(`smoke: unexpected namespace ${ns}`); return form; },
    whileServed: (namespaces, register) => { watched = namespaces; return register(new Set(namespaces)); }
  },
  slots: { inject: (name, register) => register(), register: (options, component) => { registered = { options, component }; return () => {}; } },
  remote: { pluginManager: { setPluginEnabled: async (id, enabled) => { rowCalls.push({ id, enabled }); return rowAnswer; } } },
  effect: (run) => { run(); }
};

plugin.apply(ctx);
if (registered === undefined) throw new Error('smoke: no slot registration happened');
if (registered.options.name !== 'plugins.item') throw new Error(`smoke: registered into ${registered.options.name}`);
if (registered.options.id !== 'perseus' || registered.options.order !== 50) throw new Error('smoke: unexpected slot identity');
if (typeof registered.options.label() !== 'string') throw new Error('smoke: label is not a thunk returning a string');
if (JSON.stringify(watched) !== '["perseus"]') throw new Error('smoke: whileServed did not watch the perseus namespace');

const face = registered.options.inject();
if (typeof face.hooks?.perseusCard?.getSnapshot !== 'function') throw new Error('smoke: the perseusCard hook source is not a snapshot source');
if (face.perseusForm !== form) throw new Error('smoke: the form is not injected as a prop');
if (typeof face.perseusRow?.setEnabled !== 'function') throw new Error('smoke: the row switch was not injected');

const summary = registered.component({ t: (key) => key, view: 'summary', usePerseusCard: (select) => select(snapshot) });
if (summary !== 'description') throw new Error(`smoke: unexpected summary ${String(summary)}`);

const render = () => {
  cursor = 0;
  return registered.component({
    t: (key) => key, view: 'page', usePerseusCard: (select) => select(snapshot),
    perseusForm: face.perseusForm, perseusRow: face.perseusRow
  });
};
/** A fresh mount: discard staged state so the draft restarts from the snapshot. */
const fresh = () => {
  cells = [];
  return render();
};
const walk = (node, visit) => {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return; }
  if (node.type !== undefined) visit(node);
  (node.children ?? []).forEach((child) => walk(child, visit));
};
const byId = (tree, id) => {
  let found;
  walk(tree, (node) => { if (node.props.id === id) found = node; });
  if (found === undefined) throw new Error(`smoke: no element with id ${id}`);
  return found;
};
const buttonLabelled = (tree, label) => {
  let found;
  walk(tree, (node) => { if (node.type === 'button' && (node.children ?? []).includes(label)) found = node; });
  if (found === undefined) throw new Error(`smoke: no button labelled ${label}`);
  return found;
};
/** Whether any element renders the given text. */
const hasText = (tree, text) => {
  let found = false;
  walk(tree, (node) => { if ((node.children ?? []).includes(text)) found = true; });
  return found;
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

let tree = fresh();
const kinds = new Set();
walk(tree, (node) => kinds.add(node.type));
for (const expected of ['section', 'input', 'select', 'button']) {
  if (!kinds.has(expected)) throw new Error(`smoke: the page view renders no <${expected}>`);
}
if (tree.props['data-plugin-config-perseus'] !== true) throw new Error('smoke: the page view is not marked as the perseus config block');
for (const marker of ['perseus-enabled', 'perseus-tools', 'perseus-model', 'perseus-effort', 'perseus-provider']) byId(tree, marker);
const effortValues = [];
walk(byId(tree, 'perseus-effort'), (node) => { if (node.type === 'option') effortValues.push(node.props.value); });
if (JSON.stringify(effortValues) !== JSON.stringify(['', 'off', 'low', 'high', 'max'])) {
  throw new Error(`smoke: unexpected effort options ${JSON.stringify(effortValues)}`);
}
if (byId(tree, 'perseus-tools').props.value !== 'read, grep') throw new Error('smoke: the allowlist text was not projected');
if (byId(tree, 'perseus-enabled').props.checked !== true) throw new Error('smoke: enabled was not projected');
if (buttonLabelled(tree, 'apply').props.disabled !== true) throw new Error('smoke: Apply is enabled while clean');

// Stage three edits, then apply them as one mutation at the snapshot revision.
byId(tree, 'perseus-tools').props.onChange({ target: { value: 'read, glob' } });
byId(tree, 'perseus-enabled').props.onChange({ target: { checked: false } });
byId(tree, 'perseus-model').props.onChange({ target: { value: '' } });
tree = render();
if (buttonLabelled(tree, 'apply').props.disabled !== false) throw new Error('smoke: Apply stayed disabled while dirty');
if (hasText(tree, 'dirty') !== true) throw new Error('smoke: the dirty marker was not rendered');
buttonLabelled(tree, 'apply').props.onClick();
await flush();
if (writes.length !== 1) throw new Error(`smoke: expected one mutation, saw ${writes.length}`);
if (writes[0].revision !== 7) throw new Error(`smoke: unexpected revision ${writes[0].revision}`);
const expectedOps = [
  { op: 'set', path: ['enabled'], value: false },
  { op: 'set', path: ['tools'], value: ['read', 'glob'] },
  { op: 'unset', path: ['model'] }
];
if (JSON.stringify(writes[0].ops) !== JSON.stringify(expectedOps)) {
  throw new Error(`smoke: unexpected ops ${JSON.stringify(writes[0].ops)}`);
}

// Clearing the allowlist unsets it instead of writing an empty list.
tree = fresh();
byId(tree, 'perseus-tools').props.onChange({ target: { value: '  ' } });
byId(render(), 'perseus-effort').props.onChange({ target: { value: 'max' } });
buttonLabelled(render(), 'apply').props.onClick();
await flush();
if (JSON.stringify(writes[1].ops) !== JSON.stringify([{ op: 'unset', path: ['tools'] }, { op: 'set', path: ['reasoningEffort'], value: 'max' }])) {
  throw new Error(`smoke: clearing the allowlist produced ${JSON.stringify(writes[1].ops)}`);
}

// The row switch reports the management outcome, never a bare string.
tree = fresh();
buttonLabelled(tree, 'rowDisable').props.onClick();
await flush();
if (JSON.stringify(rowCalls) !== JSON.stringify([{ id: 'include:perseus', enabled: false }])) {
  throw new Error(`smoke: unexpected row calls ${JSON.stringify(rowCalls)}`);
}
if (!hasText(render(), 'rowRestart')) throw new Error('smoke: the restart-required outcome was not rendered');

rowAnswer = { ok: false, error: { code: 'unaddressable' } };
buttonLabelled(render(), 'rowDisable').props.onClick();
await flush();
if (!hasText(render(), 'unaddressable')) throw new Error('smoke: the management failure code was not rendered');

// A read-only deployment disables every control.
snapshot.writable = false;
tree = fresh();
if (byId(tree, 'perseus-tools').props.disabled !== true) throw new Error('smoke: a read-only deployment left the fields enabled');
if (buttonLabelled(tree, 'apply').props.disabled !== true) throw new Error('smoke: a read-only deployment left Apply enabled');
if (!hasText(tree, 'readOnly')) throw new Error('smoke: the read-only notice was not rendered');
snapshot.writable = true;

// A namespace the Host does not serve renders the unavailable notice instead.
snapshot.status = 'unavailable';
const unavailable = fresh();
if (unavailable.type !== 'p' || unavailable.children[0] !== 'unavailable') {
  throw new Error('smoke: an unserved namespace did not render the unavailable notice');
}

console.log('smoke: OK — exports, registration, projection, mutation ops, row outcomes and edge states');
