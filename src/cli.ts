#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
} from './db.js';
import {
  tmuxAvailable,
  hasSession,
  newSession,
  addPane,
  paneAlive,
  paneExists,
  paneStates,
  killPane,
  respawnPane,
  tmux,
  insideTmux,
  currentSessionName,
  switchClient,
  enclosingWindow,
  attachedClients,
  openTerminal,
} from './tmux.js';
import { AGENTS, agentNames, buildCommand, isInstalled } from './agents.js';
import { isCodexTrusted, trustCodexDirectory } from './trust.js';
import { cliInvocation, dispatchPrompt } from './preamble.js';

const DEFAULT_SESSION = process.env.ORCHESTMUX_SESSION ?? 'orchestmux';
const POLL_MS = 300;

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Flags that never take a value. Without this list, `task add --json "spec"`
 * would swallow the spec as --json's value — a boolean flag followed by a
 * positional is a silent parse error otherwise.
 */
const BOOLEAN_FLAGS = new Set([
  'json',
  'yolo',
  'autonomous',
  'force',
  'failed',
  'all',
  'help',
  'dry-run',
  'here',
]);

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // Everything after a bare `--` is positional, verbatim — this is how
    // `spawn ... -- --model x` gets flags through to the agent.
    if (a === '--') {
      _.push(...argv.slice(i + 1));
      break;
    }
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
    if (body.startsWith('no-')) {
      flags[body.slice(3)] = false;
      continue;
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags[body] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      i++;
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

/**
 * Loud on garbage: `--timeout abc` silently becoming the default would have a
 * coordinator waiting 900s it never asked for. Absent means the default;
 * present means it has to parse.
 */
function num(args: Args, key: string, dflt: number): number {
  const v = args.flags[key];
  if (v === undefined) return dflt;
  const n = typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) fail(`--${key} expects a number, got "${v}"`);
  return n;
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

/**
 * The logical swarm this invocation is about. Every piece of state — workers,
 * tasks, messages — is scoped to it, so two swarms never steal each other's
 * reports. Workers inherit it through ORCHESTMUX_SESSION in their pane env, so
 * a worker's `done` lands in the same swarm that dispatched to it.
 */
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

/** The tmux session this process itself sits in, or null. */
function ownSessionName(): string | null {
  const win = enclosingWindow();
  if (win) return win.split(':')[0]!;
  if (process.env.TMUX) {
    try {
      return currentSessionName();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Environment every worker pane needs. ORCHESTMUX_HOME has to travel with it:
 * a worker writes its report through the same CLI, and if it resolved a
 * different state directory than the coordinator, `done` would land in a
 * database nobody is reading.
 */
function workerEnv(worker: string, session: string): Record<string, string> {
  const env: Record<string, string> = {
    ORCHESTMUX_WORKER: worker,
    ORCHESTMUX_SESSION: session,
  };
  if (process.env.ORCHESTMUX_HOME) env.ORCHESTMUX_HOME = process.env.ORCHESTMUX_HOME;
  return env;
}

/**
 * A removed worker can never report, so its in-flight dispatches must not keep
 * looking like work in progress. Every path that removes a worker — kill,
 * down, sweep — goes through this; leaving it to sweep alone left `kill` and
 * `down` producing tasks stuck in `dispatched` forever.
 */
function failDispatchedTasks(db: DatabaseSync, session: string, worker: string): string[] {
  const rows = db
    .prepare(`SELECT id FROM tasks WHERE session = ? AND assignee = ? AND status = 'dispatched'`)
    .all(session, worker) as unknown as { id: string }[];
  for (const r of rows) {
    db.prepare(`UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ?`).run(now(), r.id);
  }
  return rows.map((r) => r.id);
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
  const name = need(args, 'name');
  const agent = str(args, 'agent') ?? 'shell';
  const cwd = str(args, 'cwd') ?? process.cwd();
  const autonomous = bool(args, 'autonomous', false) || bool(args, 'yolo', false);
  const s = session(args);

  // `--here` splits the caller's own tmux window instead of a dedicated
  // session, so workers are visible next to your shell with no attaching.
  // Default to it whenever an enclosing window can be found: a coordinator
  // inside tmux almost always wants its workers visible, and a detached
  // session nobody is attached to is the worst of both worlds. The pane moves;
  // the worker still belongs to the logical session `s` for all state.
  const enclosing = enclosingWindow();
  const explicit = args.flags['here'];
  if (explicit === true && !enclosing) fail('--here requires running inside a tmux pane');
  const inPlace = explicit === false ? false : enclosing !== null;

  if (!AGENTS[agent]) fail(`unknown agent "${agent}" (known: ${agentNames().join(', ')})`);
  if (getWorker(db, s, name)) {
    fail(`worker "${name}" already exists in session "${s}" (orchestmux kill --name ${name})`);
  }
  if (!isInstalled(AGENTS[agent]!.cmd)) fail(`agent binary "${AGENTS[agent]!.cmd}" not found on PATH`);

  // Do this before the pane exists: an untrusted directory parks codex on a
  // prompt --yolo cannot answer, and the worker would never read its task.
  // Tied to --yolo because it writes to the user's codex config.
  if (AGENTS[agent]!.preflightTrust === 'codex' && autonomous && !isCodexTrusted(cwd)) {
    const t = trustCodexDirectory(cwd);
    if (t.changed) console.log(`trusted ${t.path} in ~/.codex/config.toml (codex would block otherwise)`);
  }

  if (!inPlace && !hasSession(s)) newSession(s, cwd);
  const window = inPlace ? enclosing! : `${s}:workers`;

  // Never respawn a pane a worker still owns — dead panes included, their
  // scrollback is evidence. Only the placeholder shell of a session we created
  // ourselves is fair game.
  const states = paneStates();
  const occupied = listWorkers(db, s).some(
    (w) => w.window === window && paneExists(w.pane_id, states),
  );
  const command = buildCommand(agent, autonomous, args._.slice(1));
  const paneId = addPane({
    window,
    cwd,
    env: workerEnv(name, s),
    command,
    reuseFirst: !inPlace && !occupied,
  });

  db.prepare(
    `INSERT INTO workers (session, name, agent, pane_id, window, autonomous, cwd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(s, name, agent, paneId, window, autonomous ? 1 : 0, cwd, now());

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
  const s = session(args);
  if (sub === 'add') {
    const spec = args._.slice(2).join(' ') || str(args, 'spec');
    if (!spec) fail('usage: orchestmux task add "<spec>"');
    const id = newId('t');
    const ts = now();
    db.prepare(
      `INSERT INTO tasks (id, session, spec, status, assignee, result, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
    ).run(id, s, spec, ts, ts);
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
  if (sub === 'clear') {
    // Finished tasks accumulate forever otherwise — there is no daemon to age
    // them out. Their messages go with them; `report` is only useful while the
    // task it joins against still exists.
    const finished = db
      .prepare(`SELECT id FROM tasks WHERE session = ? AND status IN ('done', 'failed')`)
      .all(s) as unknown as { id: string }[];
    for (const t of finished) {
      db.prepare('DELETE FROM messages WHERE task_id = ?').run(t.id);
    }
    db.prepare(`DELETE FROM tasks WHERE session = ? AND status IN ('done', 'failed')`).run(s);
    console.log(`cleared ${finished.length} finished task(s)`);
    return;
  }
  if (sub === 'list' || sub === undefined) {
    const tasks = listTasks(db, s);
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
  fail(`unknown task subcommand "${sub}" (add | list | update | rm | clear)`);
}

function cmdDispatch(db: DatabaseSync, args: Args): void {
  const taskId = need(args, 'task');
  const to = need(args, 'to');
  const s = session(args);
  const task = getTask(db, taskId) ?? fail(`no such task: ${taskId}`);
  if (task.session !== s) {
    fail(`task ${taskId} belongs to session "${task.session}", not "${s}" — its report would land there`);
  }
  const worker = getWorker(db, s, to) ?? fail(`no such worker in session "${s}": ${to}`);
  // A dead pane is fine — respawn-pane revives it, scrollback intact. Only a
  // pane that no longer exists at all cannot take a dispatch.
  if (!paneExists(worker.pane_id)) fail(`worker "${to}" pane is gone (orchestmux kill --name ${to})`);

  // An agent mid-task will read a second prompt as an interruption, and the
  // first task's report is then lost. Parallelism comes from more workers.
  const busy = db
    .prepare(
      `SELECT id FROM tasks WHERE session = ? AND assignee = ? AND status = 'dispatched' AND id != ?`,
    )
    .get(s, to, taskId) as { id: string } | undefined;
  if (busy) {
    if (!bool(args, 'force', false)) {
      fail(
        `worker "${to}" is still working on ${busy.id}. ` +
          `Spawn another worker for parallel work, or pass --force to interrupt it.`,
      );
    }
    // The interrupted task's agent is about to be relaunched; its report can
    // never arrive, so record that instead of leaving it `dispatched` forever.
    db.prepare(`UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ?`).run(now(), busy.id);
    console.log(`${busy.id} marked failed — its worker was interrupted by this dispatch`);
  }

  // The prompt is handed to the agent as a launch argument and the pane is
  // relaunched with it, rather than typed into a live composer. Pasting had to
  // win three races (agent mounted, bracketed paste finished before the submit
  // key, pane not in copy-mode) and silently stranded the prompt when it lost
  // any of them.
  const prompt = dispatchPrompt({ taskId, spec: task.spec, cli: cliInvocation() });
  const command = buildCommand(worker.agent, worker.autonomous === 1, [], prompt);

  // Claim the task before the pane can possibly report on it. A headless agent
  // that finishes immediately would otherwise have its `done` overwritten by
  // this update landing afterwards.
  db.prepare(`UPDATE tasks SET status = 'dispatched', assignee = ?, updated_at = ? WHERE id = ?`).run(
    to,
    now(),
    taskId,
  );
  try {
    respawnPane({
      paneId: worker.pane_id,
      cwd: worker.cwd,
      env: workerEnv(to, worker.session),
      command,
    });
  } catch (err) {
    // The claim was a lie if the pane never came back — undo it rather than
    // leave a task that looks dispatched to a worker that never got it.
    db.prepare('UPDATE tasks SET status = ?, assignee = ?, updated_at = ? WHERE id = ?').run(
      task.status,
      task.assignee,
      now(),
      taskId,
    );
    throw err;
  }
  console.log(`dispatched ${taskId} -> ${to}`);
}

function printMessage(msg: Message): void {
  console.log(`[${msg.type}] ${msg.from_worker ?? '?'}  task=${msg.task_id ?? '-'}  id=${msg.id}`);
  if (msg.subject) console.log(msg.subject);
  if (msg.body) console.log(msg.body);
  if (msg.type === 'ask') {
    console.log(`\nanswer with: orchestmux reply --id ${msg.id} --body "<answer>"`);
  }
}

/**
 * A worker whose pane died can never report; blocking the full timeout on it
 * would just delay the bad news by 15 minutes. Each poll, any dispatched task
 * whose assignee's pane is no longer running is failed and turned into an
 * `escalation` message, so the same `wait` that was going to sit on it returns
 * with the diagnosis instead.
 */
function escalateDeadWorkers(db: DatabaseSync, session: string): void {
  const dispatched = db
    .prepare(
      `SELECT id, assignee FROM tasks
        WHERE session = ? AND status = 'dispatched' AND assignee IS NOT NULL`,
    )
    .all(session) as unknown as { id: string; assignee: string }[];
  if (dispatched.length === 0) return;

  const states = paneStates();
  for (const t of dispatched) {
    const worker = getWorker(db, session, t.assignee);
    // No worker row means the task was assigned by hand — nothing to watch.
    if (!worker || paneAlive(worker.pane_id, states)) continue;
    db.prepare(
      `UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'dispatched'`,
    ).run(now(), t.id);
    insertMessage(db, {
      session,
      type: 'escalation',
      task_id: t.id,
      from_worker: t.assignee,
      to_worker: null,
      subject: `${t.assignee}: worker died before reporting`,
      body:
        `worker "${t.assignee}" (pane ${worker.pane_id}) is no longer running, so ${t.id} can never be reported; ` +
        `it is marked failed. The pane scrollback may show why: tmux capture-pane -p -t ${worker.pane_id}`,
      reply_to: null,
    });
  }
}

/**
 * Blocks until workers report.
 *
 * One report at a time is the default because a coordinator usually wants to
 * act on each as it lands. `--count` is for the ensemble case: several workers
 * were given the same task, and comparing their answers means holding all of
 * them at once rather than reacting to whichever finished first.
 */
function cmdWait(db: DatabaseSync, args: Args): void {
  const s = session(args);
  const types = (str(args, 'types') ?? 'done,ask,escalation').split(',').map((t) => t.trim());
  const timeoutMs = num(args, 'timeout', 900) * 1000;
  const asJson = bool(args, 'json', false);
  const drain = bool(args, 'all', false);
  const want = drain ? Infinity : Math.max(1, Math.floor(num(args, 'count', 1)));
  // A caller asking for one message still gets the bare object it always got.
  const asList = drain || want > 1;
  const deadline = Date.now() + timeoutMs;
  const placeholders = types.map(() => '?').join(',');

  const collected: Message[] = [];
  const select = db.prepare(
    `SELECT * FROM messages
      WHERE session = ? AND to_worker IS NULL AND read_at IS NULL AND type IN (${placeholders})
      ORDER BY created_at`,
  );
  // The claim is conditional so two concurrent waits cannot both collect the
  // same message: whoever's UPDATE lands first owns it, the other skips.
  const markRead = db.prepare('UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL');

  while (Date.now() < deadline) {
    escalateDeadWorkers(db, s);
    for (const msg of select.all(s, ...types) as unknown as Message[]) {
      const claimed = markRead.run(now(), msg.id);
      if (Number(claimed.changes) === 0) continue; // a concurrent wait got it first
      collected.push(msg);
      if (collected.length >= want) break;
    }
    // --all takes whatever had piled up, but still waits for the first one:
    // returning empty the instant nothing has arrived would defeat the point.
    if (collected.length >= want || (drain && collected.length > 0)) break;
    sleep(POLL_MS);
  }

  if (collected.length === 0) {
    if (asJson) console.log(JSON.stringify({ count: 0, timedOut: true }));
    else console.log(`(no message within ${timeoutMs / 1000}s)`);
    // A timeout is a checkpoint, not a failure — distinct exit code so callers can loop.
    process.exit(2);
  }

  if (asJson) {
    console.log(JSON.stringify(asList ? collected : collected[0], null, 2));
  } else {
    collected.forEach((msg, i) => {
      if (i > 0) console.log('');
      printMessage(msg);
    });
  }

  // Fewer than asked for means the deadline hit first. The reports collected
  // are real, so they are printed either way — the exit code is what tells a
  // script the set is short.
  if (collected.length < want && want !== Infinity) process.exit(2);
}

/**
 * Reports are recorded, so they have to be readable after the fact. `wait`
 * consumes each message once; without this the only copy of a worker's
 * conclusion would be whatever is still in the terminal's scrollback.
 */
function cmdReport(db: DatabaseSync, args: Args): void {
  const s = session(args);
  const taskId = str(args, 'task');
  if (taskId && !getTask(db, taskId)) fail(`no such task: ${taskId}`);

  const rows = db
    .prepare(
      `SELECT m.id, m.task_id, m.from_worker, m.body, m.created_at,
              t.spec, t.status, t.assignee
         FROM messages m
         JOIN tasks t ON t.id = m.task_id
        WHERE m.type = 'done' AND t.session = ?${taskId ? ' AND m.task_id = ?' : ''}
        ORDER BY m.created_at`,
    )
    .all(...(taskId ? [s, taskId] : [s])) as unknown as {
    id: string;
    task_id: string;
    from_worker: string | null;
    body: string | null;
    created_at: string;
    spec: string;
    status: string;
    assignee: string | null;
  }[];

  if (bool(args, 'json', false)) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(taskId ? `(no report for ${taskId})` : '(no reports yet)');
    return;
  }
  rows.forEach((r, i) => {
    if (i > 0) console.log('');
    console.log(`${r.task_id}  ${r.status}  ${r.from_worker ?? '-'}  ${r.created_at}`);
    console.log(`  task: ${oneLine(r.spec, 70)}`);
    for (const line of (r.body ?? '').split('\n')) console.log(`  ${line}`);
  });
}

function cmdDone(db: DatabaseSync, args: Args): void {
  const taskId = need(args, 'task');
  const body = need(args, 'body');
  const from = whoami(args);
  const task = getTask(db, taskId) ?? fail(`no such task: ${taskId}`);
  const force = bool(args, 'force', false);

  // Agents mistype ids, and with several workers running that lands a report
  // on someone else's task — closing work that is still in flight. An
  // unassigned task stays open to anyone, so finishing one by hand still works.
  if (task.assignee && task.assignee !== from && !force) {
    fail(
      `${taskId} is assigned to "${task.assignee}", not "${from}". ` +
        `Check the task id in your prompt, or pass --force to report anyway.`,
    );
  }

  // Agents also retry: a `done` whose output they never saw gets run again,
  // and without this guard the duplicate would satisfy an ensemble
  // `wait --count` on its own — one worker posing as two.
  if ((task.status === 'done' || task.status === 'failed') && !force) {
    fail(
      `${taskId} already has a report (status: ${task.status}). ` +
        `If you mean to replace it, pass --force.`,
    );
  }

  const status = bool(args, 'failed', false) ? 'failed' : 'done';
  insertMessage(db, {
    session: task.session,
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
  // The task's session, not the asker's env: the coordinator waiting on this
  // task is by definition the one who should see the question.
  const task = getTask(db, taskId) ?? fail(`no such task: ${taskId}`);

  const askId = insertMessage(db, {
    session: task.session,
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
    session: target.session,
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

function cmdPs(db: DatabaseSync, args: Args): void {
  const s = session(args);
  const states = paneStates();
  const workers = listWorkers(db, s).map((w) => ({ ...w, alive: paneAlive(w.pane_id, states) }));
  const tasks = listTasks(db, s);
  const unread = db
    .prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE session = ? AND to_worker IS NULL AND read_at IS NULL',
    )
    .get(s) as { n: number };

  if (bool(args, 'json', false)) {
    console.log(JSON.stringify({ session: s, workers, tasks, unread: unread.n }, null, 2));
    return;
  }

  console.log(`session: ${s}`);
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
  const s = session(args);
  const w = getWorker(db, s, name) ?? fail(`no such worker in session "${s}": ${name}`);
  const orphaned = failDispatchedTasks(db, s, name);
  killPane(w.pane_id);
  db.prepare('DELETE FROM workers WHERE session = ? AND name = ?').run(s, name);
  console.log(`killed ${name}`);
  for (const o of orphaned) console.log(`  ${o} marked failed — its worker was killed before reporting`);
}

/**
 * Removes workers that have nothing left to do, keeping the ones still working.
 *
 * Panes are not closed the moment a worker reports: the scrollback is the only
 * record of *how* it reached its conclusion, and reports can be wrong. Sweeping
 * is therefore a deliberate act you run once you have read the results.
 */
function cmdSweep(db: DatabaseSync, args: Args): void {
  const s = session(args);
  const dryRun = bool(args, 'dry-run', false);
  const swept: string[] = [];
  const orphaned: string[] = [];
  const kept: { name: string; task: string }[] = [];

  const states = paneStates();
  for (const w of listWorkers(db, s)) {
    const busy = db
      .prepare(
        `SELECT id FROM tasks WHERE session = ? AND assignee = ? AND status = 'dispatched' LIMIT 1`,
      )
      .get(s, w.name) as { id: string } | undefined;
    const alive = paneAlive(w.pane_id, states);

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
    if (busy) orphaned.push(...failDispatchedTasks(db, s, w.name));
    killPane(w.pane_id);
    db.prepare('DELETE FROM workers WHERE session = ? AND name = ?').run(s, w.name);
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
  const s = session(args);

  let removed = 0;
  const orphaned: string[] = [];
  for (const w of listWorkers(db, s)) {
    orphaned.push(...failDispatchedTasks(db, s, w.name));
    killPane(w.pane_id);
    removed++;
  }
  db.prepare('DELETE FROM workers WHERE session = ?').run(s);
  for (const o of orphaned) console.log(`  ${o} marked failed — its worker was torn down before reporting`);

  // Workers spawned with --here live in the user's own session; tearing that
  // down would kill the shell they are typing in.
  if (ownSessionName() === s) {
    console.log(`removed ${removed} worker pane(s) from "${s}" (session left running — it is yours)`);
    return;
  }
  try {
    tmux(['kill-session', '-t', `=${s}`]);
  } catch {
    /* already gone, or never a dedicated session (--here) */
  }
  console.log(`session "${s}" torn down (${removed} worker pane(s))`);
}

function cmdAttach(args: Args): void {
  const s = session(args);
  if (!hasSession(s)) fail(`session "${s}" is not running (orchestmux up)`);
  if (insideTmux()) {
    // `tmux attach` refuses to nest; moving the current client is the in-tmux
    // equivalent. Prefix-L switches back.
    if (ownSessionName() === s) {
      console.log(`already in session "${s}"`);
      return;
    }
    try {
      switchClient(s);
      console.log(`switched to session "${s}" (prefix + L to switch back)`);
    } catch {
      // No client to move (harness stripped $TMUX) — the user can still do it.
      console.log(`run this in your terminal: tmux switch-client -t ${s}`);
    }
    return;
  }
  spawnSync('tmux', ['attach', '-t', s], { stdio: 'inherit' });
}

function cmdWatch(args: Args): void {
  const s = session(args);
  if (!hasSession(s)) fail(`session "${s}" is not running (orchestmux up)`);

  if (insideTmux()) {
    if (ownSessionName() === s) {
      console.log(`already watching "${s}"`);
      return;
    }
    try {
      switchClient(s);
      console.log(`switched to "${s}" (prefix + L to switch back)`);
    } catch {
      console.log(`run this in your terminal: tmux switch-client -t ${s}`);
    }
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

/** Read from package.json so a release never has to remember to update it. */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const HELP = `orchestmux — multi-agent orchestration for coding CLIs in tmux

  up                                        create the tmux session
  spawn --name <w> --agent <a> [--yolo]     add a worker pane running an agent
        [--here]                            ...split THIS window instead (watch live, no attach)
        [-- <args...>]                      ...extra args passed to the agent verbatim
  task add "<spec>"                         create a task, prints its id
  task list [--json]                        list tasks
  task update --id <id> --status <s>        recover a stuck task (pending|dispatched|done|failed)
  task rm --id <id>                         delete a task
  task clear                                delete finished tasks and their messages
  dispatch --task <id> --to <w> [--force]   inject the task + protocol into a worker
  wait [--types done,ask] [--timeout 900]   block until a worker reports (exit 2 on timeout)
       [--count <n> | --all]                ...collect n reports, or everything queued
  report [--task <id>] [--json]             re-read collected reports
  reply --id <msg> --body "<answer>"        answer a worker's ask
  ps [--json]                               workers, tasks, unread count
  attach | watch                            attach to the session | open a terminal attached to it
  sweep [--dry-run]                         remove workers with nothing left to do
  kill --name <w> | down                    remove one worker | tear down the session

  called by workers (inside a spawned pane):
  done --task <id> --body "<summary>" [--failed]
  ask  --task <id> --question "<q>" [--timeout 900]

  agents: ${agentNames().join(', ')}
  global: --session <name> (default ${DEFAULT_SESSION}), --cwd <path>
  All state — workers, tasks, reports — is scoped per session.
`;

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || cmd === 'help' || bool(args, 'help', false)) {
    console.log(HELP);
    return;
  }
  if (cmd === 'version') {
    console.log(packageVersion());
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
    case 'report':
      return cmdReport(db, args);
    case 'done':
      return cmdDone(db, args);
    case 'ask':
      return cmdAsk(db, args);
    case 'reply':
      return cmdReply(db, args);
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
