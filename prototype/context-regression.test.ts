import test from "node:test";
import assert from "node:assert/strict";
import { toolResponseContent } from "./harness/packages/agent/src/tool-content.ts";
import { EvidenceLedger, evidenceMessage } from "./harness/packages/agent/src/evidence-ledger.ts";
import { AcquisitionSchedule } from "./harness/packages/agent/src/se-schedule.ts";
import { preexecutionObservations, summarizeObservationRecords } from "./harness/packages/coding-agent/src/core/perseus-light-controller.ts";
import { convertResponsesMessages } from "./harness/packages/ai/src/providers/openai-responses-shared.ts";
import { convertMessages } from "./harness/packages/ai/src/providers/openai-completions.ts";

const native = (n: number, content: any[]) => ({ role: "toolResult", toolName: "read", toolCallId: `${n}`,
  isError: false, timestamp: n, content });
const context = (): any => ({ systemPrompt: "original", tools: [], messages: [{ role: "user", content: "task", timestamp: 0 }] });
const policy = { refresh: "context" as const, contextGrowthRatio: 1 };

test("refresh baseline stays task-relative as history grows; repeated results and private evidence cannot trigger it", () => {
  const c = context(), s = new AcquisitionSchedule(), initial = s.evaluate(c, policy, 0);
  const baseline = initial.baselineBytes;
  for (let i = 1; i <= 10; i++) {
    c.messages.push(native(i, [{ type: "text", text: `${i}`.repeat(baseline) }]));
    const d = s.evaluate(c, policy, i);
    assert.equal(d.reason, "context_growth"); assert.equal(d.baselineBytes, baseline);
    c.messages.push(structuredClone(c.messages.at(-1)));
    assert.equal(s.evaluate(c, policy, i + 100).launch, false);
    c.messages.push({ role: "user", content: "private ".repeat(1000), perseusEvidence: { observation: {} } });
    assert.equal(s.evaluate(c, policy, i + 200).growthBytes, 0);
  }
});

test("image size does not turn base64 bytes into text growth; actual content stays intact", () => {
  const decisions = [];
  for (const size of [100, 100000]) {
    const c = context(), s = new AcquisitionSchedule(); s.evaluate(c, policy, 0);
    c.messages.push(native(1, [{ type: "image", data: Buffer.alloc(size, 42).toString("base64"), mimeType: "image/png" }]));
    const before = JSON.stringify(c);
    decisions.push(s.evaluate(c, policy, 1)); assert.equal(JSON.stringify(c), before);
  }
  assert.equal(decisions[0].informationBytes, decisions[1].informationBytes);
});

test("lossless dictionary shares blocks across distinct records and is exactly reconstructable", () => {
  const block = { type: "text", text: "complete code\n".repeat(2000) };
  const obs = preexecutionObservations([native(1, [block]), { ...native(2, [block]), toolName: "other" }] as any);
  const result: any = summarizeObservationRecords(obs), b = result[0].content;
  const { chronology, records } = JSON.parse(b[0].text);
  const blocks = new Map();
  for (let i = 1; i < b.length; i += 2) blocks.set(JSON.parse(b[i].text).blockId, b[i + 1]);
  const restored = chronology.map((id: number, observationIndex: number) => ({ role: "user", timestamp: obs[observationIndex].timestamp,
    content: [{ type: "text", text: JSON.stringify({ observationIndex, ...records[id].header }) },
      ...records[id].blockIds.map((blockId: number) => blocks.get(blockId))] }));
  assert.deepEqual(restored, obs);
  assert.ok(JSON.stringify(result).length < JSON.stringify(obs).length * 0.6);
});

test("unique small records remain original if a dictionary adds overhead", () => {
  const obs = preexecutionObservations([{ role: "user", content: "original", timestamp: 0 }]);
  assert.deepEqual(summarizeObservationRecords(obs), obs);
});

test("synthetic JPEG transport becomes lossless native image, never text base64", () => {
  // Reproduce the declared byte transport without distributing a private trace.
  // The decoder checks the JPEG signature; this fixture does not claim to be an
  // independently viewable photograph or a successful live benchmark replay.
  const bytes = Buffer.concat([Buffer.from([255, 216, 255, 224]), Buffer.alloc(8192, 42), Buffer.from([255, 217])]);
  const original = { result: { stdout: "\\xff\\xd8\\xff\\xe0", stdout_encoding: "utf-8-with-backslash-escaped-invalid-bytes", stdout_base64: bytes.toString("base64") } };
  const decoded = toolResponseContent(original);
  const img: any = decoded.content.find(b => b.type === "image");
  assert.equal(img.mimeType, "image/jpeg");
  assert.equal(img.data, original.result.stdout_base64);
  assert.deepEqual(decoded.details.originalTransport, original);
  assert.ok(decoded.content.filter(b => b.type === "text").every(b => !b.text.includes(img.data)));
  assert.ok(decoded.content.filter(b => b.type === "text").reduce((s, b) => s + b.text.length, 0) < 1000);
  for (const isError of [false, true]) {
    const o: any = { id: "test", tool: "read", arguments: {}, content: decoded.content, isError, start: 1, end: 2 };
    const ledger = new EvidenceLedger(), ingested = ledger.ingest(o), message = evidenceMessage(o, ingested.units, ingested.decisions);
    assert.deepEqual((message.content as any[]).find(b => b.type === "image"), img);
    assert.equal(ledger.ingest({ ...o, id: "second", start: 3, end: 4 }).units.length, 0);
  }
});

test("ordinary text, malformed encodings, and non-image bytes are never cut or recoded", () => {
  for (const value of ["a\u2028b\u0085c".repeat(20000), { result: { stdout: "literal", stdout_base64: "/9j/AA==" } },
    { result: { stdout: "literal", stdout_encoding: "utf-8-with-backslash-escaped-invalid-bytes", stdout_base64: "AA==" } }]) {
    assert.deepEqual(toolResponseContent(value), { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], details: {} });
  }
});

test("native providers receive image blocks in both Actor evidence and SE snapshots", () => {
  const image = { type: "image", data: "/9j/AA==", mimeType: "image/jpeg" };
  const message: any = { role: "user", timestamp: 0, content: [{ type: "text", text: "historical observation" }, image] };
  const model: any = { id: "fixture", provider: "fixture", api: "openai-responses", reasoning: true, input: ["text", "image"] };
  const responses: any = convertResponsesMessages(model, { messages: [message] }, new Set());
  assert.ok(responses.some((m: any) => m.content?.some((b: any) => b.type === "input_image" && b.image_url === `data:image/jpeg;base64,${image.data}`)));
  const chat: any = convertMessages({ ...model, api: "openai-completions" }, { messages: preexecutionObservations([message]) }, {} as any);
  assert.ok(chat.some((m: any) => m.content?.some((b: any) => b.type === "image_url" && b.image_url.url === `data:image/jpeg;base64,${image.data}`)));
});
