import { validateToolArguments } from "@earendil-works/pi-ai";
import type { AgentTool } from "./types.ts";

type Schema = Record<string, any>;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

function jsonString(schema: Schema): boolean {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.includes("string") || types.includes("object") || types.includes("array")) return false;
  return schema.contentMediaType === "application/json" ||
    (typeof schema.description === "string" && /\b(?:as\s+(?:a\s+)?JSON\s+string|JSON[- ](?:encoded|serialized)\s+string)\b/i.test(schema.description));
}

/** Normalize only explicitly declared encodings. Never guess values, trim strings,
 * drop unknown fields, rewrite actions, or change already valid JSON text.
 */
function encodings(schema: Schema, value: unknown): unknown {
  if (jsonString(schema) && (object(value) || Array.isArray(value))) return JSON.stringify(value);
  let result = value;
  if (object(value) && object(schema.properties)) {
    result = { ...value };
    for (const [key, child] of Object.entries(schema.properties))
      if (Object.hasOwn(value, key) && object(child)) (result as Schema)[key] = encodings(child, value[key]);
  } else if (Array.isArray(value) && object(schema.items)) result = value.map(v => encodings(schema.items, v));
  for (const part of schema.allOf ?? []) if (object(part)) result = encodings(part, result);
  return result;
}

export function prepareNativeArguments(tool: Pick<AgentTool<any>, "parameters" | "prepareArguments" | "description">,
  raw: unknown): Record<string, any> {
  // Some native tools publish field encodings in an Args section instead of
  // property descriptions. Only exact declared field names can supply a codec.
  const schema: Schema = { ...tool.parameters, properties: { ...(tool.parameters as Schema).properties } };
  let inArguments = false;
  for (const line of tool.description.split("\n")) {
    if (/^(?:Args|Arguments|Parameters):\s*$/.test(line.trim())) { inArguments = true; continue; }
    if (!inArguments) continue;
    if (/^\S.*:\s*$/.test(line)) { inArguments = false; continue; }
    const field = line.match(/^\s+([A-Za-z_][\w.-]*):\s+(.+)$/);
    if (field && object(schema.properties[field[1]]) && !schema.properties[field[1]].description)
      schema.properties[field[1]] = { ...schema.properties[field[1]], description: field[2] };
  }
  const encoded = encodings(schema, structuredClone(raw));
  return (tool.prepareArguments ? tool.prepareArguments(encoded) : encoded) as Record<string, any>;
}

export function validateNativeArguments(tool: AgentTool<any>, raw: unknown): Record<string, any> {
  return validateToolArguments(tool, { type: "toolCall", id: "native-validation", name: tool.name,
    arguments: prepareNativeArguments(tool, raw) });
}
