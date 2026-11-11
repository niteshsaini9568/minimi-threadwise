import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

const $ = selector => document.querySelector(selector);
const state = { thread: null, controller: null, threads: [], configured: false };
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dateLabel = value => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request failed.');
  return data;
}

let toastTimer;
function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 7000);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function safeUrl(url) {
  try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null; }
  catch { return null; }
}

function renderAnswer(container, answer, evidence = {}) {
  let text = answer;
  const annotations = (evidence.annotations || []).filter(a => safeUrl(a.url)
    && Number.isInteger(a.start_index) && Number.isInteger(a.end_index)
    && a.start_index >= 0 && a.end_index > a.start_index && a.end_index <= answer.length);
  const numbers = new Map();
  for (const a of annotations) if (!numbers.has(a.url)) numbers.set(a.url, numbers.size + 1);
  for (const a of [...annotations].sort((a, b) => b.start_index - a.start_index)) {
    const url = safeUrl(a.url).replace(/[<>]/g, c => encodeURIComponent(c));
    text = `${text.slice(0, a.start_index)} [${numbers.get(a.url)}](<${url}>)${text.slice(a.end_index)}`;
  }
  // The provider may emit a citation marker without a valid URL annotation.
  text = text.replace(/cite[^]*/g, ' [citation unavailable]');
  container.classList.remove('streaming');
  container.innerHTML = DOMPurify.sanitize(marked.parse(text), {
    FORBID_TAGS: ['img', 'svg', 'math', 'style', 'form', 'input', 'button', 'iframe', 'video', 'audio'],
    FORBID_ATTR: ['style', 'id', 'name'],
  });
  for (const link of container.querySelectorAll('a')) {
    const href = safeUrl(link.getAttribute('href'));
    if (!href) { link.replaceWith(document.createTextNode(link.textContent)); continue; }
    link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    if (/^\d+$/.test(link.textContent) && numbers.has(href)) {
      link.className = 'citation'; link.setAttribute('aria-label', `Source ${link.textContent}: ${new URL(href).hostname}`);
    }
  }
  for (const table of container.querySelectorAll('table')) {
    const wrapper = element('div', 'table-wrap'); table.replaceWith(wrapper); wrapper.append(table);
  }
}

function evidencePanel(evidence) {
  const sources = evidence.sources || [];
  const recall = evidence.recall;
  const details = element('details', 'evidence');
  const bits = [`${sources.filter(s => s.cited).length} cited sources`];
  if (recall) bits.push(`${recall.included} earlier turns in context`);
  if (evidence.total_ms !== undefined) bits.push(`${(evidence.total_ms / 1000).toFixed(1)}s`);
  if (evidence.imported) bits.push('Imported history · unverified');
  details.append(element('summary', '', bits.join(' · ')));
  if (evidence.imported) details.append(element('p', '', 'This is a user-supplied baseline. Its claims and any URLs inside it have not been verified.'));
  if (sources.length) {
    details.append(element('h4', '', 'Web evidence'));
    const list = element('ul');
    for (const source of sources) {
      const url = safeUrl(source.url); if (!url) continue;
      const item = element('li');
      const link = element('a', '', `${source.title} · ${new URL(url).hostname}`);
      link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link);
      item.append(document.createTextNode(source.cited ? ' · cited' : ' · consulted, not cited'));
      if (source.checked_at) item.append(document.createTextNode(` · retrieved ${dateLabel(source.checked_at)}`));
      list.append(item);
    }
    details.append(list, element('p', '', 'Retrieval time is not the publication or effective date. A citation link alone does not guarantee that a claim is supported.'));
  }
  if (recall) {
    details.append(element('h4', '', 'Conversation context'));
    const list = element('ul');
    for (const turn of recall.turns || []) list.append(element('li', '', `${turn.date} · ${turn.thread} · ${turn.question}`));
    details.append(list);
    if (recall.omitted) details.append(element('p', '', `${recall.omitted} turns were outside this answer's context. Recall may miss a baseline; refine its date or wording if needed.`));
    for (const hint of recall.calendar || []) details.append(element('p', '', `Calendar assumption: “${hint.phrase}” → ${hint.date} (${timezone}).`));
  }
  if (evidence.searches?.length) {
    details.append(element('h4', '', 'Search activity'));
    for (const search of evidence.searches) details.append(element('p', '', `${search.type || 'search'} · ${(search.queries || []).join(' | ') || 'page evidence'} · ${search.status || 'unknown'}`));
  }
  if (evidence.model) details.append(element('p', '', `${evidence.model} · ${evidence.first_token_ms ?? '—'} ms to first text token · ${evidence.usage?.total_tokens ?? '—'} answer-call tokens`));
  return details;
}

