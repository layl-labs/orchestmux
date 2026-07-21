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
  respawnPane,
  tmux,
  insideTmux,
  currentWindow,
  currentSessionName,
  switchClient,
  enclosingWindow,
  attachedClients,
  openTerminal,
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

/**
 * `--here` splits the caller's own tmux window instead of a dedicated session.
 * You then watch workers next to your shell with no attaching or switching —
 * which is the only thing that works when the caller is already inside tmux,
 * since a client cannot attach to a second session from within one.
 */
function here(args: Args): boolean {
  const explicit = args.flags['here'];
  if (explicit === false) return false;
  // Default to splitting the caller's window whenever we can find one: a
  // coordinator inside tmux almost always wants its workers visible, and a
  // detached session nobody is attached to is the worst of both worlds.
  const window = enclosingWindow();
  if (explicit === true && !window) fail('--here requires running inside a tmux pane');
  return window !== null;
}

function cmdSpawn(db: DatabaseSync, args: Args): void {
  const name = need(args, 'name');
  const agent = str(args, 'agent') ?? 'shell';
  const cwd = str(args, 'cwd') ?? process.cwd();
  const autonomous = bool(args, 'autonomous', false) || bool(args, 'yolo', false);
  const inPlace = here(args);

  if (!AGENTS[agent]) fail(`unknown agent "${agent}" (known: ${agentNames().join(', ')})`);
  if (getWorker(db, name)) fail(`worker "${name}" already exists (orchestmux kill --name ${name})`);
  if (!isInstalled(AGENTS[agent]!.cmd)) fail(`agent binary "${AGENTS[agent]!.cmd}" not found on PATH`);

  const s = inPlace ? (enclosingWindow() ?? currentWindow()).split(':')[0]! : session(args);
  if (!inPlace && !hasSession(s)) newSession(s, cwd);
  const window = inPlace ? (enclosingWindow() ?? currentWindow()) : `${s}:workers`;

  // Never respawn a pane someone is sitting in — only the placeholder shell of
  // a session we created ourselves is fair game.
  const occupied = listWorkers(db).some((w) => w.window === window && paneAlive(w.pane_id));
  const command = buildCommand(agent, autonomous, args._.slice(1));
  const paneId = addPane({
    window,
    cwd,
    env: { ORCHESTMUX_WORKER: name, ORCHESTMUX_SESSION: s },
    command,
    reuseFirst: !inPlace && !occupied,
  });

  db.prepare(
    `INSERT INTO workers (name, agent, pane_id, session, window, autonomous, cwd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(name, agent, paneId, s, window, autonomous ? 1 : 0, cwd, now());

  console.log(`spawned ${name} (${agent}) in pane ${paneId}${inPlace ? ' (this window)' : ''}`);
  if (!inPlace) {
    console.log(
      attachedClients(s) > 0
        ? `watch it: already attached in another terminal`
        : `watch it: orchestmux watch   (opens a terminal attached to "${s}")`,
    );
  }
  if (!autonomous && AGENTS[agent]!.autonomousArgs.length > 0) {
    console.log(`hint: this agent will stop for approval prompts — re-spawn with --yolo to let it run unattended`);
  }
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
  if (sub === 'update') {
    // Recovery only: a worker that was interrupted or died leaves its task
    // stuck in `dispatched`, and nothing else can move it.
    const id = need(args, 'id');
    const status = need(args, 'status');
    const allowed = ['pending', 'dispatched', 'done', 'failed'];
    if (!allowed.includes(status)) fail(`status must be one of: ${allowed.join(', ')}`);
    if (!getTask(db, id)) fail(`no such task: ${id}`);
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
    console.log(`${id} -> ${status}`);
    return;
  }
  if (sub === 'rm') {
    const id = need(args, 'id');
    if (!getTask(db, id)) fail(`no such task: ${id}`);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    console.log(`removed ${id}`);
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
  fail(`unknown task subcommand "${sub}" (add | list | update | rm)`);
}

function cmdDispatch(db: DatabaseSync, args: Args): void {
  const taskId = need(args, 'task');
  const to = need(args, 'to');
  const task = getTask(db, taskId) ?? fail(`no such task: ${taskId}`);
  const worker = getWorker(db, to) ?? fail(`no such worker: ${to}`);
  if (!paneAlive(worker.pane_id)) fail(`worker "${to}" pane is gone (orchestmux kill --name ${to})`);

  // An agent mid-task will read a second prompt as an interruption, and the
  // first task's report is then lost. Parallelism comes from more workers.
  const busy = db
    .prepare(`SELECT id FROM tasks WHERE assignee = ? AND status = 'dispatched' AND id != ?`)
    .get(to, taskId) as { id: string } | undefined;
  if (busy && !bool(args, 'force', false)) {
    fail(
      `worker "${to}" is still working on ${busy.id}. ` +
        `Spawn another worker for parallel work, or pass --force to interrupt it.`,
    );
  }

  // The prompt is handed to the agent as a launch argument and the pane is
  // relaunched with it, rather than typed into a live composer. Pasting had to
  // win three races (agent mounted, bracketed paste finished before the submit
  // key, pane not in copy-mode) and silently stranded the prompt when it lost
  // any of them.
  const prompt = dispatchPrompt({ taskId, spec: task.spec, cli: cliInvocation() });
  const command = buildCommand(worker.agent, worker.autonomous === 1, [], prompt);
  respawnPane({
    paneId: worker.pane_id,
    cwd: worker.cwd,
    env: { ORCHESTMUX_WORKER: to, ORCHESTMUX_SESSION: worker.session },
    command,
  });

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

/**
 * Removes workers that have nothing left to do, keeping the ones still working.
 *
 * Panes are not closed the moment a worker reports: the scrollback is the only
 * record of *how* it reached its conclusion, and reports can be wrong. Sweeping
 * is therefore a deliberate act you run once you have read the results.
 */
function cmdSweep(db: DatabaseSync, args: Args): void {
  const dryRun = bool(args, 'dry-run', false);
  const swept: string[] = [];
  const orphaned: string[] = [];
  const kept: { name: string; task: string }[] = [];

  for (const w of listWorkers(db)) {
    const busy = db
      .prepare(`SELECT id FROM tasks WHERE assignee = ? AND status = 'dispatched' LIMIT 1`)
      .get(w.name) as { id: string } | undefined;
    const alive = paneAlive(w.pane_id);

    if (busy && alive) {
      kept.push({ name: w.name, task: busy.id });
      continue;
    }
    if (dryRun) {
      swept.push(w.name);
      if (busy) orphaned.push(busy.id);
      continue;
    }
    // A dead pane means its dispatch can never report; leaving the task
    // `dispatched` would make it look like work still in flight.
    if (busy) {
      db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(
        'failed',
        now(),
        busy.id,
      );
      orphaned.push(busy.id);
    }
    killPane(w.pane_id);
    db.prepare('DELETE FROM workers WHERE name = ?').run(w.name);
    swept.push(w.name);
  }

  if (bool(args, 'json', false)) {
    console.log(JSON.stringify({ swept, kept, orphaned, dryRun }, null, 2));
    return;
  }
  const verb = dryRun ? 'would remove' : 'removed';
  console.log(swept.length ? `${verb} ${swept.length}: ${swept.join(', ')}` : 'nothing to sweep');
  for (const o of orphaned) console.log(`  ${o} marked failed — its worker died before reporting`);
  for (const k of kept) console.log(`  kept ${k.name} — still working on ${k.task}`);
}

function cmdDown(db: DatabaseSync, args: Args): void {
  const explicit = str(args, 'session');
  const s = explicit ?? (insideTmux() ? currentSessionName() : DEFAULT_SESSION);

  let removed = 0;
  for (const w of listWorkers(db)) {
    if (w.session !== s) continue;
    killPane(w.pane_id);
    removed++;
  }
  db.prepare('DELETE FROM workers WHERE session = ?').run(s);

  // Workers spawned with --here live in the user's own session; tearing that
  // down would kill the shell they are typing in.
  const isOwnSession = insideTmux() && currentSessionName() === s;
  if (isOwnSession) {
    console.log(`removed ${removed} worker pane(s) from "${s}" (session left running — it is yours)`);
    return;
  }
  try {
    tmux(['kill-session', '-t', `=${s}`]);
  } catch {
    /* already gone */
  }
  console.log(`session "${s}" torn down (${removed} worker pane(s))`);
}

function cmdAttach(args: Args): void {
  const s = session(args);
  if (!hasSession(s)) fail(`session "${s}" is not running (orchestmux up)`);
  if (insideTmux()) {
    // `tmux attach` refuses to nest; moving the current client is the in-tmux
    // equivalent. Prefix-L switches back.
    if (currentSessionName() === s) {
      console.log(`already in session "${s}"`);
      return;
    }
    switchClient(s);
    console.log(`switched to session "${s}" (prefix + L to switch back)`);
    return;
  }
  spawnSync('tmux', ['attach', '-t', s], { stdio: 'inherit' });
}

function cmdWatch(args: Args): void {
  const s = session(args);
  if (!hasSession(s)) fail(`session "${s}" is not running (orchestmux up)`);

  if (insideTmux()) {
    if (currentSessionName() === s) {
      console.log(`already watching "${s}"`);
      return;
    }
    switchClient(s);
    console.log(`switched to "${s}" (prefix + L to switch back)`);
    return;
  }
  if (attachedClients(s) > 0) {
    console.log(`"${s}" is already attached in another terminal`);
    return;
  }
  const opened = openTerminal(s);
  if (opened) {
    console.log(`opened ${opened} attached to "${s}"`);
    return;
  }
  console.log(`could not open a terminal automatically — run this yourself:\n  tmux attach -t ${s}`);
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const HELP = `orchestmux — multi-agent orchestration for coding CLIs in tmux

  up                                        create the tmux session
  spawn --name <w> --agent <a> [--yolo]     add a worker pane running an agent
        [--here]                            ...split THIS window instead (watch live, no attach)
  task add "<spec>"                         create a task, prints its id
  task list [--json]                        list tasks
  task update --id <id> --status <s>        recover a stuck task (pending|dispatched|done|failed)
  task rm --id <id>                         delete a task
  dispatch --task <id> --to <w>             inject the task + protocol into a worker
  wait [--types done,ask] [--timeout 900]   block until a worker reports (exit 2 on timeout)
  reply --id <msg> --body "<answer>"        answer a worker's ask
  send --to <w> --body "<text>"             message a worker
  ps [--json]                               workers, tasks, unread count
  attach | watch                            attach to the session | open a terminal attached to it
  sweep [--dry-run]                         remove workers with nothing left to do
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
  if (cmd === 'watch') return cmdWatch(args);

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
    case 'sweep':
      return cmdSweep(db, args);
    case 'kill':
      return cmdKill(db, args);
    case 'down':
      return cmdDown(db, args);
    default:
      fail(`unknown command "${cmd}" (try: orchestmux help)`);
  }
}

main();
