import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const STATE_DIR = process.env.ORCHESTMUX_HOME ?? join(homedir(), '.orchestmux');

export type TaskStatus = 'pending' | 'dispatched' | 'done' | 'failed';
export type MessageType = 'done' | 'ask' | 'reply' | 'status' | 'escalation';

export interface Worker {
  name: string;
  agent: string;
  pane_id: string;
  session: string;
  /** tmux window the pane lives in, e.g. "orchestmux:workers" or "dev:@3". */
  window: string;
  /** 1 when the worker was spawned with --yolo; re-applied on every relaunch. */
  autonomous: number;
  cwd: string;
  created_at: string;
}

export interface Task {
  id: string;
  spec: string;
  status: TaskStatus;
  assignee: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
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
      name       TEXT PRIMARY KEY,
      agent      TEXT NOT NULL,
      pane_id    TEXT NOT NULL,
      session    TEXT NOT NULL,
      cwd        TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id         TEXT PRIMARY KEY,
      spec       TEXT NOT NULL,
      status     TEXT NOT NULL,
      assignee   TEXT,
      result     TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
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
    CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages (to_worker, read_at, type);
    CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages (reply_to);
  `);
  migrate(db);
  return db;
}

/** Additive-only migrations; each is safe to attempt on an already-migrated db. */
function migrate(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(workers)').all() as unknown as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (!columns.has('window')) {
    db.exec(`ALTER TABLE workers ADD COLUMN window TEXT NOT NULL DEFAULT ''`);
    db.exec(`UPDATE workers SET window = session || ':workers' WHERE window = ''`);
  }
  if (!columns.has('autonomous')) {
    db.exec(`ALTER TABLE workers ADD COLUMN autonomous INTEGER NOT NULL DEFAULT 0`);
  }
}

export function insertMessage(
  db: DatabaseSync,
  m: Omit<Message, 'id' | 'created_at' | 'read_at'>,
): string {
  const id = newId('m');
  db.prepare(
    `INSERT INTO messages (id, type, task_id, from_worker, to_worker, subject, body, reply_to, created_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(id, m.type, m.task_id, m.from_worker, m.to_worker, m.subject, m.body, m.reply_to, now());
  return id;
}

export function getWorker(db: DatabaseSync, name: string): Worker | undefined {
  return db.prepare('SELECT * FROM workers WHERE name = ?').get(name) as Worker | undefined;
}

export function listWorkers(db: DatabaseSync): Worker[] {
  return db.prepare('SELECT * FROM workers ORDER BY created_at').all() as unknown as Worker[];
}

export function getTask(db: DatabaseSync, id: string): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
}

export function listTasks(db: DatabaseSync): Task[] {
  return db.prepare('SELECT * FROM tasks ORDER BY created_at').all() as unknown as Task[];
}
