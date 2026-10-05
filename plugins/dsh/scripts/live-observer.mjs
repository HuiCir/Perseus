/** Read-only diagnostics for an officially loaded DSH/Perseus live run. */
import { openSync, writeSync, closeSync } from 'node:fs';

export const name = 'perseus-live-observer';
export const inject = ['perseus', 'llm', 'sessions', 'agents'];

const statusNumbers = ['ordinal', 'revision', 'epoch', 'pendingWorkers', 'pendingAcquisitions',
  'readyObservations', 'waves', 'workers', 'executions', 'reusedExecutions', 'evidence', 'invalidCalls'];
const eventNumbers = ['ordinal', 'revision', 'epoch', 'workerCount', 'domainCount', 'sourceRequestOrdinal', 'units'];
const usageNumbers = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
const finishKinds = new Set(['stop', 'tool-calls', 'max-tokens', 'error', 'aborted']);
const lifecycleReasons = new Set(['actor_stopping', 'host_aborted', 'actor_error', 'provider_removed',
  'surface_replaced', 'turn_completed', 'turn_aborted', 'turn_error', 'turn_max-tokens', 'turn_blocked']);
const label = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,192}$/.test(value) ? value : 'other';
const numeric = (value, names) => Object.fromEntries(names
  .filter(key => typeof value?.[key] === 'number' && Number.isFinite(value[key]))
  .map(key => [key, value[key]]));

