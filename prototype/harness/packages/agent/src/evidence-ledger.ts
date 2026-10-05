import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";

export interface Observation {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  start: number;
  end: number;
  version?: number;
  environment?: { kind: "independent_work_copy"; scopeId: string; authoritative: false;
    snapshotStartedAt: number; snapshotFinishedAt: number };
}
export interface EvidenceUnit {
  source: Record<string, unknown>;
  location: unknown;
  value: unknown;
  pointer: string;
  kind: string;
}
export interface EvidenceDecision {
  kind: string;
  location: unknown;
  reason: string;
  knownFrom?: string[];
  concurrentConflicts?: string[];
}
export type EvidenceMessage = UserMessage & {
  perseusEvidence: { observation: Observation; units: EvidenceUnit[] };
};
export const isEvidenceMessage = (message: unknown): message is EvidenceMessage =>
  !!message && typeof message === "object" && "perseusEvidence" in message;

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const address = (unit: EvidenceUnit) => canonical([unit.source, unit.location, unit.kind]);

/** Ambiguous JSON, duplicate keys and lossy numbers remain complete native text. */
export function parseExactJson(text: string): unknown {
  const value = JSON.parse(text);
  const tokens = (s: string) => s.match(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g);
  if (canonical(tokens(text)) !== canonical(tokens(JSON.stringify(value)))) throw new Error("Non-lossless JSON");
  return value;
}
function httpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}
function relation(a: Observation, b: Observation): "same" | "newer" | "older" | "overlap" {
  if (a.id === b.id) return "same";
  if (a.version !== undefined && b.version !== undefined)
    return a.version === b.version ? "overlap" : a.version > b.version ? "newer" : "older";
  if (a.start >= b.end) return "newer";
  if (a.end <= b.start) return "older";
  return "overlap";
}

