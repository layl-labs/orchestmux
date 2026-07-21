#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { spawnSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import {
  openDb,
  newId,
  now,
  insertMessage,
  getWorker,
  listWorkers,
  getTask,
  listTasks,
  STATE_DIR,
  type Message,
  type MessageType,
} from './db.js';
import {
  tmuxAvailable,
  hasSession,
  newSession,
  addPane,
  paneAlive,
  killPane,
  capturePane,
  sendPrompt,
  sendEnter,
  tmux,
} from './tmux.js';
import { AGENTS, agentNames, buildCommand, isInstalled } from './agents.js';
import { cliInvocation, dispatchPrompt } from './preamble.js';

const DEFAULT_SESSION = process.env.ORCHESTMUX_SESSION ?? 'orchestmux';
const POLL_MS = 300;

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      _.push(a);
      continue;
    }
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      i++;
    } else if (body.startsWith('no-')) {
      flags[body.slice(3)] = false;
    } else {
      flags[body] = true;
    }
  }
  return { _, flags };
}

function str(args: Args, key: string): string | undefined {
  const v = args.flags[key];
  return typeof v === 'string' ? v : undefined;
}

function bool(args: Args, key: string, dflt: boolean): boolean {
  const v = args.flags[key];
  return typeof v === 'boolean' ? v : dflt;
}

