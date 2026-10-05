import { createHash } from "node:crypto";
import type { AgentContext } from "@earendil-works/pi-agent-core";

type Schema = Record<string, any>;
export interface ActionDomain {
  id: string;
  parameters: Schema;
  derived: boolean;
  bindings?: Record<string, unknown>;
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const scalar = (v: unknown) => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const stable = (v: any): string => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : object(v) ?
  `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v);
const hash = (v: any) => createHash("sha256").update(stable(v)).digest("hex");
const fields = ["method", "operation", "action", "op", "mode", "function", "command"];
const equals = (values: Record<string, any>): Schema => ({ type: "object",
  properties: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { const: v }])),
  required: Object.keys(values) });
function declaredValues(p: Schema): any[] | undefined {
  if (Array.isArray(p.enum)) return p.enum.every(scalar) ? p.enum : undefined;
  if ("const" in p && scalar(p.const)) return [p.const];
  const branches = p.oneOf ?? p.anyOf;
  if (Array.isArray(branches) && branches.every(b => object(b) && scalar(b.const))) return branches.map(b => b.const);
}

/** Derive internal, disjoint action domains from schemas and actual mainline calls.
 * No benchmark/task text, executable allowlist, permissions, or model router.
 * Every unrecognized invocation remains available through the complement domain.
 */
export function deriveActionDomains(tool: NonNullable<AgentContext["tools"]>[number],
  messages: AgentContext["messages"]): ActionDomain[] {
  const schema = tool.parameters as Schema;
  const properties: Schema = { ...(schema.properties ?? {}) };
  for (const part of schema.allOf ?? []) Object.assign(properties, part.properties ?? {});
  const candidates = new Map<string, { predicate: Schema; specificity: number }>();
  let exhaustive = false;
  const add = (predicate: Schema, specificity: number) => candidates.set(stable(predicate), { predicate, specificity });
  // Only declared action discriminators, not arbitrary enum-valued task data.
  for (const key of fields) {
    const p = properties[key];
    if (!object(p)) continue;
    const values = declaredValues(p) ?? [];
    for (const value of values) if (scalar(value)) add(equals({ [key]: value }), 1);
    if (values.length && schema.required?.includes(key)) exhaustive = true;
  }
  for (const branch of [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]) {
    const values: Record<string, any> = {};
    for (const key of fields) if (object(branch.properties?.[key]) && scalar(branch.properties[key].const))
      values[key] = branch.properties[key].const;
    if (Object.keys(values).length) add(equals(values), Object.keys(values).length);
  }
  for (const message of messages) {
    const observation = (message as any).perseusObservation;
    if (!observation || observation.tool !== tool.name || observation.isError || !object(observation.arguments)) continue;
    const args = observation.arguments;
    const values: Record<string, any> = {};
    for (const key of fields) if (object(properties[key]) && scalar(args[key])) {
      // Free-form command strings are programs, not categorical action heads.
      if (key === "command" && !properties[key].enum && !properties[key].const) continue;
      values[key] = args[key];
    }
    if (Object.keys(values).length) {
      add(equals(values), Object.keys(values).length);
      for (const key of ["url", "endpoint", "route"]) if (properties[key]?.type === "string" && typeof args[key] === "string")
        add(equals({ ...values, [key]: args[key] }), Object.keys(values).length + 1);
    }
    // argv is structured syntax. Shell text is deliberately not split with a regex.
    for (const key of ["argv", "command"]) if (properties[key]?.type === "array" &&
      Array.isArray(args[key]) && typeof args[key][0] === "string") {
      const prefix = { type: "object", properties: { [key]: { type: "array", minItems: 1,
        items: [{ const: args[key][0] }], additionalItems: true } }, required: [key] };
      add(prefix, 1);
    }
  }
  if (!candidates.size) return [{ id: `${tool.name}:native`, parameters: tool.parameters, derived: false }];
  const ordered = [...candidates.values()].sort((a, b) => b.specificity - a.specificity ||
    (stable(a.predicate) < stable(b.predicate) ? -1 : stable(a.predicate) > stable(b.predicate) ? 1 : 0));
  const excluded: Schema[] = [], domains: ActionDomain[] = [];
  for (const { predicate } of ordered) {
    const constraint = excluded.length ? { allOf: [predicate, { not: { anyOf: [...excluded] } }] } : predicate;
    const bindings = Object.fromEntries(Object.entries(predicate.properties ?? {}).flatMap(([key, p]) =>
      object(p) && Object.hasOwn(p, "const") ? [[key, p.const]] : []));
    // Positive heads keep their identity when a new sibling specializes the
    // remaining space. Disjoint ownership is still checked against the full schema.
    const projected = { ...properties };
    for (const [key, value] of Object.entries(bindings)) projected[key] = { ...projected[key], const: value };
    domains.push({ id: `${tool.name}:${hash(predicate)}`, bindings, parameters: { ...tool.parameters, properties: projected,
      allOf: [...(schema.allOf ?? []), constraint] }, derived: true });
    excluded.push(predicate);
  }
  if (!exhaustive) domains.push({ id: `${tool.name}:complement`, parameters: { ...tool.parameters,
    allOf: [...(schema.allOf ?? []), { not: { anyOf: excluded } }] }, derived: true });
  return domains;
}

/** Complete an omitted fixed head, but never overwrite an explicit different action. */
export function bindActionHead(domain: ActionDomain, raw: Record<string, unknown>): Record<string, unknown> {
  const args = structuredClone(raw);
  for (const [key, value] of Object.entries(domain.bindings ?? {}))
    if (!Object.hasOwn(args, key)) args[key] = structuredClone(value);
  return args;
}
