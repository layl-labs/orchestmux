import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR is resolved once at module load, so the env has to be set before
// the import — hence the dynamic import below.
const HOME = mkdtempSync(join(tmpdir(), 'orchestmux-db-'));
process.env.ORCHESTMUX_HOME = HOME;

const DB_PATH = join(HOME, 'state.db');
let db;

before(async () => {
  db = await import('../dist/db.js');
});

after(() => rmSync(HOME, { recursive: true, force: true }));

/** Drops the database so a test can start from a schema of its own choosing. */
function resetDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${DB_PATH}${suffix}`, { force: true });
  }
}

test('newId is prefixed and short enough for an agent to retype', () => {
  const id = db.newId('t');
  assert.match(id, /^t_[0-9a-f]{8}$/);
  assert.notEqual(id, db.newId('t'));
});

test('openDb creates the schema and is safe to call twice', () => {
  resetDb();
  const a = db.openDb();
  a.prepare(`INSERT INTO tasks VALUES ('t_1', 'spec', 'pending', NULL, NULL, ?, ?)`).run(
    db.now(),
    db.now(),
  );
  a.close();

  const b = db.openDb();
  assert.equal(db.getTask(b, 't_1')?.spec, 'spec');
  assert.equal(db.listTasks(b).length, 1);
  b.close();
});

test('openDb keeps WAL on, so concurrent panes can report at once', () => {
  resetDb();
  const conn = db.openDb();
  const mode = conn.prepare('PRAGMA journal_mode').get();
  assert.equal(String(Object.values(mode)[0]).toLowerCase(), 'wal');
  conn.close();
});

test('migrate backfills window and autonomous on a pre-0.1 workers table', () => {
  resetDb();
  // The shape shipped before panes could live in the caller's own window.
  const legacy = new DatabaseSync(DB_PATH);
  legacy.exec(`
    CREATE TABLE workers (
      name TEXT PRIMARY KEY, agent TEXT NOT NULL, pane_id TEXT NOT NULL,
      session TEXT NOT NULL, cwd TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  legacy
    .prepare('INSERT INTO workers VALUES (?, ?, ?, ?, ?, ?)')
    .run('w1', 'codex', '%1', 'dev', '/tmp', '2026-01-01T00:00:00.000Z');
  legacy.close();

  const conn = db.openDb();
  const w = db.getWorker(conn, 'w1');
  assert.equal(w.window, 'dev:workers', 'existing rows must resolve to their old implicit window');
  assert.equal(w.autonomous, 0, 'an unknown worker must not be assumed autonomous');

  // Re-running must not clobber the backfill or throw on the second attempt.
  conn.close();
  const again = db.openDb();
  assert.equal(db.getWorker(again, 'w1').window, 'dev:workers');
  again.close();
});

test('insertMessage returns the id a reply has to target', () => {
  resetDb();
  const conn = db.openDb();
  const id = db.insertMessage(conn, {
    type: 'ask',
    task_id: 't_1',
    from_worker: 'w1',
    to_worker: null,
    subject: 'w1 asks',
    body: 'which branch?',
    reply_to: null,
  });
  assert.match(id, /^m_[0-9a-f]{8}$/);

  const row = conn.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  assert.equal(row.read_at, null, 'a new message must start unread or wait would skip it');
  assert.equal(row.to_worker, null, 'null recipient is what marks it as bound for the coordinator');
  assert.equal(row.body, 'which branch?');
  conn.close();
});

test('listWorkers and listTasks are ordered by creation', () => {
  resetDb();
  const conn = db.openDb();
  const insert = conn.prepare(
    `INSERT INTO tasks VALUES (?, ?, 'pending', NULL, NULL, ?, ?)`,
  );
  insert.run('t_second', 'b', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  insert.run('t_first', 'a', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  assert.deepEqual(
    db.listTasks(conn).map((t) => t.id),
    ['t_first', 't_second'],
  );
  conn.close();
});

test('getTask and getWorker return undefined rather than throwing', () => {
  resetDb();
  const conn = db.openDb();
  assert.equal(db.getTask(conn, 'nope'), undefined);
  assert.equal(db.getWorker(conn, 'nope'), undefined);
  conn.close();
});
