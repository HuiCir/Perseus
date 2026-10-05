import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { requestToolJson, toolResponseContent } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discloseResult, readArchive, ARCHIVE_PREFIX } from "../harness/packages/agent/src/context-disclosure.ts";

export default function (api: ExtensionAPI) {
  const manifestPath = process.env.PERSEUS_TOOL_MANIFEST;
  const endpoint = process.env.PERSEUS_TOOL_ENDPOINT?.replace(/\/+$/, "");
  if (!manifestPath || !endpoint) throw new Error("A tool manifest and endpoint are required");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const root = manifest.metadata?.workspace_root;
  const independent = manifest.metadata?.acquisition_protocol === "independent-work-copy-v1";
  const noSwarm = ["PERSEUS_SWARM_ENABLED", "PERSEUS_DUAL_FRONTIER"].some(key =>
    ["0", "off", "false"].includes(process.env[key] ?? "on"));
  if (process.env.PERSEUS_ENABLED !== "0" && !noSwarm && !independent)
    throw new Error("SE requires an independent-work-copy-v1 tool environment; authoritative execution is never used as a fallback");
  const invoke = async (tool: any, id: string, args: unknown, signal?: AbortSignal, scopeId?: string) => {
    if (tool.name === "read_file" && typeof (args as any)?.path === "string" && (args as any).path.startsWith(ARCHIVE_PREFIX)) {
      const value = await readArchive((args as any).path);
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: { contextArchivePage: true } };
    }
    const requestId = `${id}-${randomUUID()}`;
    const cancel = () => { void requestToolJson(`${endpoint}/cancel`, { request_id: requestId }).catch(() => undefined); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const payload = await requestToolJson(`${endpoint}/execute`, {
        tool: tool.name, arguments: args, request_id: requestId, speculative: !!scopeId,
        ...(scopeId ? { acquisition_scope: scopeId } : {}),
      }, { signal });
      const { read_only: _receipt, cache_observation: _identity, ...observation } = payload;
      const visible = tool.result_field && Object.hasOwn(observation, tool.result_field)
        ? observation[tool.result_field] : observation;
      const result = { ...toolResponseContent(visible), isError: payload.ok === false };
      // SE disclosure is staged by the session runtime after evidence-level dedup.
      // Mainline native outputs are archived before they can exceed one request.
      return scopeId ? result : discloseResult(result, { tool: tool.name, arguments: args, authoritative: true });
    } finally { signal?.removeEventListener("abort", cancel); }
  };
  for (const tool of manifest.tools) api.registerTool({
    name: tool.name, label: tool.name, description: tool.description,
    parameters: tool.parameters, executionMode: tool.parallel ? "parallel" : "sequential",
    prepareArguments: (raw: Record<string, unknown>) => {
      const args = { ...raw };
      if (root) for (const key of ["path", "cwd"]) {
        const schema = tool.parameters.properties?.[key];
        if (!schema || schema.type !== "string") continue;
        const value = args[key];
        if (typeof value === "string") args[key] = posix.resolve(root, value);
        else if (key === "cwd") args[key] = root;
      }
      return args;
    },
    openAcquisition: independent ? async (id: string, signal: AbortSignal) => {
      const close = async () => {
        const response = await requestToolJson(`${endpoint}/acquisition/close`, { scope_id: id });
        if (!response.ok) throw new Error(response.error || "Acquisition cleanup failed");
      };
      try {
        // Opening is settled even after cancellation so an allocated copy cannot be orphaned.
        const response = await requestToolJson(`${endpoint}/acquisition/open`, { scope_id: id });
        if (!response.ok) throw new Error(response.error || "Acquisition snapshot failed");
        if (signal.aborted) throw new Error("Acquisition cancelled during snapshot");
        if (response.provenance?.scopeId !== id) throw new Error("Acquisition scope identity mismatch");
        return { provenance: response.provenance, close,
          execute: (callId: string, args: unknown, callSignal?: AbortSignal) => invoke(tool, callId, args, callSignal, id) };
      } catch (error) {
        await close();
        throw error;
      }
    } : undefined,
    execute: (id: string, args: unknown, signal?: AbortSignal) => invoke(tool, id, args, signal),
  });
}
