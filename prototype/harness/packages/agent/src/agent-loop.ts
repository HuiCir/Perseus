/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	type Message,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { performance } from "node:perf_hooks";
import { prepareNativeArguments } from "./tool-arguments.ts";
import { SpeculativeSessionRuntime, type ActiveSpeculativeTurn } from "./se-runtime.ts";
import type { Observation } from "./evidence-ledger.ts";
export { SpeculativeSessionRuntime } from "./se-runtime.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
	sessionRuntime?: SpeculativeSessionRuntime,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(
		currentContext,
		newMessages,
		config,
		signal,
		emit,
		streamFn,
		sessionRuntime,
	);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
	sessionRuntime?: SpeculativeSessionRuntime,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(
		currentContext,
		newMessages,
		config,
		signal,
		emit,
		streamFn,
		sessionRuntime,
	);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
	sessionRuntime?: SpeculativeSessionRuntime,
): Promise<void> {
	const ownsRuntime = sessionRuntime === undefined;
	const speculativeRuntime =
		sessionRuntime ??
		new SpeculativeSessionRuntime(initialConfig.maxParallelToolCalls ?? 10);
	speculativeRuntime.bindScope(initialContext, initialConfig);
	speculativeRuntime.beginAgentRun();
	const abortSpeculativeRuntime = () => {
		if (ownsRuntime) speculativeRuntime.close();
		else speculativeRuntime.reset("agent_run_aborted");
	};
	signal?.addEventListener("abort", abortSpeculativeRuntime, { once: true });
	let settled = false;
	try {
		await runLoopWithRuntime(
			initialContext,
			newMessages,
			initialConfig,
			signal,
			emit,
			streamFn,
			speculativeRuntime,
		);
		settled = true;
	} finally {
		signal?.removeEventListener("abort", abortSpeculativeRuntime);
		let retain = false;
		try {
			let last: AssistantMessage | undefined;
			for (let i = newMessages.length - 1; i >= 0; i--) {
				const message = newMessages[i];
				if (message.role === "assistant") { last = message; break; }
			}
			retain = !ownsRuntime && settled && !signal?.aborted && last?.role === "assistant" &&
				last.stopReason === "error" && initialConfig.shouldRetainSpeculationForRetry?.(last) === true;
		} finally {
			if (retain) speculativeRuntime.retainForRetry();
			else speculativeRuntime.endRun("actor_run_finished");
			if (ownsRuntime) speculativeRuntime.close();
			if (!retain) await speculativeRuntime.settleAcquisitions();
		}
	}
}

async function runLoopWithRuntime(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn: StreamFn | undefined,
	speculativeRuntime: SpeculativeSessionRuntime,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] =
		(await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			const requestIndex = speculativeRuntime.nextRequestIndex();
			// Only completed deltas enter ordinary persistent history. Nothing here
			// waits for a pending tool or a speculative model request.
			for (const evidence of speculativeRuntime.prepareEvidence(requestIndex, currentContext)) {
				currentContext.messages.push(evidence);
				newMessages.push(evidence);
				await emit({ type: "message_start", message: evidence });
				await emit({ type: "message_end", message: evidence });
			}
			// Stream assistant response
			const streamed = await streamAssistantResponse(
				currentContext,
				config,
				signal,
				emit,
				streamFn,
				requestIndex,
				speculativeRuntime,
			);
			const message = streamed.message;
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				streamed.speculativeTurn?.actorResolved(message);
				streamed.speculativeTurn?.close();
				await emit({ type: "turn_end", message, toolResults: [] });
				// A host-owned retry may keep acquisition alive without changing the
				// Actor transcript. Explicit cancellation always ends that trajectory.
				if (message.stopReason === "aborted")
					speculativeRuntime.reset("actor_response_aborted");
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			streamed.speculativeTurn?.actorResolved(message);

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				const executedToolBatch = await executeToolCalls(
					currentContext,
					message,
					config,
					signal,
					emit,
					streamed.speculativeTurn,
					speculativeRuntime,
				);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}
			streamed.speculativeTurn?.close();

			await emit({ type: "turn_end", message, toolResults });

			const nextTurnContext = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
			if (nextTurnSnapshot) {
				currentContext = nextTurnSnapshot.context ?? currentContext;
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					reasoning:
						nextTurnSnapshot.thinkingLevel === undefined
							? config.reasoning
							: nextTurnSnapshot.thinkingLevel === "off"
								? undefined
								: nextTurnSnapshot.thinkingLevel,
				};
			}

			if (
				await config.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
				})
			) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
	requestIndex = 0,
	speculativeRuntime = new SpeculativeSessionRuntime(),
): Promise<StreamedAssistantResponse> {
	// The compact view is read-only input. Streaming must still append to the
	// authoritative history, which the next turn and tool results share.
	const managedContext = speculativeRuntime.manageContext(context, config);
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = managedContext.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);
	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;
	const speculativeContext =
		messages === context.messages ? context : { ...context, messages };
	const speculativeTurn = startSpeculativeTurn(
		speculativeContext,
		config,
		streamFunction,
		signal,
		requestIndex,
		speculativeRuntime,
	);

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey
			? await config.getApiKey(config.model.provider)
			: undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		if (event.type === "toolcall_end") {
			const preceding = event.partial.content.slice(0, event.contentIndex).filter((part) => part.type === "toolCall");
			if (config.speculativeActions?.acquisitionPolicy?.swarmEnabled !== false)
				speculativeTurn?.actorHead(event.toolCall, preceding);
		}
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return { message: finalMessage, speculativeTurn };
			}
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return { message: finalMessage, speculativeTurn };
}


