import { execFileSync } from 'node:child_process';

/** How a prompt reaches an agent at launch. */
export type PromptMode = { kind: 'positional' } | { kind: 'flag'; flag: string };

export interface AgentSpec {
  /** Executable expected on PATH. */
  cmd: string;
  /** Flags that let the agent act without stopping for interactive approval. */
  autonomousArgs: string[];
  /**
   * Prompts are passed at launch, never typed into a running TUI. Pasting into
   * a live composer has to win three races — the agent must be mounted, the
   * bracketed paste must finish before the submit key lands, and the pane must
   * not be in tmux copy-mode — and losing any of them strands the prompt
   * unsent. Launch arguments have none of those failure modes.
   */
  prompt: PromptMode;
  /** Agent blocks on a per-directory trust prompt that --yolo does not cover. */
  preflightTrust?: 'codex';
}

export const AGENTS: Record<string, AgentSpec> = {
  claude: {
    cmd: 'claude',
    autonomousArgs: ['--dangerously-skip-permissions'],
    prompt: { kind: 'positional' },
  },
  codex: {
    cmd: 'codex',
    autonomousArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    prompt: { kind: 'positional' },
    preflightTrust: 'codex',
  },
  // kimi and gemini run the prompt once and exit; their panes survive that
  // (remain-on-exit) and dispatch revives them, so they are reusable workers.
  kimi: { cmd: 'kimi', autonomousArgs: [], prompt: { kind: 'flag', flag: '-p' } },
  opencode: { cmd: 'opencode', autonomousArgs: [], prompt: { kind: 'flag', flag: '--prompt' } },
  gemini: {
    cmd: 'gemini',
    autonomousArgs: ['--yolo'],
    prompt: { kind: 'flag', flag: '-p' },
  },
  shell: {
    cmd: process.env.SHELL || 'bash',
    autonomousArgs: [],
    prompt: { kind: 'positional' },
  },
};

export function agentNames(): string[] {
  return Object.keys(AGENTS);
}

export function isInstalled(cmd: string): boolean {
  // The name rides in as a positional argument, so no quoting layer to get
  // wrong — and no `-l`: sourcing the login profile per check is slow and
  // does not reflect the non-login `sh -c` a worker pane actually runs under.
  try {
    execFileSync('sh', ['-c', 'command -v -- "$1"', 'sh', cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Launch command for an agent, optionally carrying the prompt. */
export function buildCommand(
  agent: string,
  autonomous: boolean,
  extraArgs: string[],
  prompt?: string,
): string {
  const spec = AGENTS[agent];
  if (!spec) throw new Error(`unknown agent "${agent}" (known: ${agentNames().join(', ')})`);
  const args = [...(autonomous ? spec.autonomousArgs : []), ...extraArgs];
  if (prompt !== undefined && prompt !== '') {
    if (spec.prompt.kind === 'flag') args.push(spec.prompt.flag, prompt);
    else args.push(prompt);
  }
  return [spec.cmd, ...args].map(quote).join(' ');
}

function quote(s: string): string {
  return /^[\w./:=-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}
