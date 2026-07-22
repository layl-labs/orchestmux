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

function insertTask(conn, id, session, spec, at) {
  conn
    .prepare(
      `INSERT INTO tasks (id, session, spec, status, assignee, result, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
    )
    .run(id, session, spec, at, at);
}

test('newId is prefixed and short enough for an agent to retype', () => {
  const id = db.newId('t');
  assert.match(id, /^t_[0-9a-f]{8}$/);
  assert.notEqual(id, db.newId('t'));
});

test('openDb creates the schema and is safe to call twice', () => {
  resetDb();
  const a = db.openDb();
  insertTask(a, 't_1', 'orchestmux', 'spec', db.now());
  a.close();

  const b = db.openDb();
  assert.equal(db.getTask(b, 't_1')?.spec, 'spec');
  assert.equal(db.listTasks(b, 'orchestmux').length, 1);
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
  const w = db.getWorker(conn, 'dev', 'w1');
  assert.equal(w.window, 'dev:workers', 'existing rows must resolve to their old implicit window');
  assert.equal(w.autonomous, 0, 'an unknown worker must not be assumed autonomous');

  // Re-running must not clobber the backfill or throw on the second attempt.
  conn.close();
  const again = db.openDb();
  assert.equal(db.getWorker(again, 'dev', 'w1').window, 'dev:workers');
  again.close();
});

test('migrate scopes a pre-0.4 global database into sessions', () => {
  resetDb();
  // Pre-0.4: workers keyed by name alone, tasks and messages one global pool.
  const legacy = new DatabaseSync(DB_PATH);
  legacy.exec(`
    CREATE TABLE workers (
      name TEXT PRIMARY KEY, agent TEXT NOT NULL, pane_id TEXT NOT NULL,
      session TEXT NOT NULL, cwd TEXT NOT NULL, created_at TEXT NOT NULL,
      window TEXT NOT NULL DEFAULT '', autonomous INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, spec TEXT NOT NULL, status TEXT NOT NULL,
      assignee TEXT, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, task_id TEXT,
      from_worker TEXT, to_worker TEXT, subject TEXT, body TEXT,
      reply_to TEXT, created_at TEXT NOT NULL, read_at TEXT
    );
  `);
  legacy
    .prepare(`INSERT INTO workers VALUES ('w1', 'codex', '%1', 'dev', '/tmp', ?, 'dev:@1', 0)`)
    .run('2026-01-01T00:00:00.000Z');
  legacy
    .prepare(`INSERT INTO tasks VALUES ('t_old', 'old spec', 'pending', NULL, NULL, ?, ?)`)
    .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  legacy
    .prepare(`INSERT INTO messages VALUES ('m_old', 'done', 't_old', 'w1', NULL, NULL, 'x', NULL, ?, NULL)`)
    .run('2026-01-01T00:00:00.000Z');
  legacy.close();

  const conn = db.openDb();

  // Old global rows land in the default session — the only owner they had.
  assert.equal(db.getTask(conn, 't_old').session, 'orchestmux');
  assert.equal(
    conn.prepare(`SELECT session FROM messages WHERE id = 'm_old'`).get().session,
    'orchestmux',
  );

  // The primary key is now (session, name): the same worker name in another
  // session must not collide.
  conn
    .prepare(
      `INSERT INTO workers (session, name, agent, pane_id, window, autonomous, cwd, created_at)
       VALUES ('other', 'w1', 'kimi', '%2', 'other:workers', 0, '/tmp', ?)`,
    )
    .run(db.now());
  assert.equal(db.getWorker(conn, 'dev', 'w1').agent, 'codex');
  assert.equal(db.getWorker(conn, 'other', 'w1').agent, 'kimi');

  // Re-running the migration must be a no-op, not a second rebuild.
  conn.close();
  const again = db.openDb();
  assert.equal(db.getWorker(again, 'other', 'w1').agent, 'kimi');
  again.close();
});

test('insertMessage returns the id a reply has to target', () => {
  resetDb();
  const conn = db.openDb();
  const id = db.insertMessage(conn, {
    session: 'orchestmux',
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
  assert.equal(row.session, 'orchestmux', 'a message without a session would be invisible to every wait');
  assert.equal(row.body, 'which branch?');
  conn.close();
});

test('listTasks is ordered by creation and scoped to its session', () => {
  resetDb();
  const conn = db.openDb();
  insertTask(conn, 't_second', 'orchestmux', 'b', '2026-01-02T00:00:00.000Z');
  insertTask(conn, 't_first', 'orchestmux', 'a', '2026-01-01T00:00:00.000Z');
  insertTask(conn, 't_other', 'elsewhere', 'c', '2026-01-01T00:00:00.000Z');
  assert.deepEqual(
    db.listTasks(conn, 'orchestmux').map((t) => t.id),
    ['t_first', 't_second'],
  );
  assert.deepEqual(
    db.listTasks(conn, 'elsewhere').map((t) => t.id),
    ['t_other'],
  );
  conn.close();
});

test('getTask and getWorker return undefined rather than throwing', () => {
  resetDb();
  const conn = db.openDb();
  assert.equal(db.getTask(conn, 'nope'), undefined);
  assert.equal(db.getWorker(conn, 'orchestmux', 'nope'), undefined);
  conn.close();
});
