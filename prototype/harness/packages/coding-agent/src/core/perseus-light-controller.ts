import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { validateToolArguments, type Context, type Message, type Model, type ToolCall, type UserMessage } from "@earendil-works/pi-ai";
import { bindActionHead, deriveActionDomains, type ActionDomain } from "./perseus-action-domains.ts";
import { validateNativeArguments, validateAcquisitionPolicy, type AcquisitionPolicy } from "@earendil-works/pi-agent-core";
import type { SpeculativeActionCandidate, SpeculativeActionsBeginContext,
  SpeculativeActionsController, SpeculativeActionTraceEvent, ThinkingLevel } from "@earendil-works/pi-agent-core";

interface Options extends AcquisitionPolicy {
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  briefTools: string[];
  traceFile?: string;
  deriveTools?: boolean;
  refreshAfterProgress?: boolean;
  retainAcrossRequests?: boolean;
}

/** Exact record dictionary with a chronological index. No semantic omission. */
export function summarizeObservationRecords(observations: UserMessage[]): UserMessage[] {
  const records: { header: Record<string, unknown>; blockIds: number[] }[] = [];
  const blocks: Exclude<UserMessage["content"], string> = [], blockKeys = new Map<string, number>();
  const keys = new Map<string, number>(), chronology: number[] = [];
  for (const message of observations) {
    if (typeof message.content === "string" || message.content[0]?.type !== "text")
      throw new Error("Expected structured preexecution observation");
    const { observationIndex: _index, ...header } = JSON.parse(message.content[0].text);
    const blockIds = message.content.slice(1).map(block => {
      const key = JSON.stringify(block);
      let id = blockKeys.get(key);
      if (id === undefined) { id = blocks.length; blockKeys.set(key, id); blocks.push(block); }
      return id;
    });
    const key = JSON.stringify([header, blockIds]);
    let id = keys.get(key);
    if (id === undefined) { id = records.length; keys.set(key, id); records.push({ header, blockIds }); }
    chronology.push(id);
  }
  const projected: UserMessage[] = [{ role: "user", timestamp: observations[0]?.timestamp ?? 0, content: [
    { type: "text", text: JSON.stringify({ kind: "lossless_observation_dictionary", version: 2, chronology, records }) },
    ...blocks.flatMap((block, blockId) => [
      { type: "text" as const, text: JSON.stringify({ blockId }) }, block]),
  ] }];
  return Buffer.byteLength(JSON.stringify(projected)) < Buffer.byteLength(JSON.stringify(observations)) ? projected : observations;
}

export function createPerseusLightController(options: Options): SpeculativeActionsController {
  return new EvidenceController(options);
}

/** Mainline records are observations, never a forged continuation of this worker. */
export function preexecutionObservations(messages: Message[]): UserMessage[] {
  return messages.map((message, observationIndex) => {
    const evidence = (message as any).perseusEvidence?.observation;
    const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    const content: Exclude<UserMessage["content"], string> = [{ type: "text",
      text: JSON.stringify({ observationIndex, owner: evidence?.environment ? "independent_work_copy" : "mainline", role: message.role,
        ...(evidence?.environment ? { authoritative: false, artifacts_transferred_from_source_copy: false } : {}),
        ...(message.role === "toolResult" ? { toolName: message.toolName, isError: message.isError } : {}) }) }];
    for (const block of blocks) {
      if (block.type === "image" || block.type === "text") content.push(block);
      else if (block.type === "toolCall") content.push({ type: "text", text: JSON.stringify({
        type: "mainline_action", toolName: block.name, arguments: block.arguments }) });
      // Opaque reasoning belongs to its original model conversation, not a copied worker.
    }
    return { role: "user", content, timestamp: message.timestamp };
  });
}

