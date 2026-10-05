#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const releaseVersion = (await readFile(new URL("../VERSION", import.meta.url), "utf8")).trim();

const agentDir = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("usage: configure-agent.mjs <agent-dir>");

const protocolAliases = new Map([
	["openai", "openai-responses"],
	["openai-responses", "openai-responses"],
	["anthropic", "anthropic-messages"],
	["anthropic-messages", "anthropic-messages"],
]);
const requestedProtocol = (process.env.PERSEUS_API_PROTOCOL || "openai")
	.trim()
	.toLowerCase();
const protocolApi = protocolAliases.get(requestedProtocol);
if (!protocolApi) {
	throw new Error(
		`Invalid PERSEUS_API_PROTOCOL: ${requestedProtocol}. Expected openai or anthropic.`,
	);
}

const actor = {
	provider: (process.env.PERSEUS_ACTOR_PROVIDER || "openai-compatible").trim().toLowerCase(),
	model: (process.env.PERSEUS_ACTOR_MODEL || "").trim(),
	baseUrl: (process.env.PERSEUS_ACTOR_BASE_URL || "").trim().replace(/\/$/, ""),
	api: (process.env.PERSEUS_ACTOR_API_TYPE || protocolApi).trim(),
	adaptiveThinking: (process.env.PERSEUS_ACTOR_ADAPTIVE_THINKING || "auto").trim().toLowerCase(),
	nativeCache: (process.env.PERSEUS_ACTOR_NATIVE_CACHE || "auto").trim().toLowerCase(),
	keyEnv: "PERSEUS_ACTOR_API_KEY",
	userAgent: (process.env.PERSEUS_ACTOR_USER_AGENT || `Perseus/${releaseVersion}`).trim(),
};
const speculator = {
	provider: (process.env.PERSEUS_SPECULATOR_PROVIDER || actor.provider).trim().toLowerCase(),
	model: (process.env.PERSEUS_SPECULATOR_MODEL || actor.model).trim(),
	baseUrl: (process.env.PERSEUS_SPECULATOR_BASE_URL || actor.baseUrl).trim().replace(/\/$/, ""),
	api: (process.env.PERSEUS_SPECULATOR_API_TYPE || actor.api).trim(),
	adaptiveThinking: (
		process.env.PERSEUS_SPECULATOR_ADAPTIVE_THINKING || actor.adaptiveThinking
	).trim().toLowerCase(),
	nativeCache: (process.env.PERSEUS_SPECULATOR_NATIVE_CACHE || actor.nativeCache).trim().toLowerCase(),
	userAgent: (process.env.PERSEUS_SPECULATOR_USER_AGENT || actor.userAgent).trim(),
	keyEnv: actor.provider === (process.env.PERSEUS_SPECULATOR_PROVIDER || actor.provider).trim().toLowerCase()
		? "PERSEUS_ACTOR_API_KEY"
		: "PERSEUS_SPECULATOR_API_KEY",
};

for (const [role, config] of [["actor", actor], ["speculator", speculator]]) {
	if (!config.model) throw new Error(`PERSEUS_${role.toUpperCase()}_MODEL is required`);
	if (!config.baseUrl) throw new Error(`PERSEUS_${role.toUpperCase()}_BASE_URL is required`);
}
if (!process.env.PERSEUS_ACTOR_API_KEY?.trim()) throw new Error("PERSEUS_ACTOR_API_KEY is required");
if (speculator.provider !== actor.provider && !process.env.PERSEUS_SPECULATOR_API_KEY?.trim()) {
	throw new Error("PERSEUS_SPECULATOR_API_KEY is required for a separate speculator provider");
}

const adaptiveThinkingPolicies = new Set(["auto", "on", "off", "true", "false", "1", "0"]);
for (const [role, config] of [["actor", actor], ["speculator", speculator]]) {
	if (!adaptiveThinkingPolicies.has(config.adaptiveThinking)) {
		throw new Error(
			`Invalid PERSEUS_${role.toUpperCase()}_ADAPTIVE_THINKING: ${config.adaptiveThinking}`,
		);
	}
	if (!adaptiveThinkingPolicies.has(config.nativeCache)) {
		throw new Error(`Invalid PERSEUS_${role.toUpperCase()}_NATIVE_CACHE: ${config.nativeCache}`);
	}
}

function thinkingFormat(config) {
	if (config.provider === "deepseek") return "deepseek";
	try {
		const hostname = new URL(config.baseUrl).hostname.toLowerCase();
		if (hostname === "deepseek.com" || hostname.endsWith(".deepseek.com")) return "deepseek";
	} catch {
		// The required base URL is validated by the provider when the request starts.
	}
	return undefined;
}

function supportsReasoning(config, requested) {
	return requested || thinkingFormat(config) !== undefined;
}

function explicitPolicy(policy) {
	if (["on", "true", "1"].includes(policy)) return true;
	if (["off", "false", "0"].includes(policy)) return false;
	return undefined;
}

function isOfficialAnthropic(config) {
	if (config.provider === "anthropic") return true;
	try {
		return new URL(config.baseUrl).hostname.toLowerCase() === "api.anthropic.com";
	} catch {
		return false;
	}
}

function knownAdaptiveAnthropicModel(config) {
	const model = config.model.toLowerCase();
	return (
		/claude-(?:opus|sonnet)-4[-.]?(?:6|7|8)(?:[-.:/]|$)/.test(model) ||
		/claude-(?:opus|sonnet|fable|mythos)-5(?:[-.:/]|$)/.test(model)
	);
}

