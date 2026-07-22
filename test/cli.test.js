import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

import { makeHome, run, runJson, runAsync, taskById } from './helpers.js';

/**
 * The state machine a coordinator depends on: a task moves pending →
 * dispatched → done/failed, and `wait` returns exactly once per report. These
 * drive the real CLI against a throwaway state directory.
 */

function addTask(home, spec = 'do the thing') {
  const r = run(home, ['task', 'add', spec]);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/**
 * Reproduces what `dispatch` leaves behind, minus the tmux half: a registered
 * worker whose pane is gone (%9999 is deliberately not alive) and a task
 * assigned to it. Assignee matters — that is the only link sweep follows back
 * from a dead worker to the task it can no longer report on.
 */
function fakeDispatch(home, name, taskId) {
  const db = new DatabaseSync(join(home, 'state.db'));
  db.prepare(
    `INSERT INTO workers (name, agent, pane_id, session, window, autonomous, cwd, created_at)
     VALUES (?, 'shell', '%9999', 'orchestmux-test', 'orchestmux-test:workers', 0, '/tmp', ?)`,
  ).run(name, new Date().toISOString());
  if (taskId) {
    db.prepare(`UPDATE tasks SET status = 'dispatched', assignee = ?, updated_at = ? WHERE id = ?`).run(
      name,
      new Date().toISOString(),
      taskId,
    );
  }
  db.close();
}

test('task add creates a pending task and prints its id', (t) => {
  const home = makeHome(t);
  const id = addTask(home, 'audit the api');
  assert.match(id, /^t_[0-9a-f]{8}$/);

  const task = taskById(home, id);
  assert.equal(task.status, 'pending');
  assert.equal(task.assignee, null);
  assert.equal(task.spec, 'audit the api');
});

test('done moves the task to done and stores the report as its result', (t) => {
  const home = makeHome(t);
  const id = addTask(home);

  const r = run(home, ['done', '--task', id, '--from', 'w1', '--body', 'found two leaks']);
  assert.equal(r.status, 0, r.stderr);

  const task = taskById(home, id);
  assert.equal(task.status, 'done');
  assert.equal(task.result, 'found two leaks');
});

test('done --failed records failure without losing the report', (t) => {
  const home = makeHome(t);
  const id = addTask(home);

  run(home, ['done', '--task', id, '--from', 'w1', '--failed', '--body', 'build never compiled']);

  const task = taskById(home, id);
  assert.equal(task.status, 'failed');
  assert.equal(task.result, 'build never compiled', 'a failed run is still a report worth keeping');
});

test('wait returns the report, then never returns it a second time', (t) => {
  const home = makeHome(t);
  const id = addTask(home);
  run(home, ['done', '--task', id, '--from', 'w1', '--body', 'all green']);

  const msg = runJson(home, ['wait', '--json', '--timeout', '5']);
  assert.equal(msg.type, 'done');
  assert.equal(msg.from_worker, 'w1');
  assert.equal(msg.task_id, id);
  assert.equal(msg.body, 'all green');

  // Reading marks it read; a second wait must block and time out instead of
  // replaying it, or a coordinator loop would spin on one stale report.
  const again = run(home, ['wait', '--json', '--timeout', '0.5']);
  assert.equal(again.status, 2, 'a timeout is exit 2, distinct from a failure');
  assert.deepEqual(JSON.parse(again.stdout), { count: 0, timedOut: true });
});

test('wait blocks until a report actually arrives', async (t) => {
  const home = makeHome(t);
  const id = addTask(home);

  const waiting = runAsync(home, ['wait', '--json', '--timeout', '20']);
  // Nothing has reported yet, so the waiter must still be blocked here.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(waiting.child.exitCode, null, 'wait returned before any worker reported');

  run(home, ['done', '--task', id, '--from', 'w1', '--body', 'late but done']);

  const result = await waiting.done;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).body, 'late but done');
});