class EvidenceController implements SpeculativeActionsController {
  readonly acquisitionPolicy: AcquisitionPolicy;
  private readonly issued = new Map<string, number>();
  private readonly active = new Map<string, number>();
  private readonly generating = new Map<string, string>();
  private readonly domains = new Map<string, ActionDomain[]>();
  private readonly tools: Set<string>;
  private readonly options: Options;
  constructor(options: Options) {
    validateAcquisitionPolicy(options);
    this.options = options; this.tools = new Set(options.briefTools);
    this.acquisitionPolicy = { refreshAfterProgress: options.refreshAfterProgress !== false,
      retainAcrossRequests: options.retainAcrossRequests !== false, swarmEnabled: options.swarmEnabled !== false,
      refresh: options.refresh, stepWidth: options.stepWidth, contextGrowthRatio: options.contextGrowthRatio };
  }
  isEligibleTool(name: string): boolean { return this.tools.has("*") || this.tools.has(name); }
  isExactTool(): boolean { return false; }
  isBriefTool(name: string): boolean { return this.isEligibleTool(name); }
  reset(): void { this.issued.clear(); this.generating.clear(); this.domains.clear(); }
  observeFrontier(context: SpeculativeActionsBeginContext["context"], requestIndex: number): void {
    for (const tool of context.tools ?? []) {
      if (!this.isEligibleTool(tool.name)) continue;
      const domains = this.options.deriveTools === false ? [{ id: tool.name, parameters: tool.parameters, derived: false }] :
        deriveActionDomains(tool, context.messages);
      this.domains.set(tool.name, domains);
      this.record({ event: "se_action_domains", requestIndex, toolName: tool.name,
        enabled: this.options.deriveTools !== false, swarmEnabled: this.acquisitionPolicy.swarmEnabled,
        domains: domains.map(d => ({ id: d.id, derived: d.derived, parameters: d.parameters })) });
    }
  }
  record(event: SpeculativeActionTraceEvent): void {
    if (!this.options.traceFile) return;
    mkdirSync(dirname(this.options.traceFile), { recursive: true });
    appendFileSync(this.options.traceFile, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...event }) + "\n");
  }
  beginTurn(input: SpeculativeActionsBeginContext) {
    this.observeFrontier(input.context, input.requestIndex);
    if (this.acquisitionPolicy.swarmEnabled === false) return;
    if (!input.executeCandidate) throw new Error("Perseus 0.8 requires the native SE acquisition runtime");
    const id = randomUUID(), revision = input.progressRevision ?? input.requestIndex;
    const abort = new AbortController(), cancel = () => abort.abort();
    input.signal?.addEventListener("abort", cancel, { once: true });
    if (input.signal?.aborted) cancel();
    const workers = (input.context.tools ?? []).filter(tool => this.isEligibleTool(tool.name)).flatMap(tool => {
      const domains = this.domains.get(tool.name)!;
      return domains.map(domain => ({ tool, domain }));
    }).filter(({ tool, domain }) => {
      if (this.issued.get(domain.id) === revision) return false;
      // Coalesce an unfinished generation for the same head, not its native
      // executions. Other domains start immediately; Actor boundaries never wait.
      if (this.generating.has(domain.id)) {
        this.record({ event: "se_generation_coalesced", requestIndex: input.requestIndex, turnId: id,
          toolName: tool.name, domainId: domain.id, progressRevision: revision });
        return false;
      }
      return true;
    });
    const snapshot = Promise.resolve(input.convertToLlm(structuredClone(input.context.messages))).then(preexecutionObservations)
      .then(observations => {
        if (!input.summarizeObservations) return observations;
        const summarized = summarizeObservationRecords(observations);
        this.record({ event: "se_context_summarized", requestIndex: input.requestIndex, turnId: id,
          method: "lossless_block_dictionary_or_original", originalRecords: observations.length,
          originalBytes: Buffer.byteLength(JSON.stringify(observations)),
          summarizedBytes: Buffer.byteLength(JSON.stringify(summarized)), actorHistoryChanged: false, modelCalls: 0 });
        return summarized;
      });
    const jobs = workers.map(({ tool, domain }) => {
      this.issued.set(domain.id, revision);
      this.generating.set(domain.id, id);
      const releaseGeneration = () => { if (this.generating.get(domain.id) === id) this.generating.delete(domain.id); };
      const active = this.active.get(tool.name) ?? 0;
      this.active.set(tool.name, active + 1);
      this.record({ event: "se_worker_started", requestIndex: input.requestIndex, turnId: id,
        toolName: tool.name, domainId: domain.id, derived: domain.derived, progressRevision: revision, olderWorkersRetained: active,
        thinking: this.options.thinkingLevel, runtime: "persistent-se-0.8" });
      const work = async () => {
        const context: Context = {
          systemPrompt: `Acquire missing task information using ${tool.name}. Mainline records are observations, not your pending actions. Emit independent executable acquisition calls as soon as ready. Native computation and scratch files may resolve local dependencies. Obtain interpretable source evidence, not a report, implementation or final deliverable. Return no calls if this tool cannot add information at the current frontier.`,
          messages: await snapshot,
          tools: [{ name: tool.name, description: tool.description, parameters: domain.parameters as typeof tool.parameters }],
        };
        const calls = new Map<string, Promise<unknown>>();
        const accept = (call: ToolCall) => {
          if (call.name !== tool.name || calls.has(call.id) || abort.signal.aborted) return;
          calls.set(call.id, Promise.resolve());
          let candidate: SpeculativeActionCandidate;
          try {
            const raw: SpeculativeActionCandidate = { mode: "brief", toolName: call.name,
              arguments: bindActionHead(domain, call.arguments) };
            candidate = input.prepareCandidate ? input.prepareCandidate(raw) :
              { ...raw, arguments: validateNativeArguments(tool, raw.arguments) };
          } catch (error) {
            this.record({ event: "se_invalid_arguments", requestIndex: input.requestIndex, turnId: id,
              toolName: tool.name, domainId: domain.id, arguments: call.arguments, error: String(error) });
            return;
          }
          const owners = (this.domains.get(tool.name) ?? [domain]).filter(d => {
            try { validateToolArguments({ ...tool, parameters: d.parameters as typeof tool.parameters },
              { ...call, arguments: structuredClone(candidate.arguments) }); return true; } catch { return false; }
          });
          if (owners.length !== 1) {
            this.record({ event: "se_domain_rejected", requestIndex: input.requestIndex, turnId: id,
              toolName: tool.name, domainId: domain.id, arguments: candidate.arguments, ownerCount: owners.length });
            return;
          }
          if (owners[0].id !== domain.id) this.record({ event: "se_domain_reassigned", requestIndex: input.requestIndex,
            turnId: id, toolName: tool.name, domainId: domain.id, ownerDomainId: owners[0].id, arguments: candidate.arguments });
          this.record({ event: "se_domain_dispatched", requestIndex: input.requestIndex, turnId: id,
            toolName: tool.name, domainId: domain.id, ownerDomainId: owners[0].id, arguments: candidate.arguments });
          calls.set(call.id, input.executeCandidate!(candidate, abort.signal));
        };
        this.record({ event: "se_model_started", requestIndex: input.requestIndex, turnId: id, toolName: tool.name, domainId: domain.id });
        const stream = await input.streamFn(this.options.model, context, {
          signal: abort.signal, sessionId: input.sessionId ? `${input.sessionId}:se:${domain.id}:${id}` : undefined,
          reasoning: this.options.thinkingLevel === "off" ? undefined : this.options.thinkingLevel,
        });
        for await (const event of stream) if (event.type === "toolcall_end") accept(event.toolCall);
        const response = await stream.result();
        this.record({ event: "se_model_completed", requestIndex: input.requestIndex, turnId: id, toolName: tool.name,
          domainId: domain.id, usage: response.usage, stopReason: response.stopReason, error: response.errorMessage });
        if (response.stopReason !== "error" && response.stopReason !== "aborted")
          for (const part of response.content) if (part.type === "toolCall") accept(part);
        releaseGeneration();
        // One executable frontier, not a second autonomous task-solving Actor.
        // Calls are already running. Their own native programs may resolve local
        // dependencies; later frontiers use current mainline and retained evidence.
        await Promise.all(calls.values());
      };
      return work().catch(error => this.record({ event: abort.signal.aborted ? "se_worker_cancelled" : "se_worker_failed",
        requestIndex: input.requestIndex, turnId: id, toolName: tool.name, error: String(error) }))
        .finally(() => {
          releaseGeneration();
          this.active.set(tool.name, Math.max(0, (this.active.get(tool.name) ?? 1) - 1));
          this.record({ event: "se_worker_ended", requestIndex: input.requestIndex, turnId: id, toolName: tool.name });
        });
    });
    return { id, candidates: Promise.all(jobs).then(() => [] as SpeculativeActionCandidate[]).finally(() =>
      input.signal?.removeEventListener("abort", cancel)), cancel };
  }
}
