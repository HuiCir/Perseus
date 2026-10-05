import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldThread } from "node:timers/promises";

export const ARCHIVE_PREFIX = "/__perseus_context__/";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
export function disclosureBudget(): number {
  const value = Number(process.env.PERSEUS_DISCLOSURE_BYTES ?? 16384);
  if (!Number.isSafeInteger(value) || value < 1024) throw new Error("Invalid disclosure representation budget");
  return value;
}
function vault(): string {
  const state = process.env.PERSEUS_STATE_DIR;
  if (!state) throw new Error("Persistent state directory required for lossless disclosure");
  return join(state, "context-archive");
}
async function put(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, path);
}
type Link = { read_file: string; firstPart: number; lastPart: number; bytes: number; firstSource?: unknown; lastSource?: unknown };

/** Full original plus a lossless paged view. Budgets change presentation, never stored evidence. */
export async function archiveContent(content: unknown, provenance: unknown): Promise<any[]> {
  const raw = JSON.stringify(content), id = hash(raw), directory = join(vault(), id);
  await mkdir(directory, { recursive: true });
  await put(join(directory, "original.json"), content);
  const budget = disclosureBudget(), parts: string[] = [];
  let part = "", size = 0;
  let processed = 0;
  // Explicit fragments, not purported complete or truncated tool output. Unicode
  // code points survive; concatenating every fragment recovers original JSON exactly.
  for (const character of raw) {
    const n = Buffer.byteLength(character);
    if (size + n > budget && part) { parts.push(part); part = ""; size = 0; }
    part += character; size += n;
    if (++processed % 65536 === 0) await yieldThread();
  }
  if (part) parts.push(part);
  const rootPrefix = `${ARCHIVE_PREFIX}${id}/`;
  let links: Link[] = [];
  for (let i = 0; i < parts.length; i++) {
    const name = `part-${i}.json`;
    await put(join(directory, name), { kind: "verbatim_json_fragment", original_sha256: id,
      part: i, parts: parts.length, reconstruction: "Concatenate text in part order, then JSON.parse; no bytes omitted", text: parts[i] });
    links.push({ read_file: rootPrefix + name, firstPart: i, lastPart: i, bytes: Buffer.byteLength(parts[i]) });
    if (i % 16 === 0) await yieldThread();
  }
  let level = 0;
  while (links.length > 8) {
    const next: Link[] = [];
    for (let i = 0; i < links.length; i += 8) {
      const children = links.slice(i, i + 8), name = `index-${level}-${i / 8}.json`;
      await put(join(directory, name), { kind: "archive_index", children });
      next.push({ read_file: rootPrefix + name, firstPart: children[0].firstPart,
        lastPart: children.at(-1)!.lastPart, bytes: children.reduce((n, c) => n + c.bytes, 0) });
    }
    links = next; level++;
  }
  // Known structured evidence receives independently readable record pages in
  // addition to the exact raw archive. Selection never needs to parse a fragment.
  let records: any[] | undefined;
  if (Array.isArray(content)) for (const item of content) {
    if (item?.type !== "text") continue;
    try {
      const value = JSON.parse(item.text);
      if (Array.isArray(value.units)) records = value.units;
    } catch { /* Opaque native text keeps its lossless raw representation. */ }
  }
  let recordLinks: Link[] = [];
  let oversizedRecords = 0;
  if (records) {
    let group: any[] = [], used = 0, first = 0;
    const flush = async () => {
      if (!group.length) return;
      const name = `records-${first}.json`;
      await put(join(directory, name), { kind: "complete_evidence_records", records: group });
      recordLinks.push({ read_file: rootPrefix + name, firstPart: first, lastPart: first + group.length - 1,
        bytes: used, firstSource: group[0].location, lastSource: group.at(-1).location });
      first += group.length; group = []; used = 0;
    };
    for (const record of records) {
      const n = bytes(record);
      if (used + n > budget) await flush();
      if (n > budget) {
        // Large indivisible records remain reachable in the complete original.
        await flush(); first++; oversizedRecords++; continue;
      }
      group.push(record); used += n;
    }
    await flush();
    let recordLevel = 0;
    while (recordLinks.length > 8) {
      const next: Link[] = [];
      for (let i = 0; i < recordLinks.length; i += 8) {
        const children = recordLinks.slice(i, i + 8), name = `records-index-${recordLevel}-${i / 8}.json`;
        await put(join(directory, name), { kind: "evidence_record_index", children });
        next.push({ read_file: rootPrefix + name, firstPart: children[0].firstPart, lastPart: children.at(-1)!.lastPart,
          bytes: children.reduce((n,c) => n+c.bytes,0), firstSource: children[0].firstSource, lastSource: children.at(-1)!.lastSource });
      }
      recordLinks = next; recordLevel++;
    }
  }
  const summary = { kind: "progressive_tool_evidence", original_sha256: id, original_bytes: Buffer.byteLength(raw),
    original_preserved: true, provenance, parts: parts.length, children: links,
    structured_records: records?.length, records_in_original_only: oversizedRecords, record_children: recordLinks,
    interpretation: "Archive index, not a finding or completed task. Read relevant pages with the existing read_file tool. Child pages preserve original JSON verbatim." };
  // Content-addressed index is neutral: identical bytes from different executions
  // must not overwrite each other's authoritative/work-copy provenance.
  await put(join(directory, "index.json"), { ...summary, provenance: undefined });
  return [{ type: "text", text: JSON.stringify({ ...summary, read_file: rootPrefix + "index.json" }) }];
}