/** Config is intentionally host-independent: { logPath: absolutePath, pollMs?: 100 }. */
export function apply(ctx, config = {}) {
  if (typeof config.logPath !== 'string' || !config.logPath.startsWith('/')) {
    throw new Error('perseus-live-observer requires an absolute config.logPath');
  }
  const pollMs = config.pollMs ?? 100;
  if (!Number.isSafeInteger(pollMs) || pollMs < 20 || pollMs > 10_000) {
    throw new Error('perseus-live-observer pollMs must be an integer between 20 and 10000');
  }
  const descriptor = openSync(config.logPath, 'a', 0o600);
  const runId = `${process.pid}-${Date.now()}`;
  const started = performance.now();
  const ids = new Set(ctx.agents.list().map(agent => agent.id));
  const lastStatus = new Map();
  const activeModels = new Set();
  let modelCounter = 0;
  let stopped = false;
  let sinkFailed = false;
  // Retain the public read-only service, so final diagnostics do not depend on registry teardown order.
  const perseus = ctx.perseus;

  function write(type, fields = {}) {
    if (stopped || sinkFailed) return;
    try {
      writeSync(descriptor, JSON.stringify({ schemaVersion: 1, observerRunId: runId,
        at: Date.now(), elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
        type, ...fields }) + '\n');
    } catch {
      sinkFailed = true;
      try { ctx.logger.warn('Perseus live observer could not write diagnostics'); } catch { /* diagnostics cannot alter the run */ }
    }
  }

  function state(agentId) {
    try {
      const current = perseus.status(agentId);
      if (!current) return undefined;
      return { ...numeric(current, statusNumbers), closed: current.closed === true,
        cleanupErrorCount: Array.isArray(current.cleanupErrors) ? current.cleanupErrors.length : 0,
        counts: Object.fromEntries(Object.entries(current.counts ?? {})
          .filter(([key, value]) => /^se_[a-z_]+$/.test(key) && typeof value === 'number' && Number.isFinite(value))) };
    } catch { return undefined; }
  }

  function recordState(agentId, reason, force = false) {
    const current = state(agentId);
    if (!current) return;
    const serialized = JSON.stringify(current);
    if (force || serialized !== lastStatus.get(agentId)) {
      lastStatus.set(agentId, serialized);
      write('perseus_status', { agentId: label(agentId), reason, ...current });
    }
  }

  function evidenceCounts(session) {
    try {
      const durable = session.snapshotEvents().filter(event => event.type === 'user/message'
        && event.data.source?.kind === 'perseus-evidence');
      return { durableEvidenceMessages: durable.length,
        durableObservations: durable.reduce((sum, event) => sum
          + (Array.isArray(event.data.source.observations) ? event.data.source.observations.length : 0), 0),
        visibleEvidenceMessages: session.deriveMessages().filter(message => message.source?.kind === 'perseus-evidence').length };
    } catch { return { evidenceCountsUnavailable: true }; }
  }

  write('observer_loaded', { pollMs, existingAgents: ids.size });
  const timer = setInterval(() => { for (const id of ids) recordState(id, 'poll'); }, pollMs);
  timer.unref();
  ctx.effect(() => () => {
    clearInterval(timer);
    for (const id of ids) recordState(id, 'observer_dispose', true);
    const states = [...ids].map(id => state(id)).filter(Boolean);
    write('observer_dispose', { knownAgents: ids.size, availableStatuses: states.length, activeModelStreams: activeModels.size,
      quiescent: activeModels.size === 0 && states.length === ids.size && states.every(value => value.pendingWorkers === 0
        && value.pendingAcquisitions === 0 && value.cleanupErrorCount === 0) });
    stopped = true;
    try { closeSync(descriptor); } catch { /* diagnostics cannot alter cleanup */ }
  });

  ctx.on('agent/created', async ({ agent, source }) => {
    ids.add(agent.id);
    write('agent_created', { agentId: label(agent.id), source: label(source),
      provider: label(agent.options.provider), model: label(agent.options.model) });
    recordState(agent.id, 'created', true);
  });
  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const route = await next();
    ids.add(agent.id);
    write('actor_request_config', { agentId: label(agent.id), turn, step,
      provider: label(route.provider), model: label(route.model) });
    return route;
  });
  ctx.on('agent/status', ({ agent, status }) => {
    ids.add(agent.id);
    write('agent_status', { agentId: label(agent.id), status: label(status) });
    recordState(agent.id, `agent_${label(status)}`, true);
  });
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') write('actor_attempt_start', { agentId: label(agent.id), turn: frame.turn, step: frame.step });
    if (frame.type === 'end') write('actor_attempt_end', { agentId: label(agent.id), turn: frame.turn,
      step: frame.step, outcome: label(frame.outcome?.kind) });
  });

  ctx.on('llm/stream', async function* (options, next) {
    const requestId = ++modelCounter;
    const requestStarted = performance.now();
    const nonSystem = options.messages.filter(message => message.role !== 'system');
    // sessionId is the documented loop stamp. Perseus one-round worker requests lack it.
    const isActor = typeof options.sessionId === 'string' && options.purpose === undefined;
    const isSpeculator = !isActor && options.purpose === undefined && nonSystem.length > 0
      && nonSystem.every(message => message.source?.kind === 'perseus-history');
    const role = isActor ? 'actor' : isSpeculator ? 'speculator' : 'auxiliary';
    activeModels.add(requestId);
    if (isActor) ids.add(options.sessionId);
    write('model_start', { requestId, role, isActor, provider: label(options.provider), model: label(options.model),
      ...(isActor ? { agentId: label(options.sessionId) } : {}),
      tools: (options.tools ?? []).map(tool => label(tool.name)), messageCount: options.messages.length,
      evidenceMessages: options.messages.filter(message => message.source?.kind === 'perseus-evidence').length,
      projectedHistoryMessages: nonSystem.filter(message => message.source?.kind === 'perseus-history').length,
      ...numeric(options, ['maxTokens']) });
    let finish = 'stream-incomplete';
    let toolCalls = 0;
    let usage;
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
          toolCalls++;
          write('model_tool_call_complete', { requestId, role, tool: label(chunk.block.name), index: chunk.index });
        }
        if (chunk.type === 'usage') usage = numeric(chunk.usage, usageNumbers);
        if (chunk.type === 'finish') {
          finish = finishKinds.has(chunk.reason?.kind) ? chunk.reason.kind : 'other';
          write('model_finish', { requestId, role, finish,
            ...(chunk.reason?.failure?.code ? { failureCode: label(chunk.reason.failure.code) } : {}),
            ...(usage ? { usage } : {}) });
        }
        yield chunk;
      }
    } finally {
      activeModels.delete(requestId);
      write('model_end', { requestId, role, finish, toolCalls, aborted: options.signal?.aborted === true,
        durationMs: Math.round((performance.now() - requestStarted) * 1000) / 1000,
        ...(usage ? { usage } : {}) });
    }
  });

  ctx.on('perseus/event', event => {
    ids.add(event.agentId);
    const fields = { agentId: label(event.agentId), event: label(event.event), ...numeric(event, eventNumbers) };
    if (typeof event.tool === 'string') fields.tool = label(event.tool);
    if (typeof event.isError === 'boolean') fields.isError = event.isError;
    if (lifecycleReasons.has(event.reason)) fields.reason = event.reason;
    if (Array.isArray(event.decisions)) fields.decisionCounts = event.decisions.reduce((counts, decision) => {
      const reason = ['novel_complete_unit', 'known_complete_unit', 'older_than_known_observation'].includes(decision.reason)
        ? decision.reason : 'other';
      counts[reason] = (counts[reason] ?? 0) + 1;
      return counts;
    }, {});
    write('perseus_event', fields);
    recordState(event.agentId, 'perseus_event');
  });

  ctx.on('session/event', (session, event) => {
    ids.add(session.id);
    if (event.type === 'user/message' && event.data.source?.kind === 'perseus-evidence') {
      write('evidence_persisted', { agentId: label(session.id), seq: event.seq, ...evidenceCounts(session) });
    }
    if (event.type === 'tool/call') {
      write('actor_tool_call_persisted', { agentId: label(session.id), seq: event.seq, tool: label(event.data.name) });
    }
    if (event.type === 'tool/result') {
      write('actor_tool_result_persisted', { agentId: label(session.id), seq: event.seq, isError: event.data.message.isError === true });
    }
    if (event.type === 'turn/end') {
      write('turn_end', { agentId: label(session.id), turn: event.data.turn,
        reason: label(event.data.reason?.kind), ...evidenceCounts(session) });
      recordState(session.id, 'turn_end', true);
    }
  });
}
