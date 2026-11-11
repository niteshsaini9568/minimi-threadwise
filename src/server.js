import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { Store } from './store.js';
import { runAgent } from './agent.js';
import { validTimezone } from './memory.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FILES = {
  '/': ['public/index.html', 'text/html'],
  '/app.js': ['public/app.js', 'text/javascript'],
  '/style.css': ['public/style.css', 'text/css'],
  '/fonts/inter-variable.woff2': ['public/fonts/inter-variable.woff2', 'font/woff2'],
  '/vendor/marked.js': ['node_modules/marked/lib/marked.esm.js', 'text/javascript'],
  '/vendor/purify.js': ['node_modules/dompurify/dist/purify.es.mjs', 'text/javascript'],
  '/sample-history.json': ['fixtures/sample-history.json', 'application/json'],
};
const fail = (status, message) => Object.assign(new Error(message), { status });

async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'Send application/json.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw fail(413, 'Request too large (1 MB maximum).');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'Invalid JSON.'); }
}

export function validateImport(body, now = Date.now()) {
  if (!body || !Array.isArray(body.threads) || body.threads.length < 1 || body.threads.length > 50) throw fail(400, 'Import 1–50 conversations.');
  let count = 0;
  return body.threads.map(thread => {
    if (typeof thread.title !== 'string' || !thread.title.trim() || thread.title.length > 100 || !Array.isArray(thread.turns) || !thread.turns.length) throw fail(400, 'Each conversation needs a title and turns.');
    return { title: thread.title.trim(), turns: thread.turns.map(turn => {
      if (++count > 1000) throw fail(400, 'Import at most 1,000 turns at a time.');
      if (!turn || typeof turn.question !== 'string' || !turn.question.trim() || turn.question.length > 12000 || typeof turn.answer !== 'string' || !turn.answer.trim() || turn.answer.length > 48000) throw fail(400, 'Each turn needs a question and answer within the size limits.');
      if (typeof turn.created_at !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(turn.created_at) || !Number.isFinite(Date.parse(turn.created_at)) || Date.parse(turn.created_at) > now || !validTimezone(turn.timezone)) throw fail(400, 'Use past ISO timestamps with offsets and valid IANA timezones.');
      return { question: turn.question.trim(), answer: turn.answer.trim(), timezone: turn.timezone, created_at: new Date(turn.created_at).toISOString() };
    }).sort((a, b) => a.created_at.localeCompare(b.created_at)) };
  });
}

export function publicError(error) {
  if (error.status === 401) return 'OpenAI rejected the API key. Check OPENAI_API_KEY in .env.';
  if (error.status === 429) return 'OpenAI rate or billing limit reached. Check API billing, then retry.';
  if (error.status === 403 || error.status === 404) return 'Your API project cannot access the configured model or web search. Check .env and account permissions.';
  if (error.name === 'AbortError' || error.name === 'TimeoutError' || /abort/i.test(error.name)) return 'The response stopped or timed out. The partial answer was not saved as a completed answer.';
  if (error.status >= 500) return 'The model service is temporarily unavailable. Please retry.';
  return 'The answer could not complete. Please retry, or check your model configuration and connection.';
}

