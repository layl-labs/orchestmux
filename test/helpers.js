import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tests drive the built CLI as a subprocess rather than importing its
 * functions: `cli.ts` calls `main()` at module scope, and the thing worth
 * asserting on is the contract a worker actually invokes — argv in, exit code
 * and stdout out.
 */
export const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

/** A throwaway ORCHESTMUX_HOME so tests never touch the developer's own state. */
export function makeHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'orchestmux-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function env(home) {
  return {
    ...process.env,
    ORCHESTMUX_HOME: home,
    // Isolate from any session the developer happens to be running, and from
    // the pane this test suite itself may be sitting in.
    ORCHESTMUX_SESSION: 'orchestmux-test',
    ORCHESTMUX_WORKER: '',
    TMUX: '',
  };
}

const NODE_ARGS = ['--disable-warning=ExperimentalWarning'];

export function run(home, args) {
  const r = spawnSync(process.execPath, [...NODE_ARGS, CLI, ...args], {
    encoding: 'utf8',
    env: env(home),
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function runJson(home, args) {
  const r = run(home, args);
  if (r.status !== 0) {
    throw new Error(`orchestmux ${args.join(' ')} exited ${r.status}: ${r.stderr || r.stdout}`);
  }
  return JSON.parse(r.stdout);
}

/** Starts a blocking command (`ask`, `wait`) without waiting for it to finish. */
export function runAsync(home, args) {
  const child = spawn(process.execPath, [...NODE_ARGS, CLI, ...args], { env: env(home) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const done = new Promise((resolve) => {
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  return { child, done };
}

export function taskById(home, id) {
  return runJson(home, ['task', 'list', '--json']).find((t) => t.id === id);
}