/** Complete source-identified records, never model-written summaries or substrings. */
class Extractor {
  readonly documents = new Map<string, Record<string, unknown>>();
  readonly aliases = new Map<string, string | false>();
  payload(o: Observation): unknown {
    if (o.content.length !== 1 || o.content[0].type !== "text") return o.content;
    let value: unknown = o.content[0].text;
    try { value = parseExactJson(value as string); } catch { return value; }
    // Only unwrap transport envelopes with no additional semantic fields.
    if (record(value) && typeof value.ok === "boolean" && "result" in value &&
      Object.keys(value).every(k => ["ok", "result", "state_version"].includes(k))) value = value.result;
    if (record(value) && typeof value.stdout === "string" && !value.stderr &&
      (value.returncode === undefined || value.returncode === 0) &&
      Object.keys(value).every(k => ["stdout", "stderr", "returncode"].includes(k))) value = value.stdout;
    if (typeof value === "string") { try { return parseExactJson(value); } catch { return value; } }
    return value;
  }
  document(o: Observation, v: Record<string, any>): Record<string, unknown> | undefined {
    if (!httpUrl(o.arguments.url)) return;
    const url = new URL(o.arguments.url); url.search = ""; url.hash = "";
    let normalized: string;
    try { normalized = decodeURIComponent(url.href); } catch { return; }
    if (typeof v.spreadsheetId === "string") {
      const marker = `/spreadsheets/${v.spreadsheetId}`;
      const pos = normalized.indexOf(marker);
      if (pos < 0 || (normalized[pos + marker.length] && !"/:".includes(normalized[pos + marker.length]))) return;
      const doc = normalized.slice(0, pos + marker.length);
      const source = { tool: o.tool, document_url: doc, document_id: v.spreadsheetId };
      this.documents.set(canonical([o.tool, doc]), source); return source;
    }
    for (const source of this.documents.values())
      if (source.tool === o.tool && normalized.startsWith(`${source.document_url}/values/`)) return source;
  }
  register(o: Observation): void {
    const v = this.payload(o);
    if (!record(v)) return;
    const source = this.document(o, v);
    if (!source || !Array.isArray(v.sheets)) return;
    for (const sheet of v.sheets) {
      const p = sheet?.properties;
      if (!record(p) || p.sheetId === undefined || typeof p.title !== "string") continue;
      this.aliases.set(canonical([source, String(p.sheetId)]), String(p.sheetId));
      const key = canonical([source, p.title]);
      const old = this.aliases.get(key);
      this.aliases.set(key, old === undefined || old === String(p.sheetId) ? String(p.sheetId) : false);
    }
  }
  resolve(source: Record<string, unknown>): Record<string, unknown> {
    if (!("sheet" in source)) return source;
    const { sheet, ...base } = source;
    const resolved = this.aliases.get(canonical([base, sheet]));
    return { ...base, sheet: resolved === undefined || resolved === false ? sheet : resolved };
  }
  table(o: Observation, source: Record<string, unknown>, v: unknown, pointer: string): EvidenceUnit[] | undefined {
    if (!record(v) || !Array.isArray(v.values) || !v.values.every(Array.isArray) || typeof v.range !== "string" ||
      (v.majorDimension !== undefined && v.majorDimension !== "ROWS")) return;
    let tab = v.range, row = 1, col = 1;
    const split = tab.lastIndexOf("!");
    const cellPattern = /^\$?([A-Za-z]+)\$?([1-9][0-9]*)(?::\$?[A-Za-z]+\$?[1-9][0-9]*)?$/;
    if (split >= 0) {
      const match = tab.slice(split + 1).match(cellPattern);
      if (!match) return;
      tab = tab.slice(0, split); row = Number(match[2]); col = 0;
      for (const c of match[1].toUpperCase()) col = col * 26 + c.charCodeAt(0) - 64;
      if (!Number.isSafeInteger(row) || !Number.isSafeInteger(col)) return;
    } else if (cellPattern.test(tab) && !this.aliases.has(canonical([source, tab]))) return;
    if (tab.startsWith("'") && tab.endsWith("'")) tab = tab.slice(1, -1).replaceAll("''", "'");
    const sheet = this.aliases.get(canonical([source, tab])) ?? tab;
    if (sheet === false) return;
    const tableSource = { ...source, sheet };
    const units: EvidenceUnit[] = v.values.map((value: unknown, i: number) => ({ source: tableSource,
      location: { row: row + i, column: col }, value, pointer: `${pointer}/values/${i}`, kind: "table_row" }));
    units.push({ source: tableSource, location: { row, column: col },
      value: { rows: v.values.length, row_widths: v.values.map((r: unknown[]) => r.length) },
      pointer: `${pointer}/values`, kind: "observed_extent" });
    const extra = Object.fromEntries(Object.entries(v).filter(([k]) => !["range", "values", "majorDimension"].includes(k)));
    if (Object.keys(extra).length) units.push({ source: tableSource, location: "metadata", value: extra, pointer, kind: "table_metadata" });
    return units;
  }
  atoms(o: Observation): EvidenceUnit[] {
    this.register(o);
    const value = this.payload(o), source = { tool: o.tool, arguments: o.arguments };
    const whole = (kind: string): EvidenceUnit[] => [{ source, location: "/", value, pointer: "", kind }];
    if (o.isError) return whole("error_observation");
    // Known text formats become source-addressed records; arbitrary command text
    // remains opaque. Never infer line numbers or silently drop unmatched lines.
    if (typeof value === "string") {
      const lines = value.split("\n");
      if (lines.at(-1) === "") lines.pop();
      if (o.tool === "list_files" && lines.length && lines.every(line => line.startsWith("/") && !line.includes("\u0000"))) {
        return [...new Set(lines)].map(path => ({ source: { filesystem: true }, location: { path: posix.normalize(path) },
          value: { exists: true, kind: "file" }, pointer: "", kind: "file_listing_record" }));
      }
      if (o.tool === "run_command" && lines.length && lines.every(line => /^([^\n]+?):([1-9][0-9]*):(.*)$/.test(line))) {
        const cwd = typeof o.arguments.cwd === "string" ? o.arguments.cwd : undefined;
        if (cwd) return lines.map(line => {
          const match = line.match(/^([^\n]+?):([1-9][0-9]*):(.*)$/)!;
          return { source: { filesystem: true, path: posix.resolve(cwd, match[1]) },
            location: { line: match[2] }, value: match[3], pointer: "", kind: "source_line_record" };
        });
      }
    }
    const items = Array.isArray(value) ? value : record(value) ? value.results : undefined;
    if (Array.isArray(items) && items.length) {
      const search = items.every(x => record(x) && typeof x.title === "string" &&
        ["body", "snippet", "description"].some(k => typeof x[k] === "string") && ["url", "href", "link"].some(k => httpUrl(x[k])));
      const catalog = record(value) && items.every(x => record(x) &&
        ["id", "url", "method", "description"].every(k => typeof x[k] === "string"));
      if (search || catalog) {
        const scope = Object.fromEntries(Object.entries(o.arguments).filter(([k]) =>
          !["query", "q", "top_k", "limit", "offset", ...(search ? ["max_results", "num_results"] : [])].includes(k)));
        const units: EvidenceUnit[] = items.map((item, i) => ({
          source: search ? { tool: o.tool, search_scope: scope, document_url: [item.url, item.href, item.link].find(httpUrl) } :
            { tool: o.tool, catalog_scope: scope, endpoint: item.url, method: item.method },
          location: search ? "record" : { id: item.id }, value: item,
          pointer: `${Array.isArray(value) ? "" : "/results"}/${i}`, kind: search ? "search_record" : "catalog_record",
        }));
        if (record(value)) {
          const extra = Object.fromEntries(Object.entries(value).filter(([k, v]) => k !== "results" &&
            !(k === "count" && Number.isInteger(v) && v === items.length)));
          if (Object.keys(extra).length) units.push({ source, location: "metadata", value: extra, pointer: "", kind: "collection_metadata" });
        }
        return units;
      }
    }
    if (record(value)) {
      const document = this.document(o, value);
      if (document) {
        if (Array.isArray(value.valueRanges)) {
          const groups = value.valueRanges.map((r: unknown, i: number) => this.table(o, document, r, `/valueRanges/${i}`));
          if (groups.length && groups.every(Boolean)) {
            const units = groups.flat() as EvidenceUnit[];
            const extra = Object.fromEntries(Object.entries(value).filter(([k]) => !["spreadsheetId", "valueRanges"].includes(k)));
            if (Object.keys(extra).length) units.push({ source: document, location: "metadata", value: extra, pointer: "", kind: "table_metadata" });
            return units;
          }
        }
        const table = this.table(o, document, value, "");
        if (table) return table;
      }
    }
    return whole("native_observation");
  }
}

