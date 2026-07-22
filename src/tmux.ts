import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export class TmuxError extends Error {}

export function tmux(args: string[]): string {
  try {
    return execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new TmuxError(`tmux ${args.join(' ')}: ${(e.stderr || e.message).trim()}`);
  }
}

export function tmuxAvailable(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function hasSession(session: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', `=${session}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function newSession(session: string, cwd: string): void {
  tmux(['new-session', '-d', '-s', session, '-n', 'workers', '-c', cwd]);
}

/** True when this process is itself running inside a tmux pane. */
export function insideTmux(): boolean {
  return Boolean(process.env.TMUX) || enclosingWindow() !== null;
}

/** Every pid from this process up to init. */
function ancestorPids(): Set<number> {
  const pids = new Set<number>();
  let pid = process.pid;
  for (let i = 0; i < 32 && pid > 1; i++) {
    pids.add(pid);
    let ppid = 0;
    try {
      ppid = Number(
        execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim(),
      );
    } catch {
      break;
    }
    if (!Number.isFinite(ppid) || ppid <= 0) break;
    pid = ppid;
  }
  return pids;
}

let enclosingWindowCache: string | null | undefined;

/**
 * The tmux window this process is running under, or null.
 *
 * $TMUX is the obvious signal but it is not reliable: agent harnesses spawn
 * tools with a sanitised environment, so a coordinator running inside tmux
 * looks like it is outside. Matching a pane's process against our own ancestry
 * answers the question the env var was supposed to.
 *
 * Memoised: the walk forks `ps` once per ancestor, the answer cannot change
 * within one CLI invocation, and spawn alone used to ask three times.
 */
export function enclosingWindow(): string | null {
  if (enclosingWindowCache !== undefined) return enclosingWindowCache;
  enclosingWindowCache = findEnclosingWindow();
  return enclosingWindowCache;
}

function findEnclosingWindow(): string | null {
  let listing: string;
  try {
    listing = execFileSync(
      'tmux',
      ['list-panes', '-a', '-F', '#{pane_pid} #{session_name}:#{window_id}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return null;
  }
  const mine = ancestorPids();
  for (const line of listing.trim().split('\n')) {
    const [pid, target] = line.split(' ');
    if (pid && target && mine.has(Number(pid))) return target;
  }
  return null;
}

/** "session:@windowid" of the window this process is running in. */
export function currentWindow(): string {
  return tmux(['display-message', '-p', '#{session_name}:#{window_id}']).trim();
}

export function currentSessionName(): string {
  return tmux(['display-message', '-p', '#{session_name}']).trim();
}

/** In-tmux equivalent of `attach`: move the attached client to another session. */
export function switchClient(session: string): void {
  tmux(['switch-client', '-t', `=${session}`]);
}

export function attachedClients(session: string): number {
  try {
    const out = execFileSync('tmux', ['list-clients', '-t', `=${session}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() === '' ? 0 : out.trim().split('\n').length;
  } catch {
    return 0;
  }
}

/**
 * Opens a terminal window attached to `session`, so workers spawned by a
 * coordinator that is not itself in tmux are still watchable. Returns the
 * command used, or null when no terminal could be launched.
 */
export function openTerminal(session: string): string | null {
  // The session name ends up inside a shell command (and, on macOS, inside an
  // AppleScript string literal) — quote it for both layers, not just the happy
  // path of a bare word.
  const attach = `tmux attach -t ${shellQuote(`=${session}`)}`;
  const isWsl = Boolean(process.env.WSL_DISTRO_NAME);

  const candidates: { cmd: string; args: string[]; label: string }[] = [];
  if (isWsl) {
    const distro = process.env.WSL_DISTRO_NAME!;
    candidates.push({
      cmd: 'wt.exe',
      args: ['-w', '0', 'nt', 'wsl.exe', '-d', distro, '--', 'tmux', 'attach', '-t', session],
      label: 'Windows Terminal',
    });
    candidates.push({
      cmd: 'cmd.exe',
      args: ['/c', 'start', '', 'wsl.exe', '-d', distro, '--', 'tmux', 'attach', '-t', session],
      label: 'cmd start',
    });
  } else if (process.platform === 'darwin') {
    const script = attach.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    candidates.push({
      cmd: 'osascript',
      args: ['-e', `tell application "Terminal" to do script "${script}"`],
      label: 'Terminal.app',
    });
  } else {
    candidates.push({ cmd: 'x-terminal-emulator', args: ['-e', attach], label: 'x-terminal' });
  }

  for (const c of candidates) {
    try {
      execFileSync(c.cmd, c.args, { stdio: 'ignore', timeout: 10_000 });
      return c.label;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/**
 * Adds a worker pane to `window`. `reuseFirst` respawns the placeholder shell
 * a fresh session starts with, so a dedicated session never keeps a stray idle
 * pane around; when splitting into a window you already occupy, it is off.
 */
export function addPane(opts: {
  window: string;
  cwd: string;
  env: Record<string, string>;
  command: string;
  reuseFirst: boolean;
}): string {
  const envArgs = Object.entries(opts.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  if (opts.reuseFirst) {
    const pane = tmux(['list-panes', '-t', opts.window, '-F', '#{pane_id}']).trim().split('\n')[0];
    if (!pane) throw new TmuxError(`no pane found in ${opts.window}`);
    // respawn-pane cannot set env, so export inline before exec.
    const exports = Object.entries(opts.env)
      .map(([k, v]) => `export ${k}=${shellQuote(v)};`)
      .join(' ');
    tmux([
      'respawn-pane',
      '-k',
      '-t',
      pane,
      '-c',
      opts.cwd,
      'sh',
      '-c',
      `${exports} exec ${opts.command}`,
    ]);
    retainOnExit(pane);
    return pane;
  }

  const pane = tmux([
    'split-window',
    '-t',
    opts.window,
    '-d',
    '-P',
    '-F',
    '#{pane_id}',
    '-c',
    opts.cwd,
    ...envArgs,
    opts.command,
  ]).trim();
  retainOnExit(pane);
  tmux(['select-layout', '-t', opts.window, 'tiled']);
  return pane;
}

/** Replaces whatever runs in `paneId` with `command`, keeping the pane. */
export function respawnPane(opts: {
  paneId: string;
  cwd: string;
  env: Record<string, string>;
  command: string;
}): void {
  const exports = Object.entries(opts.env)
    .map(([k, v]) => `export ${k}=${shellQuote(v)};`)
    .join(' ');
  tmux([
    'respawn-pane',
    '-k',
    '-t',
    opts.paneId,
    '-c',
    opts.cwd,
    'sh',
    '-c',
    `${exports} exec ${opts.command}`,
  ]);
  retainOnExit(opts.paneId);
}

/**
 * pane_id -> "the process in it is still running". Worker panes are kept
 * around after their process exits (remain-on-exit), so existence and
 * liveness are different questions — a dead pane still has its scrollback
 * and can be revived by respawn-pane, but nothing in it will ever report.
 */
export function paneStates(): Map<string, boolean> {
  const states = new Map<string, boolean>();
  try {
    const out = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_dead}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.trim().split('\n')) {
      const [id, dead] = line.split(' ');
      if (id) states.set(id, dead !== '1');
    }
  } catch {
    /* no server — nothing exists, nothing is alive */
  }
  return states;
}

export function paneAlive(paneId: string, states = paneStates()): boolean {
  return states.get(paneId) === true;
}

export function paneExists(paneId: string, states = paneStates()): boolean {
  return states.has(paneId);
}

/**
 * Keeps the pane (and its scrollback) around after the process exits. Without
 * this a headless agent's pane closes the moment it finishes, destroying the
 * only record of how it reached its answer. Pane-scoped options need tmux
 * >= 3.0; on older servers the pane just closes as before.
 */
function retainOnExit(paneId: string): void {
  try {
    tmux(['set-option', '-p', '-t', paneId, 'remain-on-exit', 'on']);
  } catch {
    /* best effort */
  }
}

export function killPane(paneId: string): void {
  try {
    execFileSync('tmux', ['kill-pane', '-t', paneId], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

export function capturePane(paneId: string, lines = 200): string {
  return tmux(['capture-pane', '-p', '-t', paneId, '-S', `-${lines}`]);
}

/**
 * Delivers a multi-line prompt to a TUI agent. send-keys would interpret
 * newlines as submits, so the text goes through a tmux buffer (bracketed
 * paste) and only then do we press Enter.
 */
export function sendPrompt(paneId: string, text: string): void {
  const file = join(tmpdir(), `orchestmux-${randomBytes(6).toString('hex')}.txt`);
  const buffer = `orchestmux-${randomBytes(4).toString('hex')}`;
  writeFileSync(file, text, 'utf8');
  try {
    tmux(['load-buffer', '-b', buffer, file]);
    tmux(['paste-buffer', '-b', buffer, '-t', paneId, '-d']);
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* best effort */
    }
  }
}

export function sendEnter(paneId: string): void {
  tmux(['send-keys', '-t', paneId, 'Enter']);
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
