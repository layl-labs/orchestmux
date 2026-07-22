import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
function sessionName() {
  return `orchestmux-e2e-${process.pid}`;
}

function paneOf(home, worker) {
  return runJson(home, ['ps', '--json']).workers.find((w) => w.name === worker);
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

test('a spawned pane reports through its own env and the coordinator collects it', { skip: !HAS_TMUX && 'tmux not installed' }, (t) => {
  const home = makeHome(t);
  const session = sessionName();
  t.after(() => {
    run(home, ['down', '--session', session]);
    tmux(['kill-session', '-t', `=${session}`]);
  });

  const spawned = run(home, [
    'spawn', '--name', 'w1', '--agent', 'shell', '--session', session, '--no-here',
  ]);
  assert.equal(spawned.status, 0, spawned.stderr);

  const worker = paneOf(home, 'w1');
  assert.ok(worker, 'worker was not registered');
  assert.equal(worker.alive, true, 'pane should be alive right after spawn');

  const id = run(home, ['task', 'add', 'e2e task']).stdout.trim();

  // The pane was given ORCHESTMUX_WORKER and ORCHESTMUX_HOME at spawn time.
  // Note the absence of --from: if that injection were broken, `done` could not
  // tell who is reporting and this would fail — which is exactly the bug a
  // coordinator would otherwise discover as a report that never arrives.
  runInPane(worker.pane_id, `node ${CLI} done --task ${id} --body 'reported from the pane'`);

  const msg = runJson(home, ['wait', '--json', '--timeout', '10']);
  assert.equal(msg.type, 'done');
  assert.equal(msg.from_worker, 'w1', 'the report must be attributed to the spawned worker');
  assert.equal(msg.body, 'reported from the pane');
  assert.equal(taskById(home, id).status, 'done');
});

test('a worker whose pane dies leaves its task failed, not in flight', { skip: !HAS_TMUX && 'tmux not installed' }, (t) => {
  const home = makeHome(t);
  const session = sessionName();
  t.after(() => {
    run(home, ['down', '--session', session]);
    tmux(['kill-session', '-t', `=${session}`]);
  });

  const spawned = run(home, [
    'spawn', '--name', 'w1', '--agent', 'shell', '--session', session, '--no-here',
  ]);
  assert.equal(spawned.status, 0, spawned.stderr);

  const id = run(home, ['task', 'add', 'work that never gets reported']).stdout.trim();
  const worker = paneOf(home, 'w1');

  // Claim the task the way dispatch does. It is written directly because
  // `dispatch` relaunches the pane with the agent, and a bare shell would try
  // to execute the preamble — the worker itself is real either way.
  const db = new DatabaseSync(join(home, 'state.db'));
  db.prepare(`UPDATE tasks SET status = 'dispatched', assignee = 'w1' WHERE id = ?`).run(id);
  db.close();

  // Kill the pane for real: a crashed agent, a closed pane, a machine that
  // went to sleep. Nothing can ever report on this task now.
  tmux(['kill-pane', '-t', worker.pane_id]);
  assert.equal(paneOf(home, 'w1').alive, false, 'pane should read as dead once killed');

  const swept = runJson(home, ['sweep', '--json']);
  assert.deepEqual(swept.swept, ['w1']);
  assert.deepEqual(swept.orphaned, [id]);
  assert.equal(
    taskById(home, id).status,
    'failed',
    'a task nobody can report on must stop looking like work in flight',
  );
  assert.equal(runJson(home, ['ps', '--json']).workers.length, 0);
});
