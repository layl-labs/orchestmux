import { execFileSync } from 'node:child_process';

export interface AgentSpec {
  /** Executable expected on PATH. */
  cmd: string;
  /** Flags that let the agent act without stopping for interactive approval. */
  autonomousArgs: string[];
}

/**
 * Known coding CLIs. `shell` is deliberately included: it is the cheapest way
 * to exercise the dispatch/report protocol without spending agent quota.
 */
export const AGENTS: Record<string, AgentSpec> = {
  claude: { cmd: 'claude', autonomousArgs: ['--dangerously-skip-permissions'] },
  codex: { cmd: 'codex', autonomousArgs: ['--dangerously-bypass-approvals-and-sandbox'] },
  kimi: { cmd: 'kimi', autonomousArgs: [] },
  opencode: { cmd: 'opencode', autonomousArgs: [] },
  gemini: { cmd: 'gemini', autonomousArgs: ['--yolo'] },
  shell: { cmd: process.env.SHELL || 'bash', autonomousArgs: [] },
};

export function agentNames(): string[] {
  return Object.keys(AGENTS);
}

export function isInstalled(cmd: string): boolean {
  try {
    execFileSync('sh', ['-lc', `command -v ${JSON.stringify(cmd)}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function buildCommand(agent: string, autonomous: boolean, extraArgs: string[]): string {
  const spec = AGENTS[agent];
  if (!spec) throw new Error(`unknown agent "${agent}" (known: ${agentNames().join(', ')})`);
  const args = [...(autonomous ? spec.autonomousArgs : []), ...extraArgs];
  return [spec.cmd, ...args].map(quote).join(' ');
}

function quote(s: string): string {
  return /^[\w./:=-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}