test('wait --types ignores report kinds the coordinator did not ask for', (t) => {
  const home = makeHome(t);
  const id = addTask(home);
  run(home, ['done', '--task', id, '--from', 'w1', '--body', 'done report']);

  const only = run(home, ['wait', '--json', '--types', 'ask', '--timeout', '0.5']);
  assert.equal(only.status, 2, 'a done report must not satisfy a wait for asks');

  // ...and it is still unread for a wait that does want it.
  assert.equal(runJson(home, ['wait', '--json', '--timeout', '5']).body, 'done report');
});

test('ask blocks until the coordinator replies, then prints the answer', async (t) => {
  const home = makeHome(t);
  const id = addTask(home);

  const asking = runAsync(home, [
    'ask',
    '--task',
    id,
    '--from',
    'w1',
    '--question',
    'which branch?',
    '--timeout',
    '20',
  ]);

  const question = runJson(home, ['wait', '--json', '--types', 'ask', '--timeout', '10']);
  assert.equal(question.type, 'ask');
  assert.equal(question.body, 'which branch?');
  assert.equal(asking.child.exitCode, null, 'ask must still be blocked before the reply lands');

  const replied = run(home, ['reply', '--id', question.id, '--body', 'use develop']);
  assert.equal(replied.status, 0, replied.stderr);

  const result = await asking.done;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'use develop');
});

test('ask exits 3 when no answer arrives', (t) => {
  const home = makeHome(t);
  const id = addTask(home);
  const r = run(home, ['ask', '--task', id, '--from', 'w1', '--question', 'hello?', '--timeout', '0.5']);
  assert.equal(r.status, 3, 'an unanswered ask is its own exit code, not a generic failure');
});

test('sweep fails the task of a worker that died before reporting', (t) => {
  const home = makeHome(t);
  const id = addTask(home);
  fakeDispatch(home, 'w1', id);

  const swept = runJson(home, ['sweep', '--json']);
  assert.deepEqual(swept.swept, ['w1']);
  assert.deepEqual(swept.orphaned, [id]);
  assert.equal(
    taskById(home, id).status,
    'failed',
    'a dispatch nobody can report on must not keep looking like work in flight',
  );
  assert.equal(runJson(home, ['ps', '--json']).workers.length, 0);
});

test('sweep --dry-run changes nothing', (t) => {
  const home = makeHome(t);
  const id = addTask(home);
  fakeDispatch(home, 'w1', id);

  const preview = runJson(home, ['sweep', '--dry-run', '--json']);
  assert.deepEqual(preview.swept, ['w1']);
  assert.deepEqual(preview.orphaned, [id]);
  assert.equal(preview.dryRun, true);
  assert.equal(taskById(home, id).status, 'dispatched');
  assert.equal(runJson(home, ['ps', '--json']).workers.length, 1);
});

test('task update rejects a status outside the state machine', (t) => {
  const home = makeHome(t);
  const id = addTask(home);

  const bad = run(home, ['task', 'update', '--id', id, '--status', 'in-progress']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /status must be one of/);
  assert.equal(taskById(home, id).status, 'pending');

  const missing = run(home, ['task', 'update', '--id', 't_nope', '--status', 'done']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no such task/);
});

test('reports against unknown tasks and messages are refused', (t) => {
  const home = makeHome(t);

  const orphanDone = run(home, ['done', '--task', 't_nope', '--from', 'w1', '--body', 'x']);
  assert.equal(orphanDone.status, 1);
  assert.match(orphanDone.stderr, /no such task/);

  const orphanReply = run(home, ['reply', '--id', 'm_nope', '--body', 'x']);
  assert.equal(orphanReply.status, 1);
  assert.match(orphanReply.stderr, /no such message/);
});

test('done refuses to guess which worker is reporting', (t) => {
  const home = makeHome(t);
  const id = addTask(home);

  const r = run(home, ['done', '--task', id, '--body', 'x']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot tell which worker this is/);
  assert.equal(taskById(home, id).status, 'pending', 'an unattributable report must not close a task');
});
