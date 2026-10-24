import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSse, quotaSnapshot } from './new-api-poc.mjs';

test('SSE parser collects multiple JSON frames and DONE', () => {
  const result = parseSse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":1}}\n\n' +
    'data: [DONE]\n\n');
  assert.equal(result.length, 3);
  assert.equal(result[0].choices[0].delta.content, 'hi');
  assert.equal(result[1].usage.prompt_tokens, 1);
  assert.equal(result[2].done, true);
});

test('SSE parser supports CRLF and rejects malformed JSON', () => {
  assert.equal(parseSse('data: [DONE]\r\n\r\n')[0].done, true);
  assert.throws(() => parseSse('data: {broken}\n\n'), /invalid SSE JSON/);
});

test('quota snapshot is diagnostic units, not a monetary amount', () => {
  assert.deepEqual(quotaSnapshot({ data: { total_used: 15, total_available: 40 } }),
    { usedQuotaUnits: 15, availableQuotaUnits: 40 });
  assert.equal(quotaSnapshot({ data: { total_used: 'unknown', total_available: 40 } }), null);
  assert.equal(quotaSnapshot({}), null);
});
