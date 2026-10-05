import { createHash } from "node:crypto";
import type { AgentContext } from "./types.ts";
import { canonical, isEvidenceMessage } from "./evidence-ledger.ts";

export interface AcquisitionPolicy {
  swarmEnabled?: boolean;
  refreshAfterProgress?: boolean;
  retainAcrossRequests?: boolean;
  refresh?: "continuous" | "initial" | "steps" | "context";
  stepWidth?: number;
  contextGrowthRatio?: number;
}

export function validateAcquisitionPolicy(policy: AcquisitionPolicy): void {
  if (policy.refresh && !["continuous", "initial", "steps", "context"].includes(policy.refresh))
    throw new Error("Unknown SE refresh policy");
  if (policy.stepWidth !== undefined && (!Number.isSafeInteger(policy.stepWidth) || policy.stepWidth < 1))
    throw new Error("SE step width must be a positive safe integer");
  if (policy.contextGrowthRatio !== undefined && (!Number.isFinite(policy.contextGrowthRatio) || policy.contextGrowthRatio <= 0))
    throw new Error("SE context growth ratio must be positive and finite");
}

/** A trigger is permission to launch work, never permission to discard history or wait. */
export class AcquisitionSchedule {
  private launched = false;
  private stepAnchor = 0;
  private informationAnchor = 0;
  private baseline = 1;
  private revisionAnchor = -1;
  reset(): void { this.launched = false; }

  evaluate(context: AgentContext, policy: AcquisitionPolicy, revision: number) {
    const authoritative = context.messages.filter(m => !isEvidenceMessage(m));
    const completedIds = new Set(authoritative.flatMap(m => m.role === "toolResult" ? [m.toolCallId] : []));
    const completedSteps = authoritative.filter(m => m.role === "assistant" &&
      m.stopReason !== "error" && m.stopReason !== "aborted" &&
      m.content.every(p => p.type !== "toolCall" || completedIds.has(p.id))).length;
    const facts = new Set<string>();
    // Binary transport size is not language context. Count an image's identity,
    // not base64 characters; the full native image remains in the real request.
    const information = (content: unknown): unknown => Array.isArray(content) ? content.map(b =>
      b?.type === "image" ? { type: "image", mimeType: b.mimeType,
        sha256: createHash("sha256").update(Buffer.from(b.data, "base64")).digest("hex") } : b) : content;
    for (const m of authoritative) {
      const observation = (m as any).perseusObservation;
      if (observation) facts.add(canonical([observation.tool, observation.arguments, observation.isError, information(observation.content)]));
      else if (m.role === "toolResult") facts.add(canonical([m.toolName, m.isError, information(m.content)]));
    }
    const bytes = (s: string) => new TextEncoder().encode(s).length;
    const informationBytes = [...facts].reduce((sum, fact) => sum + bytes(fact), 0);
    const taskBytes = bytes(canonical([context.systemPrompt,
      authoritative.flatMap(m => m.role === "user" ? [information(m.content)] : []),
      context.tools?.map(t => [t.name, t.description, t.parameters])]));
    const strategy = policy.refresh ?? (policy.refreshAfterProgress === false ? "initial" : "continuous");
    const stepWidth = policy.stepWidth ?? 4, contextGrowthRatio = policy.contextGrowthRatio ?? 1;
    const elapsedSteps = completedSteps - this.stepAnchor;
    const growthBytes = Math.max(0, informationBytes - this.informationAnchor);
    const growthRatio = growthBytes / this.baseline;
    const progress = revision !== this.revisionAnchor;
    const reason = policy.swarmEnabled === false ? "swarm_disabled" : !this.launched ? "initial" :
      !progress ? "no_new_progress" : strategy === "initial" ? "initial_only" :
      strategy === "continuous" ? "progress" : strategy === "steps" ?
        elapsedSteps >= stepWidth ? "step_width" : "step_interval_pending" :
        growthRatio >= contextGrowthRatio ? "context_growth" : "context_growth_pending";
    const launch = ["initial", "progress", "step_width", "context_growth"].includes(reason);
    const decision = { launch, reason, strategy, completedSteps, elapsedSteps, stepWidth,
      informationBytes, growthBytes, baselineBytes: this.baseline, growthRatio, contextGrowthRatio,
      progressRevision: revision, summarizeObservations: launch && strategy === "context",
      informationMeasure: "unique_native_records_with_image_identity", baselinePolicy: "task_and_tool_contract" };
    if (launch) {
      this.launched = true; this.stepAnchor = completedSteps; this.informationAnchor = informationBytes;
      // Repeated refreshes must not require exponentially more history. This
      // schedules acquisition; it neither limits nor discards accumulated context.
      this.baseline = Math.max(1, taskBytes); this.revisionAnchor = revision;
      if (reason === "initial") decision.baselineBytes = this.baseline;
    }
    return decision;
  }
}
