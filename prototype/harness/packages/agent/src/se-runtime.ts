import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { validateNativeArguments } from "./tool-arguments.ts";
import { AcquisitionSchedule } from "./se-schedule.ts";
import { AsyncContextView, archiveContent, discloseResult, disclosureBudget } from "./context-disclosure.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentContext, AgentLoopConfig, AgentToolCall, AgentToolResult,
  SpeculativeActionCandidate, SpeculativeActionsPrediction, StreamFn } from "./types.ts";
import { canonical, EvidenceLedger, evidenceMessage, isEvidenceMessage,
  type EvidenceMessage, type Observation } from "./evidence-ledger.ts";

type Outcome = { result: AgentToolResult<any>; isError: boolean };
type Future = { id: string; key: string; revision: number; origin: number; abort: AbortController;
  promise: Promise<Outcome>; observation?: Observation; reviewed: boolean };
const failure = (error: unknown): Outcome => ({ isError: true,
  result: { content: [{ type: "text", text: String(error) }], details: {}, isError: true } });

/** Session-owned asynchronous acquisition. No Actor demand matching or result replacement. */
export class SpeculativeSessionRuntime {
  private index = 0;
  private revision = 0;
  private epoch = 0;
  private closed = false;
  private schedule = new AcquisitionSchedule();
  private controller?: AgentLoopConfig["speculativeActions"];
  private tools?: AgentContext["tools"];
  private userKey = "";
  private ledger = new EvidenceLedger();
  private contextView = new AsyncContextView();
  private disclosures = new Map<string, { ready?: EvidenceMessage; preparing: boolean; error?: string }>();
  private readonly seenMessages = new Set<string>();
  private readonly observations = new Map<string, string>();
  private readonly futures = new Map<string, Future>();
  private readonly predictions = new Set<SpeculativeActionsPrediction>();
  private readonly pendingAcquisitions = new Set<Promise<Outcome>>();
  private readonly prepared = new WeakMap<SpeculativeActionCandidate, Record<string, any>>();
  constructor(_maxParallel?: number) {}
  nextRequestIndex(): number { return this.index++; }
  beginAgentRun(): void { this.closed = false; }
  bindScope(context: AgentContext, config: AgentLoopConfig): void {
    const unsupported = config.speculativeActions?.acquisitionPolicy?.swarmEnabled === false ? [] :
      context.tools?.filter(tool => config.speculativeActions?.isEligibleTool(tool.name) && !tool.openAcquisition);
    if (unsupported?.length) throw new Error(`Independent SE execution is not configured for: ${unsupported.map(tool => tool.name).join(", ")}`);
    if (this.controller && (this.controller !== config.speculativeActions || this.tools?.length !== context.tools?.length ||
      this.tools?.some((t, i) => t !== context.tools?.[i]))) this.reset("tool_scope_changed");
    this.controller = config.speculativeActions; this.tools = context.tools;
    this.restore(context);
  }
  private restore(context: AgentContext): void {
    // Resume reconstructs knowledge from persisted messages, not a process-global cache.
    for (const message of context.messages) {
      const o: Observation | undefined = isEvidenceMessage(message) ? message.perseusEvidence.observation :
        (message as any).perseusObservation;
      if (!o || this.seenMessages.has(o.id)) continue;
      this.ledger.ingest(o); this.seenMessages.add(o.id);
      if (!isEvidenceMessage(message)) this.noteProgress(o);
    }
  }
  endRun(reason: string): void {
    if (this.closed) return;
    this.closed = true; this.epoch++; this.schedule.reset();
    for (const p of this.predictions) p.cancel?.();
    this.predictions.clear();
    for (const [key, f] of this.futures) if (!f.observation) { f.abort.abort(); this.futures.delete(key); }
    this.controller?.reset?.();
    this.controller?.record({ event: "se_run_ended", requestIndex: this.index, reason });
  }
  retainForRetry(): void {
    this.controller?.record({ event: "se_retry_retained", requestIndex: this.index,
      pendingPredictions: this.predictions.size,
      pendingTools: [...new Set(this.futures.values())].filter(f => !f.observation).length });
  }
  reset(reason: string): void {
    this.endRun(reason); this.futures.clear(); this.ledger = new EvidenceLedger();
    this.seenMessages.clear(); this.observations.clear(); this.userKey = ""; this.revision++;
    this.controller?.reset?.();
    this.contextView.reset(); this.disclosures.clear();
  }
  manageContext(context: AgentContext, config: AgentLoopConfig): AgentContext {
    const committed = this.contextView.commit();
    if (committed.error) this.controller?.record({ event: "context_compaction_failed", requestIndex: this.index, error: committed.error });
    if (committed.changed) {
      // Invalidate both generation and execution. Late completions fail the epoch check.
      this.endRun("context_view_replaced"); this.futures.clear(); this.disclosures.clear();
      this.ledger = new EvidenceLedger(); this.seenMessages.clear(); this.restore(context);
      this.closed = false; this.revision++;
      this.controller?.record({ event: "context_compaction_committed", requestIndex: this.index, changedMessages: committed.changed,
        contextEpoch: this.epoch, previousSpeculationCancelled: true });
    }
    const messages = this.contextView.view(context.messages);
    this.contextView.schedule(context.messages, config.model.contextWindow);
    return { ...context, messages };
  }
  close(): void { this.reset("session_closed"); }
  /** Only episode teardown waits for native copy cleanup; request boundaries never do. */
  async settleAcquisitions(): Promise<void> {
    while (this.pendingAcquisitions.size) await Promise.allSettled([...this.pendingAcquisitions]);
  }
  private noteProgress(o: Observation): void {
    const key = canonical([o.tool, o.arguments]), value = canonical([o.isError, o.content]);
    if (this.observations.get(key) !== value) { this.observations.set(key, value); this.revision++; }
  }
  observe(_turn: ActiveSpeculativeTurn, outcome: { observation?: Observation }): void {
    if (!outcome.observation) return;
    const o = outcome.observation;
    this.ledger.ingest(o); this.seenMessages.add(o.id); this.noteProgress(o);
  }
  start(context: AgentContext, config: AgentLoopConfig, streamFn: StreamFn,
    signal: AbortSignal | undefined, index: number): ActiveSpeculativeTurn | undefined {
    const controller = config.speculativeActions;
    if (!controller || this.closed || signal?.aborted) return;
    const users = canonical(context.messages.flatMap(m => m.role === "user" && !isEvidenceMessage(m) ? [m.content] : []));
    if (users !== this.userKey) { this.userKey = users; this.revision++; this.schedule.reset(); }
    const turn = new ActiveSpeculativeTurn(this, controller, index);
    const decision = this.schedule.evaluate(context, controller.acquisitionPolicy ?? {}, this.revision);
    turn.record(decision.launch ? "se_wave_triggered" : "se_wave_deferred", decision);
    if (!decision.launch) {
      controller.observeFrontier?.(context, index);
      if (decision.strategy === "initial") turn.record("se_refresh_disabled", { progressRevision: this.revision });
      return turn;
    }
    const epoch = this.epoch, revision = this.revision;
    const snapshot = { ...context, messages: structuredClone(context.messages) };
    try {
      const prediction = controller.beginTurn({ context: snapshot, actorModel: config.model,
        thinkingLevel: config.reasoning ?? "off", sessionId: config.sessionId,
        convertToLlm: config.convertToLlm, streamFn, signal, requestIndex: index,
        progressRevision: revision,
        summarizeObservations: decision.summarizeObservations,
        prepareCandidate: candidate => {
          const tool = context.tools?.find(t => t.name === candidate.toolName);
          if (!tool || !controller.isEligibleTool(tool.name)) throw new Error("Tool is not registered for SE");
          const args = validateNativeArguments(tool, candidate.arguments);
          const prepared = { ...candidate, arguments: args };
          this.prepared.set(prepared, structuredClone(args));
          return prepared;
        },
        executeCandidate: (candidate, workerSignal) => this.execute(candidate, turn, context, revision, epoch, workerSignal),
      });
      if (prediction) {
        this.predictions.add(prediction);
        // Also support callers with a streaming executable frontier and no internal worker loop.
        const consume = async () => {
          if (prediction.candidateBatches) for await (const batch of prediction.candidateBatches)
            for (const candidate of batch) void this.execute(candidate, turn, context, revision, epoch, signal);
          else for (const candidate of await prediction.candidates)
            void this.execute(candidate, turn, context, revision, epoch, signal);
          await prediction.candidates;
        };
        void consume().catch(error => turn.record("se_prediction_failed", { error: String(error) }))
          .finally(() => this.predictions.delete(prediction));
      }
    } catch (error) { turn.record("se_prediction_failed", { error: String(error) }); }
    return turn;
  }
  private execute(candidate: SpeculativeActionCandidate, turn: ActiveSpeculativeTurn, context: AgentContext,
    revision: number, epoch: number, signal?: AbortSignal): Promise<Outcome> {
    if (this.closed || epoch !== this.epoch || signal?.aborted) return Promise.resolve(failure("Acquisition cancelled"));
    const tool = context.tools?.find(t => t.name === candidate.toolName);
    if (!tool || !turn.controller.isEligibleTool(tool.name)) return Promise.resolve(failure("Tool is not registered for SE"));
    if (!tool.openAcquisition) {
      turn.record("se_scope_unavailable", { toolName: tool.name });
      return Promise.resolve(failure("Independent acquisition environment is not configured"));
    }
    let args: any;
    try {
      args = this.prepared.get(candidate) ?? validateNativeArguments(tool, candidate.arguments);
    } catch (error) { turn.record("se_invalid_arguments", { toolName: tool.name, error: String(error) }); return Promise.resolve(failure(error)); }
    const key = canonical([tool.name, args]);
    const previous = this.futures.get(key);
    // Identical in-flight work is joined by workers only, never by the Actor. Changed
    // mainline observations permit refresh; completed observations remain in the ledger/history.
    if (previous && (!previous.observation || previous.revision === revision)) {
      turn.record("se_execution_reused", { futureId: previous.id, toolName: tool.name, arguments: args });
      return previous.promise;
    }
    const abort = new AbortController(), cancel = () => abort.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const id = `spec-se-${randomUUID()}`, start = performance.timeOrigin + performance.now();
    const f: Future = { id, key, revision, origin: turn.index, abort, reviewed: false, promise: Promise.resolve(failure("Not started")) };
    // A completed unreviewed value must not disappear when the same invocation refreshes.
    if (previous && !previous.reviewed) this.futures.set(`${key}:${previous.id}`, previous);
    this.futures.set(key, f);
    turn.record("se_tool_started", { futureId: id, toolName: tool.name, arguments: args, progressRevision: revision });
    let environment: Observation["environment"];
    f.promise = Promise.resolve().then(async () => {
      if (abort.signal.aborted) return failure("Acquisition cancelled");
      turn.record("se_scope_opening", { futureId: id, toolName: tool.name });
      const scope = await tool.openAcquisition!(id, abort.signal);
      environment = scope.provenance;
      try {
        if (environment.kind !== "independent_work_copy" || environment.authoritative !== false || environment.scopeId !== id ||
          !Number.isFinite(environment.snapshotStartedAt) || !Number.isFinite(environment.snapshotFinishedAt) ||
          environment.snapshotFinishedAt < environment.snapshotStartedAt)
          throw new Error("Acquisition environment did not confirm independent execution");
        turn.record("se_scope_opened", { futureId: id, environment });
        if (abort.signal.aborted) return failure("Acquisition cancelled");
        const result = await scope.execute(id, args, abort.signal);
        return { result, isError: result.isError === true };
      } finally {
        await scope.close();
        turn.record("se_scope_closed", { futureId: id });
      }
    })
      .catch(failure).then(outcome => {
        if (!abort.signal.aborted && !this.closed && epoch === this.epoch) {
          f.observation = { id, tool: tool.name, arguments: args, content: structuredClone(outcome.result.content),
            isError: outcome.isError, start, end: performance.timeOrigin + performance.now(), environment };
          turn.record("se_tool_completed", { futureId: id, toolName: tool.name, arguments: args,
            isError: outcome.isError, result: outcome.result.content, environment,
            startedProgressRevision: revision, completedProgressRevision: this.revision });
        } else turn.record("se_tool_cancelled", { futureId: id, toolName: tool.name });
        return outcome;
      }).finally(() => signal?.removeEventListener("abort", cancel));
    this.pendingAcquisitions.add(f.promise);
    void f.promise.then(() => this.pendingAcquisitions.delete(f.promise));
    return f.promise;
  }
  prepareEvidence(index: number, context: AgentContext): EvidenceMessage[] {
    this.restore(context);
    const ready = [...new Set(this.futures.values())].filter(f => f.observation && !f.reviewed && f.origin < index)
      .sort((a, b) => a.observation!.end - b.observation!.end || a.id.localeCompare(b.id));
    this.ledger.register(ready.map(f => f.observation!));
    const messages: EvidenceMessage[] = [];
    for (const f of ready) {
      const prior = this.disclosures.get(f.id);
      if (prior?.error) {
        this.controller?.record({ event: "se_disclosure_failed", requestIndex: index, futureId: f.id, error: prior.error });
        f.reviewed = true; continue;
      }
      if (prior?.preparing) continue;
      if (prior?.ready) {
        messages.push(prior.ready); f.reviewed = true; this.seenMessages.add(f.id);
        this.controller?.record({ event: "se_evidence_committed", requestIndex: index, futureId: f.id,
          sourceRequestIndex: f.origin, toolName: f.observation!.tool, persistent: true, stagedDisclosure: true });
        continue;
      }
      const o = f.observation!, { units, decisions } = this.ledger.ingest(o);
      this.controller?.record({ event: "se_delta_selected", requestIndex: index, futureId: f.id,
        sourceRequestIndex: f.origin, retainedUnits: units.length, decisions });
      if (units.length) {
        const message = evidenceMessage(o, units, decisions), epoch = this.epoch;
        if (Buffer.byteLength(JSON.stringify(message.content)) <= disclosureBudget()) {
          messages.push(message); f.reviewed = true; this.seenMessages.add(o.id);
          this.controller?.record({ event: "se_evidence_committed", requestIndex: index, futureId: f.id,
            sourceRequestIndex: f.origin, toolName: o.tool, retainedUnits: units.length, persistent: true, stagedDisclosure: false });
          continue;
        }
        const stage: { ready?: EvidenceMessage; preparing: boolean; error?: string } = { preparing: true };
        this.disclosures.set(f.id, stage);
        void discloseResult({ content: message.content }, { tool: o.tool, arguments: o.arguments,
          environment: o.environment, retainedUnits: units.length }).then(async result => {
          if (epoch !== this.epoch || this.closed) return;
          const original = await archiveContent(o.content, { tool: o.tool, arguments: o.arguments,
            environment: o.environment, kind: "complete_original_observation" });
          if (epoch !== this.epoch || this.closed) return;
          result.content.push({ type: "text", text: JSON.stringify({
            complete_original_observation: JSON.parse(original[0].text).read_file }) });
          stage.ready = { ...message, content: result.content }; stage.preparing = false;
          this.controller?.record({ event: "se_disclosure_ready", requestIndex: index, futureId: f.id, contextEpoch: epoch,
            archived: result.details?.contextArchive === true, originalBytes: Buffer.byteLength(JSON.stringify(message.content)),
            disclosedBytes: Buffer.byteLength(JSON.stringify(result.content)) });
        }).catch(error => { stage.preparing = false; stage.error = String(error); });
      } else { f.reviewed = true; this.seenMessages.add(o.id); }
    }
    if (this.controller?.acquisitionPolicy?.retainAcrossRequests === false) {
      // This ablation keeps the ready boundary delta and admitted history, but
      // discards only request-local acquisition state. It never waits for work.
      const pendingTools = [...new Set(this.futures.values())].filter(f => !f.observation).length;
      this.controller.record({ event: "se_request_scope_closed", requestIndex: index,
        pendingPredictions: this.predictions.size, pendingTools, readyDelivered: messages.length });
      this.epoch++;
      for (const p of this.predictions) p.cancel?.();
      this.predictions.clear();
      for (const f of this.futures.values()) if (!f.observation) f.abort.abort();
      this.futures.clear(); this.controller.reset?.();
    }
    return messages;
  }
}

export class ActiveSpeculativeTurn {
  readonly id = randomUUID();
  readonly runtime: SpeculativeSessionRuntime;
  readonly controller: NonNullable<AgentLoopConfig["speculativeActions"]>;
  readonly index: number;
  constructor(runtime: SpeculativeSessionRuntime,
    controller: NonNullable<AgentLoopConfig["speculativeActions"]>, index: number) {
    this.runtime = runtime; this.controller = controller; this.index = index;
  }
  record(event: string, data: Record<string, unknown> = {}): void {
    this.controller.record({ event, requestIndex: this.index, turnId: this.id, ...data });
  }
  actorHead(_call: AgentToolCall, _preceding: AgentToolCall[]): void {}
  actorResolved(message: AssistantMessage): void { this.record("actor_resolved", { usage: message.usage,
    stopReason: message.stopReason, actualToolCalls: message.content.filter(p => p.type === "toolCall") }); }
  close(): void { this.record("turn_closed"); }
}
