import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { Store } from '../src/store.js';
import { createApp, validateImport } from '../src/server.js';

async function fixture(t, extra = {}) {
  const store = new Store(':memory:');
  const app = createApp({ store, client: {}, agent: async ({ emit }) => {
    emit('delta', { text: 'A checked answer.' });
    return { answer: 'A checked answer.', sources: [], searches: [], recall: { included: 0, turns: [], total: 0, omitted: 0 } };
  }, ...extra });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => { app.closeAllConnections(); await new Promise(r => app.close(r)); store.close(); });
  let cookie;
  const request = async (path, { body, method, headers, ...options } = {}) => {
    const response = await fetch(base + path, { ...options, method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    cookie ||= response.headers.get('set-cookie')?.split(';')[0];
    return response;
  };
  return { request, store, base };
}
test('app serves the UI and vendored dependencies under a restrictive CSP', async t => {
  const { request } = await fixture(t);
  for (const path of ['/', '/app.js', '/style.css', '/vendor/marked.js', '/vendor/purify.js', '/sample-history.json']) {
    const response = await request(path); assert.equal(response.status, 200, path); await response.text();
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
});
test('HTTP chat streams and persists one completed turn', async t => {
  const { request } = await fixture(t);
  const thread = await (await request('/api/threads', { method: 'POST' })).json();
  const response = await request(`/api/threads/${thread.id}/turns`, { method: 'POST', body: { message: 'Check pricing', timezone: 'UTC' } });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const stream = await response.text();
  assert.match(stream, /event: delta/); assert.match(stream, /event: done/);
  const saved = await (await request(`/api/threads/${thread.id}`)).json();
  assert.equal(saved.turns[0].status, 'completed'); assert.equal(saved.turns[0].answer, 'A checked answer.');
});
test('anonymous browser sessions are isolated even if a thread ID is known', async t => {
  const { request, base } = await fixture(t);
  const thread = await (await request('/api/threads', { method: 'POST' })).json();
  const other = await fetch(`${base}/api/threads/${thread.id}`);
  assert.equal(other.status, 404);
  assert.deepEqual(await (await fetch(`${base}/api/threads`)).json(), []);
});
test('same-origin and Host checks block cross-site writes and DNS rebinding', async t => {
  const { request, base } = await fixture(t);
  assert.equal((await request('/api/threads', { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/threads`, { method: 'POST', headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
});
test('validation and missing keys fail clearly without storing phantom turns', async t => {
  const { request } = await fixture(t, { client: null });
  const thread = await (await request('/api/threads', { method: 'POST' })).json();
  const response = await request(`/api/threads/${thread.id}/turns`, { method: 'POST', body: { message: 'Hello', timezone: 'UTC' } });
  assert.equal(response.status, 503); assert.match((await response.json()).error, /OPENAI_API_KEY/);
  assert.deepEqual((await (await request(`/api/threads/${thread.id}`)).json()).turns, []);
});
test('invalid messages and timezones are rejected before a turn is stored', async t => {
  const { request } = await fixture(t);
  const thread = await (await request('/api/threads', { method: 'POST' })).json();
  for (const body of [{ message: '' }, { message: 'x', timezone: 'Mars/Base' }, null, { message: 'x'.repeat(12001) }]) {
    assert.equal((await request(`/api/threads/${thread.id}/turns`, { method: 'POST', body })).status, 400);
  }
  assert.deepEqual((await (await request(`/api/threads/${thread.id}`)).json()).turns, []);
});
test('provider failure saves only incomplete text and sends an error event', async t => {
  const { request } = await fixture(t, { agent: async ({ emit }) => { emit('delta', { text: 'Partial' }); throw Object.assign(new Error('secret provider body'), { status: 429 }); } });
  const thread = await (await request('/api/threads', { method: 'POST' })).json();
  const stream = await (await request(`/api/threads/${thread.id}/turns`, { method: 'POST', body: { message: 'Q', timezone: 'UTC' } })).text();
  assert.match(stream, /event: error/); assert.doesNotMatch(stream, /secret provider body/);
  const saved = await (await request(`/api/threads/${thread.id}`)).json();
  assert.equal(saved.turns[0].status, 'failed'); assert.equal(saved.turns[0].answer, 'Partial');
});
test('history imports validate before writing and export keeps original timestamps', async t => {
  const { request } = await fixture(t);
  const body = { threads: [{ title: 'Old', turns: [{ question: 'Then?', answer: 'Answer', created_at: '2026-11-03T12:00:00Z', timezone: 'UTC' }] }] };
  assert.equal((await request('/api/history/import', { method: 'POST', body })).status, 201);
  const exported = await (await request('/api/history/export')).json();
  assert.equal(exported.threads[0].turns[0].created_at, '2026-11-03T12:00:00.000Z');
  assert.throws(() => validateImport({ threads: [{ title: 'future', turns: [{ ...body.threads[0].turns[0], created_at: '2099-01-01T00:00:00Z' }] }] }));
  assert.throws(() => validateImport(null));
});

test('overlapping turns are rejected and a later turn can run after completion', async t => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const { request } = await fixture(t, { agent: async () => { await gate; return { answer: 'Finished', sources: [], searches: [] }; } });
  const thread = await (await request('/api/threads', { method: 'POST' })).json();
  const path = `/api/threads/${thread.id}/turns`;
  const first = await request(path, { method: 'POST', body: { message: 'First', timezone: 'UTC' } });
  const second = await request(path, { method: 'POST', body: { message: 'Second', timezone: 'UTC' } });
  assert.equal(second.status, 409);
  finish(); await first.text();
  const third = await request(path, { method: 'POST', body: { message: 'Third', timezone: 'UTC' } });
  assert.equal(third.status, 200); await third.text();
  assert.equal((await (await request(`/api/threads/${thread.id}`)).json()).turns.length, 2);
});

test('disconnect aborts upstream work and preserves an interrupted turn', async t => {
  let cancelled;
  const stopped = new Promise(resolve => { cancelled = resolve; });
  const { request } = await fixture(t, { agent: async ({ signal, emit }) => {
    emit('delta', { text: 'Partial response' });
    await new Promise((resolve, reject) => {
      if (signal.aborted) { cancelled(); reject(signal.reason); }
      else signal.addEventListener('abort', () => { cancelled(); reject(signal.reason); }, { once: true });
    });
  } });
  const thread = await (await request('/api/threads', { method: 'POST' })).json();
  const controller = new AbortController();
  const response = await request(`/api/threads/${thread.id}/turns`, { method: 'POST', signal: controller.signal, body: { message: 'Stop test', timezone: 'UTC' } });
  await response.body.getReader().read(); controller.abort();
  await stopped;
  const saved = await (await request(`/api/threads/${thread.id}`)).json();
  assert.equal(saved.turns[0].status, 'interrupted');
  assert.equal(saved.turns[0].answer, 'Partial response');
});
