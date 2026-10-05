import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionStream } from '../src/action-stream.mjs';
test('complete actions dispatch during a stream, including escaped braces and unicode', () => {
  const seen = []; const parser = new ActionStream(value => seen.push(value));
  parser.push('{"actions":[{"tool":"grep","arguments":{"pattern":"中文\\\"}x","path":"."}}');
  assert.equal(seen.length, 1);
  parser.push(',{"tool":"read","arguments":{"path":"a.js"}}]}');
  assert.equal(parser.finish().length, 2);
});
test('incomplete arguments never dispatch and invalid final JSON fails', () => {
  const seen = []; const parser = new ActionStream(value => seen.push(value));
  parser.push('{"actions":[{"tool":"read","arguments":{"path":"a');
  assert.deepEqual(seen, []); assert.throws(() => parser.finish());
});
