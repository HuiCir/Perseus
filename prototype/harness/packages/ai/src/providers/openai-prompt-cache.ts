export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

const COMPACT_HASH_LENGTH = 16;

function promptCacheKeyFingerprint(key: string): string {
	const bytes = new TextEncoder().encode(key);
	let hash = 0xcbf29ce484222325n;
	for (const byte of bytes) {
		hash ^= BigInt(byte);
		hash = BigInt.asUintN(64, hash * 0x100000001b3n);
	}
	return hash.toString(16).padStart(COMPACT_HASH_LENGTH, "0");
}

export function clampOpenAIPromptCacheKey(
	key: string | undefined,
): string | undefined {
	if (key === undefined) return undefined;
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;

	const fingerprint = promptCacheKeyFingerprint(key);
	const visibleLength =
		OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH - fingerprint.length - 2;
	const prefixLength = Math.ceil(visibleLength / 2);
	const suffixLength = Math.floor(visibleLength / 2);
	return `${chars.slice(0, prefixLength).join("")}~${fingerprint}~${chars
		.slice(-suffixLength)
		.join("")}`;
}
