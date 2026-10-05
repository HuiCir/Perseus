import { appendFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const USER_EVIDENCE = `<perseus-evidence source="fixture-user-wave">${'x '.repeat(6000)}USER_EVIDENCE_END</perseus-evidence>`;
export const POST_EVIDENCE = '<perseus-evidence source="fixture-tool-wave">POST_EVIDENCE_END</perseus-evidence>';

// This executable belongs only to the native test fixture. The production plugin
// never branches on a test-mode environment variable or changes tool decisions.
if (process.argv[2]) {
  const directory = process.argv[2];
  let raw = '';
  for await (const part of process.stdin) raw += part;
  const input = JSON.parse(raw);
  const event = input.hook_event_name;
  const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  await appendFile(join(directory, 'hook-events.jsonl'), JSON.stringify({
    event,
    at: Date.now(),
    toolUseId: input.tool_use_id ?? null,
    inputHash: input.tool_input === undefined ? null : hash(input.tool_input),
    commandHash: input.tool_input?.command === undefined ? null : hash(input.tool_input.command),
    responseHash: input.tool_response === undefined ? null : hash(input.tool_response),
    model: input.model ?? null,
    hasPluginRoot: Boolean(process.env.PLUGIN_ROOT),
    hasPluginData: Boolean(process.env.PLUGIN_DATA),
  }) + '\n');

  const waitFor = async (name) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try { await stat(join(directory, name)); return; } catch { await delay(10); }
    }
    throw new Error(`Native test gate did not open: ${name}`);
  };
  const context = (text) => console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
  }));

  if (event === 'SessionStart') {
    context('FIXTURE_STATIC_HOOK_BASELINE');
  } else if (event === 'UserPromptSubmit') {
    await waitFor('request-zero-started');
    await appendFile(join(directory, 'hook-events.jsonl'), JSON.stringify({ event: 'UserEvidenceReady', at: Date.now() }) + '\n');
    context(USER_EVIDENCE);
  } else if (event === 'PostToolUse' && JSON.stringify(input.tool_input).includes('actor-first.txt')) {
    await waitFor('request-one-started');
    await appendFile(join(directory, 'hook-events.jsonl'), JSON.stringify({ event: 'PostEvidenceReady', at: Date.now() }) + '\n');
    context(POST_EVIDENCE);
  } else {
    // Stop requires JSON at exit 0. No feedback, permission decision, rewriting,
    // or continuation is returned by any fixture hook.
    console.log('{}');
  }
}
