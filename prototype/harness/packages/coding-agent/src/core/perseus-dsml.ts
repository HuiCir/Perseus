/** Strict decoder for the model's native DSML invocation envelope, not XML/HTML. */
const marker = "\uFF5C\uFF5CDSML\uFF5C\uFF5C";
const open = `<${marker}tool_calls>`;
const close = `</${marker}tool_calls>`;
const invoke = `<${marker}invoke name=`;
const endInvoke = `</${marker}invoke>`;
const parameter = `<${marker}parameter name=`;
const endParameter = `</${marker}parameter>`;

export function isDsmlInvocationEnvelope(raw: string): boolean {
	return raw.trimStart().startsWith(`<${marker}`);
}

export function decodeDsmlInvocations(raw: string, streaming = false): {
	complete: boolean;
	candidates: { tool: string; arguments: Record<string, unknown>; objective: string }[];
} | undefined {
	let offset = 0;
	const candidates: { tool: string; arguments: Record<string, unknown>; objective: string }[] = [];
	const whitespace = () => { while (/\s/.test(raw[offset] ?? "")) offset++; };
	const token = (value: string) => {
		if (!raw.startsWith(value, offset)) return false;
		offset += value.length;
		return true;
	};
	const quoted = (): string | undefined => {
		if (raw[offset] !== '"') return undefined;
		const start = offset++;
		let escaped = false;
		while (offset < raw.length) {
			const char = raw[offset++];
			if (escaped) { escaped = false; continue; }
			if (char === "\\") { escaped = true; continue; }
			if (char === '"') {
				try { return JSON.parse(raw.slice(start, offset)); } catch { return undefined; }
			}
		}
		return undefined;
	};
	const unfinished = () => streaming ? { complete: false, candidates } : undefined;
	whitespace();
	if (!token(open)) return undefined;
	for (;;) {
		whitespace();
		if (token(close)) {
			whitespace();
			return offset === raw.length ? { complete: true, candidates } : undefined;
		}
		if (!token(invoke)) return unfinished();
		const tool = quoted();
		if (!tool || !token(">")) return unfinished();
		const args: Record<string, unknown> = Object.create(null);
		for (;;) {
			whitespace();
			if (token(endInvoke)) break;
			if (!token(parameter)) return unfinished();
			const name = quoted();
			if (!name || Object.hasOwn(args, name) || !token(" string=")) return unfinished();
			const string = quoted();
			if ((string !== "true" && string !== "false") || !token(">")) return unfinished();
			const end = raw.indexOf(endParameter, offset);
			if (end < 0) return unfinished();
			const body = raw.slice(offset, end);
			try { args[name] = string === "true" ? body : JSON.parse(body); }
			catch { return unfinished(); }
			offset = end + endParameter.length;
		}
		candidates.push({ tool, arguments: args,
			objective: "Report the new observations from this invocation." });
	}
}
