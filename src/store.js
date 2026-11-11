import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS thread_owner ON threads(owner);
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, timezone TEXT NOT NULL, question TEXT NOT NULL,
        answer TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'running',
        completed_at TEXT, evidence TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS turn_thread_date ON turns(thread_id, created_at);
    `);
    // An interrupted process must never leave a partial answer looking authoritative.
    this.db.exec("UPDATE turns SET status = 'interrupted' WHERE status = 'running'");
  }

  close() { this.db.close(); }
  threads(owner) {
    return this.db.prepare(`SELECT t.*, COALESCE(MAX(u.created_at), t.created_at) AS updated_at
      FROM threads t LEFT JOIN turns u ON u.thread_id = t.id WHERE owner = ?
      GROUP BY t.id ORDER BY updated_at DESC, t.rowid DESC`).all(owner);
  }
  thread(owner, id) {
    return this.db.prepare('SELECT * FROM threads WHERE owner = ? AND id = ?').get(owner, id);
  }
  createThread(owner, title = 'New conversation', createdAt = new Date().toISOString()) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(id, owner, title, createdAt);
    return this.thread(owner, id);
  }
  removeThread(owner, id) {
    return this.db.prepare('DELETE FROM threads WHERE owner = ? AND id = ?').run(owner, id).changes > 0;
  }
  history(owner) {
    return this.db.prepare(`SELECT u.*, t.title AS thread_title FROM turns u
      JOIN threads t ON t.id = u.thread_id WHERE t.owner = ? ORDER BY u.created_at, u.rowid`).all(owner)
      .map(row => ({ ...row, evidence: JSON.parse(row.evidence) }));
  }
  turns(owner, id) { return this.history(owner).filter(turn => turn.thread_id === id); }
  beginTurn(owner, threadId, question, timezone, now = new Date().toISOString()) {
    if (!this.thread(owner, threadId)) return null;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO turns (id, thread_id, created_at, timezone, question)
      VALUES (?, ?, ?, ?, ?)`).run(id, threadId, now, timezone, question);
    this.db.prepare(`UPDATE threads SET title = ? WHERE id = ? AND title = 'New conversation'`)
      .run(question.slice(0, 65), threadId);
    return id;
  }
  finishTurn(id, answer, status, evidence, now = new Date().toISOString()) {
    this.db.prepare('UPDATE turns SET answer = ?, status = ?, evidence = ?, completed_at = ? WHERE id = ?')
      .run(answer, status, JSON.stringify(evidence), now, id);
  }
  importHistory(owner, threads) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const thread of threads) {
        const created = this.createThread(owner, thread.title, thread.turns[0]?.created_at);
        for (const turn of thread.turns) {
          const id = this.beginTurn(owner, created.id, turn.question, turn.timezone, turn.created_at);
          this.finishTurn(id, turn.answer, 'completed', { imported: true, sources: [], searches: [] }, turn.created_at);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
