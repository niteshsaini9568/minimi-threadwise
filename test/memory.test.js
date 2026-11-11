import test from 'node:test';
import assert from 'node:assert/strict';
import { localDate, dateHints, makeMemory, selectedMemory, validTimezone } from '../src/memory.js';

const NOW = '2026-11-11T12:00:00Z';
const record = (id, created_at, thread_id = 'old', question = 'Postgres hosting') => ({
  id, created_at, completed_at: created_at, thread_id, thread_title: 'Research', timezone: 'UTC',
  question, answer: 'Original answer. '.repeat(60), status: 'completed', evidence: { sources: [{ url: 'https://example.com/old' }] },
});

test('calendar is based on the user timezone, not the server day', () => {
  assert.equal(localDate('2026-11-03T00:15:00Z', 'America/Los_Angeles'), '2026-11-02');
  assert.equal(localDate('2026-11-02T23:15:00Z', 'Asia/Kolkata'), '2026-11-03');
  assert.equal(validTimezone('Mars/Olympus'), false);
  assert.equal(validTimezone('Asia/Calcutta'), true);
});
test('challenge date references resolve to specific calendar days', () => {
  assert.deepEqual(dateHints('Last Tuesday I asked about hosting; on Monday we shortlisted CRMs.', NOW, 'Asia/Kolkata').map(h => h.date), ['2026-11-10', '2026-11-09']);
  assert.equal(dateHints('What did I ask on 3 November?', NOW, 'UTC')[0].date, '2026-11-03');
  assert.equal(dateHints('November 3rd, 2026', NOW, 'UTC')[0].date, '2026-11-03');
  assert.equal(dateHints('2026-11-03', NOW, 'UTC')[0].date, '2026-11-03');
});
test('last same weekday is a week ago; this weekday uses the ISO week', () => {
  assert.equal(dateHints('last Wednesday', NOW, 'UTC')[0].date, '2026-11-04');
  assert.equal(dateHints('this Friday', NOW, 'UTC')[0].date, '2026-11-13');
  assert.equal(dateHints('this Sunday', NOW, 'UTC')[0].date, '2026-11-15');
});
test('omitted year means most recent past occurrence; impossible dates are ignored', () => {
  assert.equal(dateHints('December 25', NOW, 'UTC')[0].date, '2025-12-25');
  assert.deepEqual(dateHints('31 November and 2026-02-30', NOW, 'UTC'), []);
});
test('DST transitions and year boundaries use calendar days', () => {
  assert.equal(dateHints('yesterday', '2026-11-02T06:30:00Z', 'America/New_York')[0].date, '2026-11-01');
  assert.equal(dateHints('last Tuesday', '2027-01-01T12:00:00Z', 'UTC')[0].date, '2026-12-29');
});
test('small history retains exact answers, source URLs and other threads', () => {
  const turns = [record('a', '2026-11-03T10:00:00Z'), record('b', '2026-11-10T10:00:00Z', 'current')];
  const memory = makeMemory(turns, 'Still true?', 'current', NOW, 'UTC');
  assert.equal(memory.needsSelection, false);
  assert.equal(memory.omitted, 0);
  assert.equal(memory.records[0].answer, turns[0].answer);
  assert.equal(memory.records[0].sources[0].url, 'https://example.com/old');
});
test('long history pins exact-date baselines and reports omitted turns under budget', () => {
  const turns = [record('baseline', '2026-11-03T10:00:00Z'), ...Array.from({ length: 100 }, (_, i) => record(`filler-${i}`, '2026-11-08T10:00:00Z', 'other', 'Unrelated topic')), record('recent', '2026-11-10T10:00:00Z', 'current')];
  const memory = makeMemory(turns, 'What did I ask on 3 November?', 'current', NOW, 'UTC', 5500);
  assert.equal(memory.needsSelection, true);
  const selected = selectedMemory(memory, ['filler-0']);
  assert.ok(selected.records.some(r => r.id === 'baseline'));
  assert.ok(selected.records.some(r => r.id === 'recent'));
  assert.ok(JSON.stringify(selected.records).length <= 5500);
  assert.equal(selected.omitted, turns.length - selected.records.length);
});
test('incomplete answers never become evidence but questions remain recallable', () => {
  const turn = { ...record('broken', NOW), status: 'interrupted', answer: 'Unverified partial claim' };
  const memory = makeMemory([turn], 'What did I ask?', 'x', NOW, 'UTC');
  assert.equal(memory.records[0].answer, null);
  assert.equal(memory.records[0].question, 'Postgres hosting');
});