type StreamedAssistantResponse = {
	message: AssistantMessage;
	speculativeTurn?: ActiveSpeculativeTurn;
};

type ToolCallClassification = { tool?: AgentTool<any>; preparedToolCall?: AgentToolCall; args?: unknown };
function startSpeculativeTurn(context: AgentContext, config: AgentLoopConfig, fn: StreamFn,
  signal: AbortSignal | undefined, index: number, runtime: SpeculativeSessionRuntime): ActiveSpeculativeTurn | undefined {
  return runtime.start(context, config, fn, signal, index);
}
async function executeToolCalls(context: AgentContext, message: AssistantMessage, config: AgentLoopConfig,
  signal: AbortSignal | undefined, emit: AgentEventSink, turn?: ActiveSpeculativeTurn,
  runtime = new SpeculativeSessionRuntime()): Promise<{ messages: ToolResultMessage[]; terminate: boolean }> {
  const calls = message.content.filter(c => c.type === "toolCall");
  const completed: FinalizedToolCallOutcome[] = [];
  const messages: ToolResultMessage[] = [];
  const start = async (call: AgentToolCall): Promise<FinalizedToolCallOutcome> => {
    const started = performance.timeOrigin + performance.now();
    await emit({ type:"tool_execution_start", toolCallId:call.id, toolName:call.name, args:call.arguments });
    const p = await prepareToolCall(context, message, call, config, signal);
    if (p.kind === "immediate") return { toolCall: call, result:p.result, isError:p.isError };
    const run = (s?: AbortSignal) => executePreparedToolCall(p, s, emit);
    const outcome = await run(signal);
    const finalized = await finalizeExecutedToolCall(context, message, p, outcome, config, signal);
    finalized.observation = { id: `actor-${call.id}`, tool: call.name, arguments: p.args as Record<string, unknown>,
      content: structuredClone(finalized.result.details?.contextArchive && Array.isArray(finalized.result.details.contextOriginalContent)
        ? finalized.result.details.contextOriginalContent : finalized.result.content), isError: finalized.isError,
      start: started, end: performance.timeOrigin + performance.now() };
    return finalized;
  };
  const commit = async (p: Promise<FinalizedToolCallOutcome>) => {
    const outcome = await p;
    if (turn) runtime.observe(turn, outcome);
    await emitToolExecutionEnd(outcome, emit);
    const result = createToolResultMessage(outcome);
    await emitToolResultMessage(result, emit);
    completed.push(outcome); messages.push(result);
  };
  // Normal Actor batch order is preserved. Speculators never own a mainline barrier.
  let pending: Promise<FinalizedToolCallOutcome>[] = [];
  for (const call of calls) {
    const tool = context.tools?.find(t => t.name === call.name);
    const parallel = config.speculativeActions?.acquisitionPolicy?.swarmEnabled !== false &&
      config.toolExecution !== "sequential" && tool?.executionMode === "parallel";
    if (!parallel) { for (const p of pending) await commit(p); pending = []; await commit(start(call)); }
    else pending.push(start(call));
  }
  for (const p of pending) await commit(p);
  return { messages, terminate: completed.length > 0 && completed.every(c => c.result.terminate === true) };
}

function stableJson(value: unknown): string {
	if (Array.isArray(value))
		return `[${value.map((item) => stableJson(item)).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(
			([left], [right]) => left.localeCompare(right),
		);
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
	observation?: Observation;
};

function prepareToolCallArguments(
	tool: AgentTool<any>,
	toolCall: AgentToolCall,
): AgentToolCall {
	const preparedArguments = prepareNativeArguments(tool, toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	classification?: ToolCallClassification,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool =
		classification?.tool ??
		currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall =
			classification?.preparedToolCall ??
			prepareToolCallArguments(tool, toolCall);
		const validatedArgs =
			classification?.args ?? validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(
						beforeResult.reason || "Tool execution was blocked",
					),
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(
				error instanceof Error ? error.message : String(error),
			),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	if (signal?.aborted) {
		return {
			result: createErrorToolResult("Operation aborted before dispatch"),
			isError: true,
		};
	}

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		await Promise.all(updateEvents);
		return { result, isError: result.isError === true };
	} catch (error) {
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(
				error instanceof Error ? error.message : String(error),
			),
			isError: true,
		};
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(
				error instanceof Error ? error.message : String(error),
			);
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(
	finalized: FinalizedToolCallOutcome,
	emit: AgentEventSink,
): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(
	finalized: FinalizedToolCallOutcome,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: finalized.result.content,
		details: finalized.result.details,
		isError: finalized.isError,
		timestamp: Date.now(),
		...(finalized.observation ? { perseusObservation: finalized.observation } : {}),
	};
}

async function emitToolResultMessage(
	toolResultMessage: ToolResultMessage,
	emit: AgentEventSink,
): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