function appendTurn(turn) {
  const article = element('article', 'turn');
  const label = element('div', 'message-label', 'YOU');
  const time = element('time', '', dateLabel(turn.created_at)); time.dateTime = turn.created_at; label.append(time);
  article.append(label, element('div', 'question', turn.question), element('div', 'message-label', '✳ THREADWISE'));
  const answer = element('div', 'answer'); article.append(answer);
  if (turn.status === 'completed') {
    renderAnswer(answer, turn.answer, turn.evidence); article.append(evidencePanel(turn.evidence || {}));
  } else if (turn.status !== 'running') {
    answer.textContent = turn.answer; answer.classList.add('streaming');
    const error = element('div', 'error', turn.evidence?.error || 'This answer was interrupted. Partial text is not used as a historical answer.');
    error.append(document.createElement('br'));
    const retry = element('button', 'retry', 'Ask again'); retry.type = 'button';
    retry.onclick = () => { $('#message').value = turn.question; $('#message').focus(); };
    error.append(retry); article.append(error);
  }
  $('#messages').append(article); return { article, answer };
}

async function refreshThreads() {
  state.threads = await api('/api/threads');
  const nav = $('#threads'); nav.replaceChildren();
  if (!state.threads.length) nav.append(element('p', 'empty-history', 'Your conversations will find a home here.'));
  for (const thread of state.threads) {
    const button = element('button', thread.id === state.thread ? 'active' : '', `◦  ${thread.title}`);
    button.title = thread.title; button.disabled = Boolean(state.controller);
    if (thread.id === state.thread) button.setAttribute('aria-current', 'page');
    button.onclick = () => openThread(thread.id).catch(e => toast(e.message)); nav.append(button);
  }
}

async function openThread(id) {
  const data = await api(`/api/threads/${id}`);
  state.thread = id;
  localStorage.setItem('threadwise-current', id);
  $('#messages').replaceChildren();
  for (const turn of data.turns) appendTurn(turn);
  $('#welcome').hidden = data.turns.length > 0;
  $('#delete-chat').hidden = false;
  setHistoryOpen(false);
  await refreshThreads();
}

async function newChat() {
  const thread = await api('/api/threads', { method: 'POST' });
  await openThread(thread.id); $('#message').focus();
}

function setBusy(value) {
  for (const selector of ['#new-chat', '#import', '#delete-chat', '#send']) $(selector).disabled = value;
  for (const node of $('#threads').querySelectorAll('button')) node.disabled = value;
  $('#send').hidden = value; $('#stop').hidden = !value;
}

function scrollBottom() { window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }); }

