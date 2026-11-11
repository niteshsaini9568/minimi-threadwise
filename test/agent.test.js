import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceFrom, runAgent, httpUrl } from '../src/agent.js';

export function responseFixture(text = 'Current price is $25. [source]') {
  return { status: 'completed', usage: { total_tokens: 123 }, output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', queries: ['official pricing'], sources: [{ url: 'https://example.com/pricing', title: 'Pricing' }, { url: 'javascript:alert(1)' }] } },
    { type: 'message', content: [{ type: 'output_text', text, annotations: [{ type: 'url_citation', url: 'https://example.com/pricing', title: 'Official pricing', start_index: text.indexOf('[source]'), end_index: text.length }] }] },
  ] };
}
export function fakeClient(response = responseFixture(), captured = []) {
  return { responses: { create: async (input, options) => {
    captured.push({ input, options });
    return (async function* () {
      yield { type: 'response.web_search_call.searching' };
      yield { type: 'response.output_text.delta', delta: 'Current price is $25. ' };
      yield { type: 'response.completed', response };
    })();
  } } };
}
const params = { model: 'test-model', memoryModel: 'test-memory', history: [], question: 'What changed?', threadId: 'x', now: '2026-11-11T12:00:00Z', timezone: 'Asia/Kolkata' };

test('tool citations, consulted URLs and usage are retained, unsafe URLs rejected', () => {
  const evidence = evidenceFrom(responseFixture(), params.now);
  assert.equal(evidence.sources.length, 1);
  assert.equal(evidence.sources[0].cited, true);
  assert.equal(evidence.sources[0].checked_at, params.now);
  assert.equal(evidence.annotations.length, 1);
  assert.deepEqual(evidence.searches[0].queries, ['official pricing']);
  assert.equal(httpUrl('https://user:password@example.com'), null);
  assert.equal(httpUrl('javascript:alert(1)'), null);
});
test('interleaved search calls cannot downgrade an already-cited source', () => {
  const response = responseFixture();
  response.output.push(response.output[0]);
  assert.equal(evidenceFrom(response, params.now).sources[0].cited, true);
});
test('only web_search is exposed, with live access, server clock, no provider-side storage', async () => {
  const captured = [], events = [];
  const result = await runAgent({ ...params, client: fakeClient(responseFixture(), captured), emit: (type, data) => events.push({ type, data }) });
  assert.equal(result.answer, 'Current price is $25. [source]');
  const request = captured[0].input;
  assert.equal(request.store, false);
  assert.deepEqual(request.tools.map(t => t.type), ['web_search']);
  assert.equal(request.tools[0].external_web_access, true);
  assert.equal(request.tools[0].user_location.timezone, 'Asia/Kolkata');
  assert.equal(JSON.parse(request.input[0].content).server_clock.instant, params.now);
  assert.ok(events.some(e => e.type === 'delta'));
  assert.ok(events.some(e => e.type === 'memory'));
  assert.equal(result.usage.total_tokens, 123);
});
test('truncated, failed and disconnected streams cannot produce completed answers', async () => {
  await assert.rejects(runAgent({ ...params, client: fakeClient({ status: 'incomplete', output: [] }) }));
  const client = { responses: { create: async () => (async function* () { yield { type: 'response.output_text.delta', delta: 'Partial' }; })() } };
  await assert.rejects(runAgent({ ...params, client }), /before the answer completed/);
});
test('long histories invoke a tool-free structured selector and reject fabricated IDs', async () => {
  let calls = 0;
  const history = Array.from({ length: 90 }, (_, i) => ({ id: `turn-${i}`, thread_id: 'other', thread_title: 'Old', created_at: '2026-11-03T10:00:00Z', completed_at: '2026-11-03T10:00:00Z', timezone: 'UTC', question: 'Postgres', answer: 'a'.repeat(1500), status: 'completed', evidence: {} }));
  const client = { responses: { create: async (input, options) => {
    if (++calls === 1) {
      assert.equal(input.tools, undefined);
      assert.equal(input.text.format.strict, true);
      return { status: 'completed', output_text: '{"ids":["turn-20","not-a-real-id"]}', usage: { total_tokens: 10 } };
    }
    return fakeClient().responses.create(input, options);
  } } };
  const result = await runAgent({ ...params, question: 'Postgres pricing?', history, client });
  assert.equal(calls, 2);
  assert.equal(result.recall.included, 1);
  assert.equal(result.recall.turns[0].id, 'turn-20');
  assert.equal(result.recall.omitted, 89);
});
