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
  return Boolean(process.env.TMUX);
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
  tmux(['select-layout', '-t', opts.window, 'tiled']);
  return pane;
}

export function paneAlive(paneId: string): boolean {
  try {
    const out = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').includes(paneId);
  } catch {
    return false;
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