async function send(event) {
  event.preventDefault();
  const question = $('#message').value.trim();
  if (!question || state.controller) return;
  if (!state.configured) { toast('Add OPENAI_API_KEY to .env and restart the server to chat.'); return; }
  try {
    if (!state.thread) await newChat();
    const threadId = state.thread;
    state.controller = new AbortController(); setBusy(true);
    $('#welcome').hidden = true;
    const { article, answer } = appendTurn({ question, created_at: new Date().toISOString(), status: 'running' });
    answer.classList.add('streaming'); $('#message').value = ''; $('#message').style.height = '';
    $('#activity').textContent = 'Connecting…'; scrollBottom();
    let done = false;
    const response = await fetch(`/api/threads/${threadId}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: question, timezone }), signal: state.controller.signal });
    if (!response.ok) throw new Error((await response.json()).error || 'The request failed.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        const type = frame.match(/^event: (.+)$/m)?.[1];
        const json = frame.match(/^data: (.+)$/m)?.[1];
        if (!json || !type) continue;
        const data = JSON.parse(json);
        if (type === 'delta') answer.textContent += data.text;
        if (type === 'status') $('#activity').textContent = data.text;
        if (type === 'done') { renderAnswer(answer, data.answer, data.evidence); article.append(evidencePanel(data.evidence)); done = true; }
        if (type === 'error') { article.append(element('div', 'error', data.message)); done = true; }
      }
      if (window.scrollY + window.innerHeight > document.body.scrollHeight - 250) scrollBottom();
    }
    if (!done) throw new Error('The connection ended before the answer completed. Partial text is not a completed answer.');
  } catch (error) {
    const message = error.name === 'AbortError' ? 'Stopped. Partial text will not be used as a completed answer.' : error.message;
    toast(message);
    const last = $('#messages .turn:last-child');
    if (last) last.append(element('div', 'error', message));
  } finally {
    state.controller = null; setBusy(false); $('#activity').textContent = '';
    await refreshThreads().catch(e => toast(e.message)); $('#message').focus();
  }
}

$('#composer').addEventListener('submit', send);
$('#message').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer').requestSubmit(); }
});
$('#message').addEventListener('input', () => { $('#message').style.height = 'auto'; $('#message').style.height = `${Math.min($('#message').scrollHeight, 180)}px`; });
$('#new-chat').onclick = () => newChat().catch(e => toast(e.message));
$('#stop').onclick = () => state.controller?.abort();
function setHistoryOpen(open) {
  const sidebar = $('.sidebar');
  const wasOpen = sidebar.classList.contains('open');
  sidebar.classList.toggle('open', open);
  sidebar.inert = !open;
  $('#menu').setAttribute('aria-expanded', String(open));
  if (open) requestAnimationFrame(() => $('#close-history').focus());
  else if (wasOpen) $('#menu').focus();
}
$('#menu').onclick = () => setHistoryOpen(!$('.sidebar').classList.contains('open'));
$('#close-history').onclick = () => setHistoryOpen(false);
$('#delete-chat').onclick = async () => {
  if (!state.thread || !confirm('Delete this conversation and its stored evidence?')) return;
  try {
    await api(`/api/threads/${state.thread}`, { method: 'DELETE' });
    state.thread = null; localStorage.removeItem('threadwise-current');
    $('#messages').replaceChildren(); $('#welcome').hidden = false; $('#delete-chat').hidden = true;
    await refreshThreads();
  } catch (e) { toast(e.message); }
};
$('#import').onclick = () => $('#history-file').click();
$('#history-file').onchange = async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 1_000_000) throw new Error('Use a history file smaller than 1 MB.');
    const body = JSON.parse(await file.text());
    const result = await api('/api/history/import', { method: 'POST', body: JSON.stringify(body) });
    await refreshThreads(); toast(`Imported ${result.imported} turns as unverified historical context.`);
    if (state.threads[0]) await openThread(state.threads[0].id);
  } catch (e) { toast(e.message); }
  finally { event.target.value = ''; }
};
$('#export').onclick = async () => {
  try {
    const history = await api('/api/history/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' }));
    const link = element('a'); link.href = url; link.download = 'threadwise-history.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { toast(e.message); }
};
for (const suggestion of document.querySelectorAll('[data-prompt]')) suggestion.onclick = () => { $('#message').value = suggestion.dataset.prompt; $('#message').dispatchEvent(new Event('input')); $('#message').focus(); };
document.addEventListener('keydown', event => {
  if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && !state.controller) {
    event.preventDefault(); newChat().catch(e => toast(e.message));
  }
  if (event.key === 'Escape') setHistoryOpen(false);
});

async function init() {
  const config = await api('/api/config'); state.configured = config.configured; $('#setup').hidden = config.configured;
  $('#delete-chat').hidden = true;
  await refreshThreads();
  const saved = localStorage.getItem('threadwise-current');
  if (saved && state.threads.some(t => t.id === saved)) await openThread(saved);
}
init().catch(e => toast(e.message));