export class EvidenceLedger {
  private readonly extractor = new Extractor();
  private frontier = new Map<string, { unit: EvidenceUnit; observation: Observation }[]>();
  private readonly processed = new Set<string>();
  register(observations: Observation[]): void { for (const o of observations) this.extractor.register(o); }
  ingest(o: Observation): { units: EvidenceUnit[]; decisions: EvidenceDecision[] } {
    if (this.processed.has(o.id)) return { units: [], decisions: [] };
    const atoms = this.extractor.atoms(o).map(unit => o.environment ? { ...unit,
      source: { ...unit.source, execution_environment: o.environment.kind } } : unit);
    const remapped = new Map<string, { unit: EvidenceUnit; observation: Observation }[]>();
    for (const views of this.frontier.values()) for (const view of views) {
      view.unit = { ...view.unit, source: this.extractor.resolve(view.unit.source) };
      const key = address(view.unit), group = remapped.get(key) ?? [];
      if (!group.some(v => v.observation.id === view.observation.id && digest(v.unit.value) === digest(view.unit.value))) group.push(view);
      remapped.set(key, group);
    }
    this.frontier = remapped;
    if (!o.isError) this.frontier.delete(address({ source: { tool: o.tool, arguments: o.arguments,
      ...(o.environment ? { execution_environment: o.environment.kind } : {}) },
      location: "/", value: null, pointer: "", kind: "error_observation" }));
    const units: EvidenceUnit[] = [], decisions: EvidenceDecision[] = [];
    for (const unit of atoms) {
      const key = address(unit), comparisons = (this.frontier.get(key) ?? []).map(v => ({ ...v, order: relation(o, v.observation) }));
      if (comparisons.some(v => v.order === "older")) {
        decisions.push({ kind: unit.kind, location: unit.location, reason: "older_than_known_observation" }); continue;
      }
      const identical = comparisons.filter(v => digest(v.unit.value) === digest(unit.value));
      decisions.push({ kind: unit.kind, location: unit.location, reason: identical.length ? "known_complete_unit" : "novel_complete_unit",
        knownFrom: identical.map(v => v.observation.id), concurrentConflicts: comparisons.filter(v =>
          v.order === "overlap" && digest(v.unit.value) !== digest(unit.value)).map(v => v.observation.id) });
      if (!identical.length) units.push(unit);
      const remaining = comparisons.filter(v => !["newer", "same"].includes(v.order));
      const next = remaining.map(({ unit, observation }) => ({ unit, observation }));
      if (!next.some(v => digest(v.unit.value) === digest(unit.value))) next.push({ unit, observation: o });
      this.frontier.set(key, next);
    }
    this.processed.add(o.id); return { units, decisions };
  }
}

export function evidenceMessage(o: Observation, units: EvidenceUnit[], decisions: EvidenceDecision[]): EvidenceMessage {
  const conflicts = [...new Set(decisions.flatMap(d => d.concurrentConflicts ?? []))];
  const header = { observation: { id: o.id, tool: o.tool, arguments: o.arguments, isError: o.isError,
    ...(o.environment ? { environment: { kind: o.environment.kind, authoritative: false } } : {}) },
    ...(conflicts.length ? { concurrent_observations: conflicts } : {}) };
  const raw = units.length === 1 && ["native_observation", "error_observation"].includes(units[0].kind);
  const content: (TextContent | ImageContent)[] = [{ type: "text", text:
    "Recorded tool observation (historical evidence):\n" + JSON.stringify(header) }];
  if (raw) content.push(...structuredClone(o.content));
  else content.push({ type: "text", text: JSON.stringify({ units }) });
  return { role: "user", content, timestamp: Date.now(), perseusEvidence: { observation: o, units } };
}
