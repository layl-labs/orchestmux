import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cliInvocation, dispatchPrompt } from '../dist/preamble.js';

/**
 * The preamble is the whole protocol. If a worker cannot read a runnable
 * `done` call out of it, the coordinator blocks forever — so these assert the
 * exact shape an agent has to retype, not just that some text was produced.
 */

const OPTS = { taskId: 't_abc123', spec: 'Audit packages/api', cli: 'orchestmux' };

test('carries the task id, the spec, and a runnable done call', () => {
  const p = dispatchPrompt(OPTS);
  assert.match(p, /^\[ORCHESTMUX TASK t_abc123\]/);
  assert.match(p, /Audit packages\/api/);
  assert.match(p, /orchestmux done --task t_abc123 --body "/);
});

test('offers the ask back-channel with the same task id', () => {
  const p = dispatchPrompt(OPTS);
  assert.match(p, /orchestmux ask --task t_abc123 --question "/);
  assert.match(p, /blocks until the coordinator answers/);
});

test('tells the worker to report failures through the same call', () => {
  const p = dispatchPrompt(OPTS);
  // A worker that treats failure as "nothing to report" is the one way a
  // dispatched task can strand the coordinator without anything crashing.
  assert.match(p, /same `done` call even if the task failed/);
  assert.match(p, /without that call the coordinator waits forever/);
});

test('uses the resolved cli invocation verbatim when orchestmux is not on PATH', () => {
  const p = dispatchPrompt({ ...OPTS, cli: '/usr/bin/node /opt/orchestmux/dist/cli.js' });
  assert.match(p, /\/usr\/bin\/node \/opt\/orchestmux\/dist\/cli\.js done --task t_abc123/);
  assert.doesNotMatch(p, /^\s+orchestmux done/m);
});

test('keeps each command on its own line so it survives copy-paste', () => {
  const commands = dispatchPrompt(OPTS)
    .split('\n')
    .filter((l) => l.trim().startsWith('orchestmux '));
  assert.equal(commands.length, 2);
  for (const c of commands) assert.doesNotMatch(c, /\.\.\.|<snip>/);
});

test('embeds a multi-line spec without breaking the header', () => {
  const spec = 'line one\nline two\n\nline four';
  const p = dispatchPrompt({ ...OPTS, spec });
  assert.match(p, /line four/);
  assert.equal(p.split('\n')[0], '[ORCHESTMUX TASK t_abc123]');
});

test('cliInvocation embeds the resolved binary path, not the bare name', () => {
  // The worker's PATH is the tmux server's, not the coordinator's — a shim
  // dir visible here (nvm, npm prefix) may be missing there, and a worker
  // that cannot run the callback strands the coordinator.
  assert.equal(cliInvocation(() => '/home/u/.nvm/current/bin/orchestmux'), '/home/u/.nvm/current/bin/orchestmux');
});

test('cliInvocation shell-quotes paths so installs with spaces can still report', () => {
  const quoted = cliInvocation(() => null, '/opt/node bins/node', '/home/u/Agent Tools/dist/cli.js');
  assert.equal(quoted, `'/opt/node bins/node' '/home/u/Agent Tools/dist/cli.js'`);

  const resolved = cliInvocation(() => '/home/u/Agent Tools/bin/orchestmux');
  assert.equal(resolved, `'/home/u/Agent Tools/bin/orchestmux'`);

  // Boring paths stay bare, so the prompt the agent reads stays readable.
  assert.equal(cliInvocation(() => null, '/usr/bin/node', '/opt/orchestmux/dist/cli.js'), '/usr/bin/node /opt/orchestmux/dist/cli.js');
});
