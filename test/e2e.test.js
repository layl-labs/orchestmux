import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

import { makeHome, CLI, run, runJson, taskById } from './helpers.js';

/**
 * The claim this project makes is that completion is a recorded fact rather
 * than an inference. Everything else here tests that through the coordinator's
 * own process; this file tests it the way it actually happens: a real tmux
 * pane, spawned by `spawn`, reporting through the environment `spawn` injected
 * into it — no --from, no shared process state.
 *
 * `shell` is the agent under test on purpose. It needs no API key and no
 * network, so this runs in CI.
 */

const HAS_TMUX = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

function tmux(args) {
  return spawnSync('tmux', args, { encoding: 'utf8' });
}

/** A session name unique to this process, so a developer's own is never touched. */
let sessionCounter = 0;
function sessionName() {
  return `orchestmux-e2e-${process.pid}-${sessionCounter++}`;
}

function paneOf(home, session, worker) {
  return runJson(home, ['ps', '--json', '--session', session]).workers.find(
    (w) => w.name === worker,
  );
}

/** Runs a command inside the worker's pane and waits for the shell to finish it. */
function runInPane(paneId, command) {
  tmux(['send-keys', '-t', paneId, command, 'Enter']);
  for (let i = 0; i < 100; i++) {
    // #{pane_current_command} drops back to the shell once the child exits.
    const cur = tmux(['display-message', '-p', '-t', paneId, '#{pane_current_command}']).stdout.trim();
    if (/^(bash|zsh|sh|fish)$/.test(cur)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`command never finished in pane ${paneId}: ${command}`);
}

function cleanup(t, home, session) {
  t.after(() => {
    run(home, ['down', '--session', session]);
    tmux(['kill-session', '-t', `=${session}`]);
  });
}

test('a spawned pane reports through its own env and the coordinator collects it', { skip: !HAS_TMUX && 'tmux not installed' }, (t) => {
  const home = makeHome(t);
  const session = sessionName();
  cleanup(t, home, session);

  const spawned = run(home, [
    'spawn', '--name', 'w1', '--agent', 'shell', '--session', session, '--no-here',
  ]);
  assert.equal(spawned.status, 0, spawned.stderr);

  const worker = paneOf(home, session, 'w1');
  assert.ok(worker, 'worker was not registered');
  assert.equal(worker.alive, true, 'pane should be alive right after spawn');

  const id = run(home, ['task', 'add', 'e2e task', '--session', session]).stdout.trim();

  // The pane was given ORCHESTMUX_WORKER and ORCHESTMUX_HOME at spawn time.
  // Note the absence of --from: if that injection were broken, `done` could not
  // tell who is reporting and this would fail — which is exactly the bug a
  // coordinator would otherwise discover as a report that never arrives.
  runInPane(worker.pane_id, `node ${CLI} done --task ${id} --body 'reported from the pane'`);

  const msg = runJson(home, ['wait', '--json', '--timeout', '10', '--session', session]);
  assert.equal(msg.type, 'done');
  assert.equal(msg.from_worker, 'w1', 'the report must be attributed to the spawned worker');
  assert.equal(msg.body, 'reported from the pane');
  assert.equal(taskById(home, id, session).status, 'done');
});

test('dispatch relaunches the pane and the report comes back through the protocol', { skip: !HAS_TMUX && 'tmux not installed' }, (t) => {
  const home = makeHome(t);
  const session = sessionName();
  cleanup(t, home, session);

  // A stand-in agent: launched bare (spawn) it stays up like a shell; launched
  // with a prompt (dispatch) it reads the task id out of the preamble and
  // reports through the same protocol a real agent is instructed to use.
  // The sleep is load-bearing: tmux drains the pty asynchronously, and a
  // process that exits right after its last write can take that output with
  // it — which is a flake here, not the scenario under test.
  const agent = join(home, 'fake-agent.sh');
  writeFileSync(
    agent,
    [
      '#!/bin/sh',
      '[ -z "$1" ] && exec sh',
      `id=$(printf '%s' "$1" | sed -n 's/^\\[ORCHESTMUX TASK \\(t_[0-9a-f]*\\)\\]$/\\1/p')`,
      `${process.execPath} ${CLI} done --task "$id" --body "fake agent finished"`,
      'sleep 2',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  // The `shell` agent runs $SHELL, so pointing SHELL at the script makes
  // `spawn`/`dispatch` exercise their real code path with no API key needed.
  const agentEnv = { SHELL: agent };

  const spawned = run(
    home,
    ['spawn', '--name', 'w1', '--agent', 'shell', '--session', session, '--no-here'],
    agentEnv,
  );
  assert.equal(spawned.status, 0, spawned.stderr);

  const id = run(home, ['task', 'add', 'dispatched e2e task', '--session', session]).stdout.trim();
  const dispatched = run(
    home,
    ['dispatch', '--task', id, '--to', 'w1', '--session', session],
    agentEnv,
  );
  assert.equal(dispatched.status, 0, dispatched.stderr);

  const msg = runJson(home, ['wait', '--json', '--timeout', '30', '--session', session]);
  assert.equal(msg.type, 'done');
  assert.equal(msg.from_worker, 'w1', 'attribution must come from the env dispatch injected');
  assert.equal(msg.body, 'fake agent finished');
  assert.equal(taskById(home, id, session).status, 'done');

  // The agent process has exited, but the pane must survive it: the
  // scrollback is the only record of how the worker reached its answer.
  // (The report lands before the agent exits, so wait can return while it is
  // still winding down — poll the exit rather than assuming it.)
  let worker = paneOf(home, session, 'w1');
  for (let i = 0; i < 100 && worker.alive; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    worker = paneOf(home, session, 'w1');
  }
  assert.equal(worker.alive, false, 'the finished agent should no longer be running');
  const scrollback = tmux(['capture-pane', '-p', '-t', worker.pane_id]);
  assert.equal(scrollback.status, 0, 'the pane itself must still exist after the agent exited');
  assert.match(scrollback.stdout, /reported done for/, 'the evidence of the report must survive');
});

test('a worker whose pane dies leaves its task failed, not in flight', { skip: !HAS_TMUX && 'tmux not installed' }, (t) => {
  const home = makeHome(t);
  const session = sessionName();
  cleanup(t, home, session);

  const spawned = run(home, [
    'spawn', '--name', 'w1', '--agent', 'shell', '--session', session, '--no-here',
  ]);
  assert.equal(spawned.status, 0, spawned.stderr);

  const id = run(home, ['task', 'add', 'work that never gets reported', '--session', session]).stdout.trim();
  const worker = paneOf(home, session, 'w1');

  // Claim the task the way dispatch does. It is written directly because the
  // point here is the recovery path, not the dispatch path — the worker itself
  // is real either way.
  const db = new DatabaseSync(join(home, 'state.db'));
  db.prepare(`UPDATE tasks SET status = 'dispatched', assignee = 'w1' WHERE id = ?`).run(id);
  db.close();

  // Kill the pane for real: a crashed agent, a closed pane, a machine that
  // went to sleep. Nothing can ever report on this task now.
  tmux(['kill-pane', '-t', worker.pane_id]);
  assert.equal(paneOf(home, session, 'w1').alive, false, 'pane should read as dead once killed');

  const swept = runJson(home, ['sweep', '--json', '--session', session]);
  assert.deepEqual(swept.swept, ['w1']);
  assert.deepEqual(swept.orphaned, [id]);
  assert.equal(
    taskById(home, id, session).status,
    'failed',
    'a task nobody can report on must stop looking like work in flight',
  );
  assert.equal(runJson(home, ['ps', '--json', '--session', session]).workers.length, 0);
});
