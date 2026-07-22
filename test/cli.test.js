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

test('a report from anyone but the assignee is refused', (t) => {
  const home = makeHome(t);
  const id = addTask(home);
  fakeDispatch(home, 'w1', id);

  // The realistic failure: with several workers running, an agent retypes the
  // wrong id and closes work that is still in flight.
  const wrong = run(home, ['done', '--task', id, '--from', 'w2', '--body', 'not mine to close']);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /assigned to "w1", not "w2"/);
  assert.equal(taskById(home, id).status, 'dispatched');

  const right = run(home, ['done', '--task', id, '--from', 'w1', '--body', 'mine']);
  assert.equal(right.status, 0, right.stderr);
  assert.equal(taskById(home, id).status, 'done');
});

test('--force lets a report through, and unassigned tasks stay open to anyone', (t) => {
  const home = makeHome(t);

  const assigned = addTask(home, 'assigned');
  fakeDispatch(home, 'w1', assigned);
  const forced = run(home, ['done', '--task', assigned, '--from', 'w2', '--force', '--body', 'took over']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(taskById(home, assigned).status, 'done');

  // Nobody has claimed this one, so finishing it by hand must still work.
  const loose = addTask(home, 'never dispatched');
  const byHand = run(home, ['done', '--task', loose, '--from', 'me', '--body', 'closed manually']);
  assert.equal(byHand.status, 0, byHand.stderr);
  assert.equal(taskById(home, loose).status, 'done');
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

test('wait --count holds until every ensemble worker has reported', (t) => {
  const home = makeHome(t);
  const a = addTask(home, 'same question, agent A');
  const b = addTask(home, 'same question, agent B');
  run(home, ['done', '--task', a, '--from', 'wA', '--body', 'answer A']);

  // Only one of the two has reported, so a wait for both must not return yet.
  const short = run(home, ['wait', '--count', '2', '--json', '--timeout', '0.5']);
  assert.equal(short.status, 2, 'an incomplete set is a timeout, not a success');
  const partial = JSON.parse(short.stdout);
  assert.equal(partial.length, 1, 'reports already collected are still printed');
  assert.equal(partial[0].body, 'answer A');

  // That first report was consumed; once B lands, a wait for the rest returns.
  run(home, ['done', '--task', b, '--from', 'wB', '--body', 'answer B']);
  const rest = runJson(home, ['wait', '--count', '1', '--json', '--timeout', '5']);
  assert.equal(rest.body, 'answer B');
});

test('wait --all drains everything queued in one call', (t) => {
  const home = makeHome(t);
  const ids = ['one', 'two', 'three'].map((s) => addTask(home, s));
  ids.forEach((id, i) => run(home, ['done', '--task', id, '--from', `w${i}`, '--body', `report ${i}`]));

  const all = runJson(home, ['wait', '--all', '--json', '--timeout', '5']);
  assert.equal(all.length, 3, 'all three reports should come back together');
  assert.deepEqual(all.map((m) => m.body), ['report 0', 'report 1', 'report 2']);

  // Everything was marked read, so there is nothing left to drain.
  assert.equal(run(home, ['wait', '--all', '--json', '--timeout', '0.5']).status, 2);
});

test('wait returns a bare object when asked for a single report', (t) => {
  const home = makeHome(t);
  const id = addTask(home);
  run(home, ['done', '--task', id, '--from', 'w1', '--body', 'solo']);

  // Callers written against the original single-message contract must not
  // suddenly receive an array.
  const msg = runJson(home, ['wait', '--json', '--timeout', '5']);
  assert.equal(Array.isArray(msg), false);
  assert.equal(msg.body, 'solo');
});

test('report re-reads collected reports after wait consumed them', (t) => {
  const home = makeHome(t);
  const a = addTask(home, 'audit the parser');
  const b = addTask(home, 'audit the api');
  run(home, ['done', '--task', a, '--from', 'wA', '--body', 'parser looks fine']);
  run(home, ['done', '--task', b, '--from', 'wB', '--failed', '--body', 'api never built']);

  // Consume both the way a coordinator would.
  assert.equal(runJson(home, ['wait', '--all', '--json', '--timeout', '5']).length, 2);

  const reports = runJson(home, ['report', '--json']);
  assert.equal(reports.length, 2, 'reading a report must not consume it');
  assert.deepEqual(reports.map((r) => r.body), ['parser looks fine', 'api never built']);
  assert.deepEqual(reports.map((r) => r.status), ['done', 'failed']);
  assert.equal(reports[0].spec, 'audit the parser', 'the report carries what was asked');

  const one = runJson(home, ['report', '--task', b, '--json']);
  assert.equal(one.length, 1);
  assert.equal(one[0].from_worker, 'wB');

  // Plain-text output is what a human actually reads.
  const text = run(home, ['report']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /parser looks fine/);
  assert.match(text.stdout, /api never built/);
});

test('report is honest when there is nothing to show', (t) => {
  const home = makeHome(t);
  const id = addTask(home);
  assert.match(run(home, ['report']).stdout, /no reports yet/);
  assert.match(run(home, ['report', '--task', id]).stdout, new RegExp(`no report for ${id}`));

  const missing = run(home, ['report', '--task', 't_nope']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no such task/);
});

test('concurrent workers can all report at once', async (t) => {
  const home = makeHome(t);
  const ids = Array.from({ length: 8 }, (_, i) => addTask(home, `parallel task ${i}`));

  // The real shape of this tool: a swarm finishing together, every pane
  // opening the same database at the same moment. Serialised writes are fine;
  // what is not fine is one of them failing outright, because a `done` that
  // dies takes the report with it and the coordinator waits forever.
  const results = await Promise.all(
    ids.map((id, i) =>
      runAsync(home, ['done', '--task', id, '--from', `w${i}`, '--body', `report ${i}`]).done,
    ),
  );

  results.forEach((r, i) => {
    assert.equal(r.status, 0, `worker ${i} failed to report: ${r.stderr}`);
  });

  const collected = runJson(home, ['wait', '--all', '--json', '--timeout', '10']);
  assert.equal(collected.length, ids.length, 'every concurrent report must survive');
  assert.equal(
    runJson(home, ['task', 'list', '--json']).filter((task) => task.status === 'done').length,
    ids.length,
  );
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

test('a second done on an already-reported task is refused', (t) => {
  const home = makeHome(t);
  const id = addTask(home);
  run(home, ['done', '--task', id, '--from', 'w1', '--body', 'first report']);

  // Agents retry commands whose output they never saw; the duplicate must not
  // become a second message, or it would satisfy an ensemble wait on its own.
  const again = run(home, ['done', '--task', id, '--from', 'w1', '--body', 'accidental retry']);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already has a report/);
  assert.equal(taskById(home, id).result, 'first report');

  // A deliberate replacement is still possible.
  const forced = run(home, ['done', '--task', id, '--from', 'w1', '--force', '--body', 'corrected']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(taskById(home, id).result, 'corrected');
});

test('sessions do not see each other\'s tasks or reports', (t) => {
  const home = makeHome(t);
  const idA = run(home, ['task', 'add', 'work for swarm A', '--session', 'swarm-a']).stdout.trim();
  run(home, ['done', '--task', idA, '--from', 'w1', '--body', 'A finished']);

  // The report belongs to swarm A; a coordinator waiting on swarm B must not
  // consume it — that is exactly the report-stealing bug sessions exist to fix.
  const stolen = run(home, ['wait', '--json', '--timeout', '0.5', '--session', 'swarm-b']);
  assert.equal(stolen.status, 2, 'a wait on another session must time out, not steal the report');

  const own = runJson(home, ['wait', '--json', '--timeout', '5', '--session', 'swarm-a']);
  assert.equal(own.body, 'A finished');

  // Task listings are scoped the same way.
  assert.equal(runJson(home, ['task', 'list', '--json', '--session', 'swarm-b']).length, 0);
  assert.equal(runJson(home, ['task', 'list', '--json', '--session', 'swarm-a']).length, 1);
});

test('wait escalates instead of blocking when the assigned worker is dead', (t) => {
  const home = makeHome(t);
  const id = addTask(home);
  fakeDispatch(home, 'w1', id); // pane %9999 does not exist anywhere

  // Without the watchdog this would sit out the full timeout on a report that
  // can never come; with it, the same wait returns the diagnosis.
  const msg = runJson(home, ['wait', '--json', '--timeout', '10']);
  assert.equal(msg.type, 'escalation');
  assert.equal(msg.task_id, id);
  assert.equal(msg.from_worker, 'w1');
  assert.equal(taskById(home, id).status, 'failed');
});

test('kill fails the dispatched task of the worker it removes', (t) => {
  const home = makeHome(t);
  const id = addTask(home);
  fakeDispatch(home, 'w1', id);

  const r = run(home, ['kill', '--name', 'w1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /marked failed/);
  assert.equal(
    taskById(home, id).status,
    'failed',
    'killing a worker mid-task must not leave the task looking in flight',
  );
});

test('down fails the dispatched tasks of the workers it tears down', (t) => {
  const home = makeHome(t);
  const id = addTask(home);
  fakeDispatch(home, 'w1', id);

  const r = run(home, ['down']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(taskById(home, id).status, 'failed');
  assert.equal(runJson(home, ['ps', '--json']).workers.length, 0);
});

test('everything after -- is positional, never an orchestmux flag', (t) => {
  const home = makeHome(t);
  const id = run(home, ['task', 'add', '--', '--not-a-flag', 'spec words']).stdout.trim();
  assert.match(id, /^t_[0-9a-f]{8}$/);
  assert.equal(
    taskById(home, id).spec,
    '--not-a-flag spec words',
    'agent-bound flags must survive the parser instead of being eaten as options',
  );
});

test('a numeric flag that does not parse fails loudly instead of using the default', (t) => {
  const home = makeHome(t);
  const r = run(home, ['wait', '--timeout', 'abc']);
  assert.equal(r.status, 1, 'silently waiting 900s the caller never asked for is not an option');
  assert.match(r.stderr, /--timeout expects a number/);
});

test('task clear removes finished tasks and their messages, keeping live ones', (t) => {
  const home = makeHome(t);
  const finished = addTask(home, 'will finish');
  const pending = addTask(home, 'still open');
  run(home, ['done', '--task', finished, '--from', 'w1', '--body', 'done and dusted']);

  const r = run(home, ['task', 'clear']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cleared 1 finished task/);

  const remaining = runJson(home, ['task', 'list', '--json']);
  assert.deepEqual(remaining.map((task) => task.id), [pending]);
  assert.equal(runJson(home, ['report', '--json']).length, 0, 'cleared tasks take their reports with them');
});
