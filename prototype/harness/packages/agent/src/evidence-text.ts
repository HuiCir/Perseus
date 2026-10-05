/** Compare actual string values as well as envelopes; JSON escaping is not evidence. */
export function structuredEvidenceText(value: unknown): string {
	const text = new Set<string>();
	const visited = new WeakSet<object>();
	const pending: unknown[] = [value];
	if (value && typeof value === "object") {
		try { text.add(JSON.stringify(value)); } catch { /* Traverse cyclic values below. */ }
	}
	while (pending.length) {
		const item = pending.pop();
		if (typeof item === "string") {
			if (text.has(item) && item !== value) continue;
			text.add(item);
			const first = item.trimStart()[0];
			if (first === "{" || first === "[") {
				try { pending.push(JSON.parse(item)); } catch { /* Ordinary text stays intact. */ }
			}
		} else if (item && typeof item === "object" && !visited.has(item)) {
			visited.add(item);
			for (const child of Object.values(item)) pending.push(child);
		}
	}
	return [...text].join("\n");
}

/** Transport framing is not new evidence when the complete command output is known. */
export function commandOutputAlreadyObserved(value: string, observed: string): boolean {
	let body: unknown;
	try { body = JSON.parse(value); } catch { return false; }
	if (!body || typeof body !== "object" || Array.isArray(body)) return false;
	let record = body as Record<string, unknown>;
	if ("result" in record) {
		if (record.ok !== true || Object.keys(record).some(k => k !== "ok" && k !== "result")) return false;
		body = record.result;
		if (!body || typeof body !== "object" || Array.isArray(body)) return false;
		record = body as Record<string, unknown>;
	}
	if (record.returncode !== 0 || typeof record.stdout !== "string" || typeof record.stderr !== "string" ||
		Object.keys(record).some(k => !["returncode", "stdout", "stderr"].includes(k))) return false;
	const normalize = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim();
	const output = [record.stdout, record.stderr].map(normalize).filter(Boolean);
	// Empty output and arbitrary structured records retain their invocation identity.
	return output.length > 0 && output.every(part => normalize(observed).includes(part));
}
