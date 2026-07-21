import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * How a worker should invoke this CLI. Prefer the bare name so the injected
 * prompt stays readable, but fall back to an absolute path when the package
 * is not linked onto PATH — the agent has to be able to run it verbatim.
 */
export function cliInvocation(): string {
  try {
    execFileSync('sh', ['-lc', 'command -v orchestmux'], { stdio: 'ignore' });
    return 'orchestmux';
  } catch {
    return `node ${fileURLToPath(new URL('./cli.js', import.meta.url))}`;
  }
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
