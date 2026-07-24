import { execFileSync } from 'node:child_process';

/** How a prompt reaches an agent at launch. */
export type PromptMode = { kind: 'positional' } | { kind: 'flag'; flag: string };

export interface AgentSpec {
  /** Executable expected on PATH. */
  cmd: string;
  /**
   * Arguments that must ALWAYS precede the prompt — subcommands (`run`, `exec`)
   * or headless-mode switches (`-p`) an agent needs to run non-interactively at
   * all. Unlike `autonomousArgs`, these are present in both modes.
   */
  baseArgs?: string[];
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
  preflightTrust?: 'codex' | 'claude' | 'agy' | 'gemini' | 'qwen';
}

export const AGENTS: Record<string, AgentSpec> = {
  // --dangerously-skip-permissions clears tool-approval prompts but not the
  // per-directory "Do you trust the files in this folder?" dialog; a worker in
  // an untrusted directory sits at it forever. preflightTrust marks it accepted
  // before the pane launches, the same way codex is pre-trusted.
  claude: {
    cmd: 'claude',
    autonomousArgs: ['--dangerously-skip-permissions'],
    prompt: { kind: 'positional' },
    preflightTrust: 'claude',
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
  // opencode's `run` subcommand is its headless mode; the bare command opens the
  // TUI, which strands a worker in a tmux pane. --auto auto-approves permissions
  // that are not explicitly denied — the same unattended contract as --yolo —
  // covering the external-directory and webfetch prompts that `run` alone still
  // stops on.
  opencode: {
    cmd: 'opencode',
    baseArgs: ['run'],
    autonomousArgs: ['--auto'],
    prompt: { kind: 'positional' },
  },
  // Folder trust is off by default in gemini-cli, but if the user enabled it
  // --yolo does not clear the gate; preflightTrust seeds it defensively.
  gemini: {
    cmd: 'gemini',
    autonomousArgs: ['--yolo'],
    prompt: { kind: 'flag', flag: '-p' },
    preflightTrust: 'gemini',
  },
  // Google Antigravity CLI. `-p` runs headless (auto-approves tool calls on its
  // own); --dangerously-skip-permissions also clears command-execution prompts.
  // Neither answers its first-launch workspace-trust gate, so seed that too.
  agy: {
    cmd: 'agy',
    autonomousArgs: ['--dangerously-skip-permissions'],
    prompt: { kind: 'flag', flag: '-p' },
    preflightTrust: 'agy',
  },
  // qwen-code is a gemini-cli fork and shares its surface exactly, folder trust
  // included.
  qwen: {
    cmd: 'qwen',
    autonomousArgs: ['--yolo'],
    prompt: { kind: 'flag', flag: '-p' },
    preflightTrust: 'qwen',
  },
  // Cursor CLI. `-p` is the headless print switch (always needed); the prompt
  // is positional. `--force` auto-approves tool/command execution.
  cursor: {
    cmd: 'cursor-agent',
    baseArgs: ['-p'],
    autonomousArgs: ['--force'],
    prompt: { kind: 'positional' },
  },
  // aider runs one message and exits. `--yes-always` skips every confirmation.
  aider: {
    cmd: 'aider',
    autonomousArgs: ['--yes-always'],
    prompt: { kind: 'flag', flag: '--message' },
  },
  // Sourcegraph Amp. `-x` executes the prompt and exits. Amp does not prompt
  // for tool approval by default; --dangerously-allow-all forces it fully.
  amp: {
    cmd: 'amp',
    autonomousArgs: ['--dangerously-allow-all'],
    prompt: { kind: 'flag', flag: '-x' },
  },
  // GitHub Copilot CLI (@github/copilot). --allow-all-tools skips approvals.
  copilot: {
    cmd: 'copilot',
    autonomousArgs: ['--allow-all-tools'],
    prompt: { kind: 'flag', flag: '-p' },
  },
  // Charm Crush. `run` is the non-interactive subcommand; prompt is positional.
  crush: {
    cmd: 'crush',
    baseArgs: ['run'],
    autonomousArgs: ['--yolo'],
    prompt: { kind: 'positional' },
  },
  // Factory droid. `exec` is the headless subcommand; `--auto high` grants the
  // widest autonomy without the unsafe permission bypass.
  droid: {
    cmd: 'droid',
    baseArgs: ['exec'],
    autonomousArgs: ['--auto', 'high'],
    prompt: { kind: 'positional' },
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
  const args = [
    ...(spec.baseArgs ?? []),
    ...(autonomous ? spec.autonomousArgs : []),
    ...extraArgs,
  ];
  if (prompt !== undefined && prompt !== '') {
    if (spec.prompt.kind === 'flag') args.push(spec.prompt.flag, prompt);
    else args.push(prompt);
  }
  return [spec.cmd, ...args].map(quote).join(' ');
}

/** Shell-quotes an argument, leaving bare words alone for readability. */
export function quote(s: string): string {
  return /^[\w./:=-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}