export function createApp({ store, client, model = process.env.OPENAI_MODEL || 'gpt-6.1-sol', memoryModel = process.env.MEMORY_MODEL || 'gpt-6-luna', defaultTimezone = process.env.DEFAULT_TIMEZONE || 'UTC', agent = runAgent } = {}) {
  const busy = new Set();
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      const host = req.headers.host || '';
      if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host)) throw fail(403, 'This app accepts local connections only.');
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw fail(403, 'Cross-origin requests are not allowed.');
      const cookies = req.headers.cookie || '';
      let owner = /(?:^|;\s*)threadwise=([a-f0-9]{64})(?:;|$)/.exec(cookies)?.[1];
      if (!owner) {
        owner = randomBytes(32).toString('hex');
        res.setHeader('Set-Cookie', `threadwise=${owner}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
      }
      const path = new URL(req.url, `http://${host}`).pathname;
      if (req.method === 'GET' && FILES[path]) {
        const [filename, type] = FILES[path];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        res.end(await readFile(resolve(ROOT, filename))); return;
      }
      if (req.method === 'GET' && path === '/api/config') return send(200, { configured: Boolean(client), model, memoryModel });
      if (req.method === 'GET' && path === '/api/threads') return send(200, store.threads(owner));
      if (req.method === 'POST' && path === '/api/threads') return send(201, store.createThread(owner));
      if (req.method === 'GET' && path === '/api/history/export') {
        const history = store.history(owner);
        return send(200, { threads: store.threads(owner).map(t => ({ title: t.title, turns: history.filter(u => u.thread_id === t.id && u.status === 'completed').map(u => ({ question: u.question, answer: u.answer, created_at: u.created_at, timezone: u.timezone })) })).filter(t => t.turns.length) });
      }
      if (req.method === 'POST' && path === '/api/history/import') {
        if (busy.has(owner)) throw fail(409, 'Wait for the current answer before importing history.');
        const threads = validateImport(await jsonBody(req));
        store.importHistory(owner, threads); return send(201, { imported: threads.reduce((n, t) => n + t.turns.length, 0) });
      }
      const match = /^\/api\/threads\/([a-f0-9-]{36})(?:\/(turns))?$/.exec(path);
      if (!match) throw fail(404, 'Not found.');
      const threadId = match[1];
      if (!store.thread(owner, threadId)) throw fail(404, 'Conversation not found.');
      if (req.method === 'GET' && !match[2]) return send(200, { thread: store.thread(owner, threadId), turns: store.turns(owner, threadId) });
      if (req.method === 'DELETE' && !match[2]) {
        if (busy.has(owner)) throw fail(409, 'Stop the current answer before deleting.');
        store.removeThread(owner, threadId); return send(200, { deleted: true });
      }
      if (req.method !== 'POST' || !match[2]) throw fail(405, 'Method not allowed.');
      if (!client) throw fail(503, 'Add OPENAI_API_KEY to .env and restart npm run dev.');
      const body = await jsonBody(req);
      if (!body || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 12000) throw fail(400, 'Send a message of 1–12,000 characters.');
      const timezone = body.timezone ?? defaultTimezone;
      if (!validTimezone(timezone)) throw fail(400, 'Invalid IANA timezone.');
      if (busy.has(owner)) throw fail(409, 'One answer is already running. Stop it or wait.');
      const now = new Date().toISOString();
      const history = store.history(owner);
      const id = store.beginTurn(owner, threadId, body.message.trim(), timezone, now);
      busy.add(owner);
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
      const disconnect = () => { if (!res.writableEnded) controller.abort(); };
      res.on('close', disconnect);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
      res.flushHeaders();
      const emit = (event, data) => { if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
      let partial = '';
      let recall;
      try {
        emit('start', { id, created_at: now });
        const result = await agent({ client, model, memoryModel, history, question: body.message.trim(), threadId, now, timezone, signal,
          emit: (event, data) => {
            if (event === 'delta') partial += data.text;
            if (event === 'memory') recall = data;
            emit(event, data);
          },
        });
        if (signal.aborted) throw signal.reason;
        const { answer, ...evidence } = result;
        store.finishTurn(id, answer, 'completed', evidence);
        emit('done', { id, answer, evidence });
      } catch (error) {
        const message = publicError(error);
        store.finishTurn(id, partial, signal.aborted ? 'interrupted' : 'failed', { error: message, recall });
        emit('error', { message, id });
      } finally {
        clearInterval(heartbeat);
        res.off('close', disconnect);
        busy.delete(owner);
        res.end();
      }
    } catch (error) {
      if (!res.headersSent) send(error.status || 500, { error: error.status ? error.message : 'The request could not complete.' });
      else res.end();
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const store = new Store(resolve(process.env.DATA_DIR || resolve(ROOT, 'data'), 'threadwise.sqlite'));
  const client = process.env.OPENAI_API_KEY?.trim() ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 1, timeout: 120_000 }) : null;
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const server = createApp({ store, client });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Threadwise is ready at http://localhost:${port}`);
    if (!client) console.log('Setup needed: copy .env.example to .env and add OPENAI_API_KEY.');
  });
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Set PORT in .env.` : 'Server could not start.'); process.exitCode = 1; store.close(); });
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => { server.close(() => { store.close(); process.exit(); }); server.closeAllConnections(); });
}