export async function readArchive(path: unknown): Promise<any | undefined> {
  if (typeof path !== "string" || !path.startsWith(ARCHIVE_PREFIX)) return;
  const match = path.slice(ARCHIVE_PREFIX.length).match(/^([a-f0-9]{64})\/(index(?:-\d+-\d+)?|part-\d+|records-\d+|records-index-\d+-\d+)\.json$/);
  if (!match) throw new Error("Invalid archive reference; original blobs are accessed through lossless pages");
  return JSON.parse(await readFile(join(vault(), match[1], match[2] + ".json"), "utf8"));
}

export async function discloseResult(result: any, provenance: unknown): Promise<any> {
  const text = result.content.filter((b: any) => b.type === "text");
  if (bytes(text) <= disclosureBudget()) return result;
  const content = [...await archiveContent(text, provenance), ...result.content.filter((b: any) => b.type !== "text")];
  return { ...result, content, details: { ...result.details, contextArchive: true, contextOriginalContent: result.content } };
}

/** Immutable derived view: preserve instructions, assistant actions, IDs and tool-result pairs. */
export class AsyncContextView {
  private replacements = new Map<string, any[]>();
  private pending?: { epoch: number; ready?: Map<string, any[]>; error?: unknown };
  private epoch = 0;
  schedule(messages: any[], window: number): void {
    if (this.pending) return;
    const ratio = Number(process.env.PERSEUS_CONTEXT_COMPACT_RATIO ?? 0.5);
    if (!(ratio > 0 && ratio < 1)) throw new Error("Invalid context compaction ratio");
    // UTF-8 serialized bytes conservatively trigger work, not reported token usage.
    if (bytes(this.view(messages).map(m => ({ role: m.role, content: m.content, toolCallId: m.toolCallId }))) < window * ratio) return;
    const job: { epoch: number; ready?: Map<string, any[]>; error?: unknown } = { epoch: this.epoch };
    this.pending = job;
    const snapshot = structuredClone(messages);
    void (async () => {
      const replacements = new Map<string, any[]>();
      for (const message of snapshot) {
        if (message.role !== "toolResult" && !message.perseusEvidence) continue;
        if (message.content?.some((b: any) => b.type !== "text")) continue;
        if (!message.content || bytes(message.content) <= 1024) continue;
        const key = hash(JSON.stringify(message.content));
        if (this.replacements.has(key)) continue;
        const compact = await archiveContent(message.content, { kind: "mainline_compaction",
          role: message.role, toolCallId: message.toolCallId, toolName: message.toolName });
        if (bytes(compact) < bytes(message.content)) replacements.set(key, compact);
        await yieldThread();
      }
      if (job.epoch === this.epoch) job.ready = replacements;
    })().catch(error => { job.error = error; });
  }
  commit(): { changed: number; error?: string } {
    if (this.pending?.error) { const error = String(this.pending.error); this.pending = undefined; return { changed: 0, error }; }
    if (!this.pending?.ready) return { changed: 0 };
    const ready = this.pending.ready; this.pending = undefined;
    for (const [key, content] of ready) this.replacements.set(key, content);
    return { changed: ready.size };
  }
  view(messages: any[]): any[] {
    return messages.map(message => {
      if (!message.content) return message;
      const content = this.replacements.get(hash(JSON.stringify(message.content)));
      return content ? { ...message, content } : message;
    });
  }
  reset(): void { this.epoch++; this.pending = undefined; this.replacements.clear(); }
}