function modelUsesAdaptiveThinking(config) {
	if (config.api !== "anthropic-messages") return false;
	const explicit = explicitPolicy(config.adaptiveThinking);
	if (explicit !== undefined) return explicit;
	return isOfficialAnthropic(config) && knownAdaptiveAnthropicModel(config);

}

function modelUsesNativeCache(config) {
	if (config.api !== "anthropic-messages") return false;
	const explicit = explicitPolicy(config.nativeCache);
	if (explicit !== undefined) return explicit;
	return isOfficialAnthropic(config);
}

function compat(config, reasoning) {
	const format = thinkingFormat(config);
	return {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: reasoning,
		maxTokensField: "max_tokens",
		supportsStrictMode: false,
		...(format ? { thinkingFormat: format } : {}),
	};
}

function modelEntry(config, requestedReasoning) {
	const reasoning = supportsReasoning(config, requestedReasoning);
	const configuredMaxTokens = Number.parseInt(process.env.PERSEUS_MAX_TOKENS || "", 10);
	return {
		id: config.model,
		name: config.model,
		api: config.api,
		baseUrl: config.baseUrl,
		input: inputModalities(config),
		reasoning,
		...(Number.isFinite(configuredMaxTokens) && configuredMaxTokens > 0
			? { maxTokens: configuredMaxTokens }
			: {}),
		contextWindow: Number.parseInt(process.env.PERSEUS_CONTEXT_WINDOW || "128000", 10),
		compat: {
			...compat(config, reasoning),
			...(modelUsesAdaptiveThinking(config) ? { forceAdaptiveThinking: true } : {}),
			...(modelUsesNativeCache(config)
				? { supportsPromptCachingScope: true }
				: {}),
		},
	};
}

function inputModalities(config) {
	const role = config === actor ? "ACTOR" : "SPECULATOR";
	const values = (process.env[`PERSEUS_${role}_INPUT`] || "text").split(",").map(v => v.trim());
	if (!values.includes("text") || values.some(v => !["text", "image"].includes(v)))
		throw new Error(`Invalid PERSEUS_${role}_INPUT; use text or text,image`);
	return [...new Set(values)];
}

const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const actorThinking = (process.env.PERSEUS_ACTOR_THINKING || "off").trim().toLowerCase();
const speculatorThinking = (process.env.PERSEUS_SPECULATOR_THINKING || "off").trim().toLowerCase();
if (!thinkingLevels.has(actorThinking)) throw new Error(`Invalid PERSEUS_ACTOR_THINKING: ${actorThinking}`);
if (!thinkingLevels.has(speculatorThinking)) {
	throw new Error(`Invalid PERSEUS_SPECULATOR_THINKING: ${speculatorThinking}`);
}
const actorReasoning = actorThinking !== "off";
const speculatorReasoning = speculatorThinking !== "off";
const providers = {};
const actorSupportsReasoning = supportsReasoning(actor, actorReasoning);
const sharedModel = speculator.provider === actor.provider && speculator.model === actor.model;
const actorProviderSupportsReasoning =
	actorSupportsReasoning ||
	(speculator.provider === actor.provider && supportsReasoning(speculator, speculatorReasoning));
providers[actor.provider] = {
	baseUrl: actor.baseUrl,
	apiKey: `$${actor.keyEnv}`,
	api: actor.api,
	headers: { "User-Agent": actor.userAgent },
	compat: compat(actor, actorProviderSupportsReasoning),
	models: [modelEntry(actor, actorReasoning || (sharedModel && speculatorReasoning))],
};
if (speculator.provider === actor.provider) {
	if (!providers[actor.provider].models.some((item) => item.id === speculator.model)) {
		providers[actor.provider].models.push(modelEntry(speculator, speculatorReasoning));
	}
} else {
	providers[speculator.provider] = {
		baseUrl: speculator.baseUrl,
		apiKey: `$${speculator.keyEnv}`,
		api: speculator.api,
		headers: { "User-Agent": speculator.userAgent },
		compat: compat(speculator, supportsReasoning(speculator, speculatorReasoning)),
		models: [modelEntry(speculator, speculatorReasoning)],
	};
}

const timeoutMs = Number.parseInt(process.env.PERSEUS_API_TIMEOUT_MS || "180000", 10);
const settings = {
	compaction: { enabled: false },
	retry: {
		provider: {
			timeoutMs,
			maxRetries: Number.parseInt(process.env.PERSEUS_API_MAX_RETRIES || "1", 10),
			maxRetryDelayMs: Number.parseInt(process.env.PERSEUS_API_MAX_RETRY_DELAY_MS || "30000", 10),
		},
	},
	httpIdleTimeoutMs: timeoutMs,
	websocketConnectTimeoutMs: Number.parseInt(process.env.PERSEUS_WEBSOCKET_CONNECT_TIMEOUT_MS || "30000", 10),
};

await mkdir(agentDir, { recursive: true });
const modelsPath = path.join(agentDir, "models.json");
const settingsPath = path.join(agentDir, "settings.json");
await writeFile(modelsPath, `${JSON.stringify({ providers }, null, 2)}\n`, { mode: 0o600 });
await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
await chmod(modelsPath, 0o600);
await chmod(settingsPath, 0o600);
await chmod(agentDir, 0o700);