function num(args: Args, key: string, dflt: number): number {
  const v = str(args, key);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function need(args: Args, key: string): string {
  const v = str(args, key);
  if (!v) fail(`missing required --${key}`);
  return v;
}

function fail(msg: string): never {
  console.error(`orchestmux: ${msg}`);
  process.exit(1);
}

function sleep(ms: number): void {
  // Deliberately synchronous: every command here is a short-lived,
  // single-purpose CLI invocation, and blocking keeps control flow obvious.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function session(args: Args): string {
  return str(args, 'session') ?? DEFAULT_SESSION;
}

function whoami(args: Args): string {
  const from = str(args, 'from') ?? process.env.ORCHESTMUX_WORKER;
  if (!from) {
    fail('cannot tell which worker this is — run inside a spawned pane, or pass --from <worker>');
  }
  return from;
}

// ---------------------------------------------------------------- commands

function cmdUp(args: Args): void {
  const s = session(args);
  const cwd = str(args, 'cwd') ?? process.cwd();
  if (hasSession(s)) {
    console.log(`session "${s}" already running`);
    return;
  }
  newSession(s, cwd);
  console.log(`session "${s}" created (cwd: ${cwd})`);
  console.log(`attach with: tmux attach -t ${s}`);
}

function cmdSpawn(db: DatabaseSync, args: Args): void {
  const s = session(args);
  const name = need(args, 'name');
  const agent = str(args, 'agent') ?? 'shell';
  const cwd = str(args, 'cwd') ?? process.cwd();
  const autonomous = bool(args, 'autonomous', false) || bool(args, 'yolo', false);

  if (!AGENTS[agent]) fail(`unknown agent "${agent}" (known: ${agentNames().join(', ')})`);
  if (getWorker(db, name)) fail(`worker "${name}" already exists (orchestmux kill --name ${name})`);
  if (!isInstalled(AGENTS[agent]!.cmd)) fail(`agent binary "${AGENTS[agent]!.cmd}" not found on PATH`);

  if (!hasSession(s)) newSession(s, cwd);

  const existing = listWorkers(db).filter((w) => w.session === s && paneAlive(w.pane_id));
  const command = buildCommand(agent, autonomous, args._.slice(1));
  const paneId = addPane({
    session: s,
    cwd,
    env: { ORCHESTMUX_WORKER: name, ORCHESTMUX_SESSION: s },
    command,
    reuseFirst: existing.length === 0,
  });

  db.prepare(
    `INSERT INTO workers (name, agent, pane_id, session, cwd, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(name, agent, paneId, s, cwd, now());

  console.log(`spawned ${name} (${agent}) in pane ${paneId}`);
  if (!autonomous && AGENTS[agent]!.autonomousArgs.length > 0) {
    console.log(`hint: this agent will stop for approval prompts — re-spawn with --yolo to let it run unattended`);
  }
}

/**
 * Prompts and TUIs are rarely byte-stable: shell themes render a clock, agents
 * animate spinners and elapsed-time counters. Comparing digit-free, whitespace-
 * collapsed text lets "idle" mean "nothing structural is changing".
 */
function settleSignature(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/[0-9]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Best-effort TUI readiness: wait until the pane output stops changing. */
function waitReady(paneId: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  let stable = 0;
  while (Date.now() < deadline) {
    sleep(700);
    let current = '';
    try {
      current = settleSignature(capturePane(paneId, 40));
    } catch {
      return false;
    }
    if (current.length > 0 && current === previous) {
      if (++stable >= 2) return true;
    } else {
      stable = 0;
    }
    previous = current;
  }
  return false;
}

function cmdTask(db: DatabaseSync, args: Args): void {
  const sub = args._[1];
  if (sub === 'add') {
    const spec = args._.slice(2).join(' ') || str(args, 'spec');
    if (!spec) fail('usage: orchestmux task add "<spec>"');
    const id = newId('t');
    const ts = now();
    db.prepare(
      `INSERT INTO tasks (id, spec, status, assignee, result, created_at, updated_at)
       VALUES (?, ?, 'pending', NULL, NULL, ?, ?)`,
    ).run(id, spec, ts, ts);
    console.log(id);
    return;
  }
  if (sub === 'list' || sub === undefined) {
    const tasks = listTasks(db);
    if (bool(args, 'json', false)) {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }
    if (tasks.length === 0) console.log('(no tasks)');
    for (const t of tasks) {
      console.log(`${t.id}  ${t.status.padEnd(10)} ${t.assignee ?? '-'}  ${oneLine(t.spec, 60)}`);
    }
    return;
  }
  fail(`unknown task subcommand "${sub}" (add | list)`);
}

function cmdDispatch(db: DatabaseSync, args: Args): void {
  const taskId = need(args, 'task');
  const to = need(args, 'to');
  const task = getTask(db, taskId) ?? fail(`no such task: ${taskId}`);
  const worker = getWorker(db, to) ?? fail(`no such worker: ${to}`);
  if (!paneAlive(worker.pane_id)) fail(`worker "${to}" pane is gone (orchestmux kill --name ${to})`);

  const readyTimeout = num(args, 'ready-timeout', 60) * 1000;
  if (readyTimeout > 0 && !waitReady(worker.pane_id, readyTimeout)) {
    console.error(`warning: ${to} did not settle within ${readyTimeout / 1000}s — sending anyway`);
  }

  sendPrompt(worker.pane_id, dispatchPrompt({ taskId, spec: task.spec, cli: cliInvocation() }));
  sleep(300); // let the TUI ingest the paste before submitting
  sendEnter(worker.pane_id);

  db.prepare(`UPDATE tasks SET status = 'dispatched', assignee = ?, updated_at = ? WHERE id = ?`).run(
    to,
    now(),
    taskId,
  );
  console.log(`dispatched ${taskId} -> ${to}`);
}

function cmdWait(db: DatabaseSync, args: Args): void {
  const types = (str(args, 'types') ?? 'done,ask,escalation').split(',').map((t) => t.trim());
  const timeoutMs = num(args, 'timeout', 900) * 1000;
  const asJson = bool(args, 'json', false);
  const deadline = Date.now() + timeoutMs;
  const placeholders = types.map(() => '?').join(',');

  while (Date.now() < deadline) {
    const msg = db
      .prepare(
        `SELECT * FROM messages
          WHERE to_worker IS NULL AND read_at IS NULL AND type IN (${placeholders})
          ORDER BY created_at LIMIT 1`,
      )
      .get(...types) as Message | undefined;

    if (msg) {
      db.prepare('UPDATE messages SET read_at = ? WHERE id = ?').run(now(), msg.id);
      if (asJson) {
        console.log(JSON.stringify(msg, null, 2));
      } else {
        console.log(`[${msg.type}] ${msg.from_worker ?? '?'}  task=${msg.task_id ?? '-'}  id=${msg.id}`);
        if (msg.subject) console.log(msg.subject);
        if (msg.body) console.log(msg.body);
        if (msg.type === 'ask') {
          console.log(`\nanswer with: orchestmux reply --id ${msg.id} --body "<answer>"`);
        }
      }
      return;
    }
    sleep(POLL_MS);
  }

  if (asJson) console.log(JSON.stringify({ count: 0, timedOut: true }));
  else console.log(`(no message within ${timeoutMs / 1000}s)`);
  // A timeout is a checkpoint, not a failure — distinct exit code so callers can loop.
  process.exit(2);
}

function cmdDone(db: DatabaseSync, args: Args): void {
  const taskId = need(args, 'task');
  const body = need(args, 'body');
  const from = whoami(args);
  if (!getTask(db, taskId)) fail(`no such task: ${taskId}`);

  const status = bool(args, 'failed', false) ? 'failed' : 'done';
  insertMessage(db, {
    type: 'done',
    task_id: taskId,
    from_worker: from,
    to_worker: null,
    subject: str(args, 'subject') ?? `${from}: ${status}`,
    body,
    reply_to: null,
  });
  db.prepare('UPDATE tasks SET status = ?, result = ?, updated_at = ? WHERE id = ?').run(
    status,
    body,
    now(),
    taskId,
  );
  console.log(`reported ${status} for ${taskId}`);
}

function cmdAsk(db: DatabaseSync, args: Args): void {
  const taskId = need(args, 'task');
  const question = need(args, 'question');
  const from = whoami(args);
  const timeoutMs = num(args, 'timeout', 900) * 1000;

  const askId = insertMessage(db, {
    type: 'ask',
    task_id: taskId,
    from_worker: from,
    to_worker: null,
    subject: `${from} asks`,
    body: question,
    reply_to: null,
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = db
      .prepare(`SELECT * FROM messages WHERE type = 'reply' AND reply_to = ? LIMIT 1`)
      .get(askId) as Message | undefined;
    if (reply) {
      db.prepare('UPDATE messages SET read_at = ? WHERE id = ?').run(now(), reply.id);
      console.log(reply.body ?? '');
      return;
    }
    sleep(POLL_MS);
  }
  console.error(`no answer within ${timeoutMs / 1000}s`);
  process.exit(3);
}

function cmdReply(db: DatabaseSync, args: Args): void {
  const id = need(args, 'id');
  const body = need(args, 'body');
  const target = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Message | undefined;
  if (!target) fail(`no such message: ${id}`);
  insertMessage(db, {
    type: 'reply',
    task_id: target.task_id,
    from_worker: null,
    to_worker: target.from_worker,
    subject: 'coordinator reply',
    body,
    reply_to: id,
  });
  console.log(`replied to ${id}`);
}

function cmdSend(db: DatabaseSync, args: Args): void {
  const to = need(args, 'to');
  const body = need(args, 'body');
  if (!getWorker(db, to)) fail(`no such worker: ${to}`);
  insertMessage(db, {
    type: (str(args, 'type') as MessageType) ?? 'status',
    task_id: str(args, 'task') ?? null,
    from_worker: str(args, 'from') ?? process.env.ORCHESTMUX_WORKER ?? null,
    to_worker: to,
    subject: str(args, 'subject') ?? null,
    body,
    reply_to: null,
  });
  console.log(`sent to ${to}`);
}

function cmdPs(db: DatabaseSync, args: Args): void {
  const workers = listWorkers(db).map((w) => ({ ...w, alive: paneAlive(w.pane_id) }));
  const tasks = listTasks(db);
  const unread = db
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE to_worker IS NULL AND read_at IS NULL')
    .get() as { n: number };

  if (bool(args, 'json', false)) {
    console.log(JSON.stringify({ workers, tasks, unread: unread.n }, null, 2));
    return;
  }

  console.log(`state: ${STATE_DIR}`);
  console.log(`\nWORKERS (${workers.length})`);
  if (workers.length === 0) console.log('  (none)');
  for (const w of workers) {
    console.log(`  ${w.alive ? '●' : '○'} ${w.name.padEnd(12)} ${w.agent.padEnd(10)} ${w.pane_id}  ${w.cwd}`);
  }
  console.log(`\nTASKS (${tasks.length})`);
  if (tasks.length === 0) console.log('  (none)');
  for (const t of tasks) {
    console.log(`  ${t.id}  ${t.status.padEnd(10)} ${(t.assignee ?? '-').padEnd(12)} ${oneLine(t.spec, 50)}`);
  }
  console.log(`\nunread coordinator messages: ${unread.n}`);
}

function cmdKill(db: DatabaseSync, args: Args): void {
  const name = need(args, 'name');
  const w = getWorker(db, name) ?? fail(`no such worker: ${name}`);
  killPane(w.pane_id);
  db.prepare('DELETE FROM workers WHERE name = ?').run(name);
  console.log(`killed ${name}`);
}

function cmdDown(db: DatabaseSync, args: Args): void {
  const s = session(args);
  for (const w of listWorkers(db)) if (w.session === s) killPane(w.pane_id);
  db.prepare('DELETE FROM workers WHERE session = ?').run(s);
  try {
    tmux(['kill-session', '-t', `=${s}`]);
  } catch {
    /* already gone */
  }
  console.log(`session "${s}" torn down`);
}

function cmdAttach(args: Args): void {
  const s = session(args);
  if (!hasSession(s)) fail(`session "${s}" is not running (orchestmux up)`);
  spawnSync('tmux', ['attach', '-t', s], { stdio: 'inherit' });
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const HELP = `orchestmux — multi-agent orchestration for coding CLIs in tmux

  up                                        create the tmux session
  spawn --name <w> --agent <a> [--yolo]     add a worker pane running an agent
  task add "<spec>"                         create a task, prints its id
  task list [--json]                        list tasks
  dispatch --task <id> --to <w>             inject the task + protocol into a worker
  wait [--types done,ask] [--timeout 900]   block until a worker reports (exit 2 on timeout)
  reply --id <msg> --body "<answer>"        answer a worker's ask
  send --to <w> --body "<text>"             message a worker
  ps [--json]                               workers, tasks, unread count
  attach                                    attach to the tmux session
  kill --name <w> | down                    remove one worker | tear down the session

  called by workers (inside a spawned pane):
  done --task <id> --body "<summary>" [--failed]
  ask  --task <id> --question "<q>" [--timeout 900]

  agents: ${agentNames().join(', ')}
  global: --session <name> (default ${DEFAULT_SESSION}), --cwd <path>
`;

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || cmd === 'help' || bool(args, 'help', false)) {
    console.log(HELP);
    return;
  }
  if (cmd === 'version') {
    console.log('0.1.0');
    return;
  }
  if (!tmuxAvailable()) fail('tmux not found on PATH');

  if (cmd === 'up') return cmdUp(args);
  if (cmd === 'attach') return cmdAttach(args);

  const db = openDb();
  switch (cmd) {
    case 'spawn':
      return cmdSpawn(db, args);
    case 'task':
      return cmdTask(db, args);
    case 'dispatch':
      return cmdDispatch(db, args);
    case 'wait':
      return cmdWait(db, args);
    case 'done':
      return cmdDone(db, args);
    case 'ask':
      return cmdAsk(db, args);
    case 'reply':
      return cmdReply(db, args);
    case 'send':
      return cmdSend(db, args);
    case 'ps':
      return cmdPs(db, args);
    case 'kill':
      return cmdKill(db, args);
    case 'down':
      return cmdDown(db, args);
    default:
      fail(`unknown command "${cmd}" (try: orchestmux help)`);
  }
}

main();
