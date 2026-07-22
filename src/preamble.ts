import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { quote } from './agents.js';

function defaultResolveBin(): string | null {
  try {
    const bin = execFileSync('sh', ['-c', 'command -v -- orchestmux'], {
      encoding: 'utf8',
    }).trim();
    return bin || null;
  } catch {
    return null;
  }
}

/**
 * How a worker should invoke this CLI. The worker retypes it verbatim into a
 * non-login `sh` whose PATH is the tmux server's, not the coordinator's — so
 * a bare `orchestmux` that resolves here may not resolve there. Embed the
 * absolute paths instead, shell-quoted: an install under a directory with a
 * space would otherwise render a `done` command that cannot run, and a worker
 * that cannot report strands the coordinator forever.
 *
 * The lookups are injectable for tests.
 */
export function cliInvocation(
  resolveBin: () => string | null = defaultResolveBin,
  nodePath: string = process.execPath,
  scriptPath: string = fileURLToPath(new URL('./cli.js', import.meta.url)),
): string {
  const bin = resolveBin();
  if (bin) return quote(bin);
  return `${quote(nodePath)} ${quote(scriptPath)}`;
}

/**
 * The dispatch preamble. Everything the coordinator relies on — completion
 * reporting, blocking questions — happens because this text tells the worker
 * to call back into the CLI. Keep the commands copy-pasteable and unambiguous.
 */
export function dispatchPrompt(opts: { taskId: string; spec: string; cli: string }): string {
  const { taskId, spec, cli } = opts;
  return [
    `[ORCHESTMUX TASK ${taskId}]`,
    '',
    spec,
    '',
    '--- reporting protocol (required) ---',
    'A coordinator is blocked waiting on you. When the work is finished, run exactly:',
    `  ${cli} done --task ${taskId} --body "<3-5 sentence summary: what you did, what you found, what is left>"`,
    '',
    'If you are blocked and need a decision before you can continue, run:',
    `  ${cli} ask --task ${taskId} --question "<your question>"`,
    '  It blocks until the coordinator answers, then prints the answer to stdout.',
    '',
    'Report with the same `done` call even if the task failed — say so in the body.',
    'Do not skip it: without that call the coordinator waits forever.',
  ].join('\n');
}
