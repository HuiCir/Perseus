import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: () => ExtensionContext,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		openAcquisition: definition.openAcquisition,
		speculativeHead: definition.speculativeHead,
		executionMode: definition.executionMode,
		speculativeCapabilities: definition.speculativeCapabilities,
		executeReadOnly: definition.executeReadOnly ? (id, params, signal, update) =>
			definition.executeReadOnly!(id, params, signal, update, ctxFactory?.() as ExtensionContext) : undefined,
		execute: (toolCallId, params, signal, onUpdate) =>
			definition.execute(
				toolCallId,
				params,
				signal,
				onUpdate,
				ctxFactory?.() as ExtensionContext,
			),
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
): AgentTool<any>[] {
	return definitions.map((definition) =>
		wrapToolDefinition(definition, ctxFactory),
	);
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(
	tool: AgentTool<any>,
): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		prepareArguments: tool.prepareArguments,
		openAcquisition: tool.openAcquisition,
		speculativeHead: tool.speculativeHead,
		executionMode: tool.executionMode,
		speculativeCapabilities: tool.speculativeCapabilities,
		executeReadOnly: tool.executeReadOnly ? (id, params, signal, update) =>
			tool.executeReadOnly!(id, params, signal, update) : undefined,
		execute: async (toolCallId, params, signal, onUpdate) =>
			tool.execute(toolCallId, params, signal, onUpdate),
	};
}
