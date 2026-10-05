import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

type Content = (TextContent | ImageContent)[];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function imageType(raw: Buffer): string | undefined {
  if (raw.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (raw[0] === 255 && raw[1] === 216 && raw[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(raw.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (raw.subarray(0, 4).toString("ascii") === "RIFF" && raw.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
}

/** Decode only a declared transport encoding, never infer binary from ordinary text. */
export function toolResponseContent(visible: unknown): { content: Content; details: Record<string, unknown> } {
  const images: ImageContent[] = [];
  const project = (value: unknown): unknown => {
    if (!record(value)) return value;
    const out = { ...value };
    for (const field of ["stdout", "stderr"]) {
      const data = value[`${field}_base64`];
      if (value[`${field}_encoding`] !== "utf-8-with-backslash-escaped-invalid-bytes" ||
          typeof value[field] !== "string" || typeof data !== "string") continue;
      const raw = Buffer.from(data, "base64"), mimeType = imageType(raw);
      if (!mimeType || raw.toString("base64") !== data) continue;
      const attachment = images.length;
      images.push({ type: "image", data, mimeType });
      out[field] = { attachment, mimeType, byteLength: raw.length, encoding: "native_image" };
      delete out[`${field}_encoding`]; delete out[`${field}_base64`];
    }
    // Only descend into the bridge's command-result envelopes, not arbitrary JSON fields.
    for (const field of ["result", "detail"]) if (record(value[field])) out[field] = project(value[field]);
    return out;
  };
  const projected = project(visible);
  return {
    content: [{ type: "text", text: typeof projected === "string" ? projected : JSON.stringify(projected) }, ...images],
    details: images.length ? { originalTransport: visible, imageTransportDecoded: images.length } : {},
  };
}
