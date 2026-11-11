import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

test('SQLite persists exact turns and evidence across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'threadwise-test-'));
  const file = join(dir, 'test.sqlite');
  let store = new Store(file);
  try {
    const thread = store.createThread('alice');
    const id = store.beginTurn('alice', thread.id, 'Price?', 'UTC', '2026-11-03T12:00:00Z');
    store.finishTurn(id, '$19, annual billing', 'completed', { sources: [{ url: 'https://example.com' }] });
    store.close(); store = new Store(file);
    assert.equal(store.history('alice')[0].answer, '$19, annual billing');
    assert.equal(store.history('alice')[0].evidence.sources[0].url, 'https://example.com');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('owners cannot read, mutate or delete each other’s histories', () => {
  const store = new Store(':memory:');
  try {
    const thread = store.createThread('alice');
    store.beginTurn('alice', thread.id, 'Private shortlist', 'UTC');
    assert.equal(store.thread('bob', thread.id), undefined);
    assert.deepEqual(store.history('bob'), []);
    assert.equal(store.beginTurn('bob', thread.id, 'attack', 'UTC'), null);
    assert.equal(store.removeThread('bob', thread.id), false);
    assert.equal(store.history('alice').length, 1);
    assert.equal(store.removeThread('alice', thread.id), true);
    assert.equal(store.history('alice').length, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM turns').get().n, 0);
  } finally { store.close(); }
});
test('process recovery marks unfinished turns interrupted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'threadwise-recovery-'));
  const file = join(dir, 'test.sqlite'); let store = new Store(file);
  try {
    const thread = store.createThread('alice');
    store.beginTurn('alice', thread.id, 'Question before crash', 'UTC');
    store.close(); store = new Store(file);
    assert.equal(store.history('alice')[0].status, 'interrupted');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('history import is transactional and marked unverified', () => {
  const store = new Store(':memory:');
  try {
    store.importHistory('alice', [{ title: 'Imported', turns: [{ question: 'Old?', answer: 'Old answer', created_at: '2026-11-03T12:00:00Z', timezone: 'UTC' }] }]);
    assert.equal(store.history('alice')[0].evidence.imported, true);
    assert.throws(() => store.importHistory('alice', [{ title: 'Bad', turns: [{ question: null, timezone: 'UTC', created_at: '2026-11-03T12:00:00Z', answer: 'bad' }] }]));
    assert.equal(store.threads('alice').length, 1);
  } finally { store.close(); }
});
