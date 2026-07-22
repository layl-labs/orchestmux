import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const STATE_DIR = process.env.ORCHESTMUX_HOME ?? join(homedir(), '.orchestmux');

export type TaskStatus = 'pending' | 'dispatched' | 'done' | 'failed';
export type MessageType = 'done' | 'ask' | 'reply' | 'escalation';

export interface Worker {
  /**
   * The swarm this worker belongs to. Usually also the name of the tmux
   * session its pane lives in — but not with --here, where the pane sits in
   * the caller's own window and this stays the logical swarm name. `window`
   * records where the pane actually is.
   */
  session: string;
  name: string;
  agent: string;
  pane_id: string;
  /** tmux window the pane lives in, e.g. "orchestmux:workers" or "dev:@3". */
  window: string;
  /** 1 when the worker was spawned with --yolo; re-applied on every relaunch. */
  autonomous: number;
  cwd: string;
  created_at: string;
}

export interface Task {
  id: string;
  session: string;
  spec: string;
  status: TaskStatus;
  assignee: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  session: string;
  type: MessageType;
  task_id: string | null;
  from_worker: string | null;
  to_worker: string | null;
  subject: string | null;
  body: string | null;
  reply_to: string | null;
  created_at: string;
  read_at: string | null;
}

/** Short, human-quotable ids: agents have to retype these into a CLI call. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function openDb(): DatabaseSync {
  mkdirSync(STATE_DIR, { recursive: true });
  const db = new DatabaseSync(join(STATE_DIR, 'state.db'));
  // WAL + a generous busy timeout: several agent panes may call `done` at once.
  //
  // busy_timeout has to be set FIRST. Switching journal modes takes a lock of
  // its own, so with the timeout still at 0 an openDb() racing a live writer
  // fails instantly with SQLITE_BUSY — and a worker whose `done` dies that way
  // leaves the coordinator waiting on a report that will never come.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS workers (
      session    TEXT NOT NULL,
      name       TEXT NOT NULL,
      agent      TEXT NOT NULL,
      pane_id    TEXT NOT NULL,
      window     TEXT NOT NULL,
      autonomous INTEGER NOT NULL DEFAULT 0,
      cwd        TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session, name)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id         TEXT PRIMARY KEY,
      session    TEXT NOT NULL DEFAULT 'orchestmux',
      spec       TEXT NOT NULL,
      status     TEXT NOT NULL,
      assignee   TEXT,
      result     TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      session     TEXT NOT NULL DEFAULT 'orchestmux',
      type        TEXT NOT NULL,
      task_id     TEXT,
      from_worker TEXT,
      to_worker   TEXT,
      subject     TEXT,
      body        TEXT,
      reply_to    TEXT,
      created_at  TEXT NOT NULL,
      read_at     TEXT
    );
  `);
  migrate(db);
  // After migrate: on a pre-0.4 database the session columns only exist now.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session_inbox
      ON messages (session, to_worker, read_at, type);
    CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages (reply_to);
  `);
  return db;
}

function columns(db: DatabaseSync, table: string): Map<string, { pk: number }> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
    name: string;
    pk: number;
  }[];
  return new Map(rows.map((c) => [c.name, { pk: c.pk }]));
}

/** Each step is additive and safe to attempt on an already-migrated db. */
function migrate(db: DatabaseSync): void {
  const workers = columns(db, 'workers');
  if (!workers.has('window')) {
    db.exec(`ALTER TABLE workers ADD COLUMN window TEXT NOT NULL DEFAULT ''`);
    db.exec(`UPDATE workers SET window = session || ':workers' WHERE window = ''`);
  }
  if (!workers.has('autonomous')) {
    db.exec(`ALTER TABLE workers ADD COLUMN autonomous INTEGER NOT NULL DEFAULT 0`);
  }
  // Pre-0.4 the primary key was `name` alone, which made worker names collide
  // across swarms. SQLite cannot alter a primary key, so rebuild the table.
  if (workers.get('session')?.pk === 0) {
    db.exec(`
      CREATE TABLE workers_migrate (
        session    TEXT NOT NULL,
        name       TEXT NOT NULL,
        agent      TEXT NOT NULL,
        pane_id    TEXT NOT NULL,
        window     TEXT NOT NULL,
        autonomous INTEGER NOT NULL DEFAULT 0,
        cwd        TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session, name)
      );
      INSERT INTO workers_migrate (session, name, agent, pane_id, window, autonomous, cwd, created_at)
        SELECT session, name, agent, pane_id, window, autonomous, cwd, created_at FROM workers;
      DROP TABLE workers;
      ALTER TABLE workers_migrate RENAME TO workers;
    `);
  }
  // Pre-0.4 tasks and messages were one global pool, so two swarms stole each
  // other's reports. Existing rows land in the default session — the only
  // owner they could have had.
  if (!columns(db, 'tasks').has('session')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN session TEXT NOT NULL DEFAULT 'orchestmux'`);
  }
  if (!columns(db, 'messages').has('session')) {
    db.exec(`ALTER TABLE messages ADD COLUMN session TEXT NOT NULL DEFAULT 'orchestmux'`);
  }
}

export function insertMessage(
  db: DatabaseSync,
  m: Omit<Message, 'id' | 'created_at' | 'read_at'>,
): string {
  const id = newId('m');
  db.prepare(
    `INSERT INTO messages (id, session, type, task_id, from_worker, to_worker, subject, body, reply_to, created_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    m.session,
    m.type,
    m.task_id,
    m.from_worker,
    m.to_worker,
    m.subject,
    m.body,
    m.reply_to,
    now(),
  );
  return id;
}

export function getWorker(db: DatabaseSync, session: string, name: string): Worker | undefined {
  return db
    .prepare('SELECT * FROM workers WHERE session = ? AND name = ?')
    .get(session, name) as Worker | undefined;
}

export function listWorkers(db: DatabaseSync, session: string): Worker[] {
  return db
    .prepare('SELECT * FROM workers WHERE session = ? ORDER BY created_at')
    .all(session) as unknown as Worker[];
}

export function getTask(db: DatabaseSync, id: string): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
}

export function listTasks(db: DatabaseSync, session: string): Task[] {
  return db
    .prepare('SELECT * FROM tasks WHERE session = ? ORDER BY created_at')
    .all(session) as unknown as Task[];
}
