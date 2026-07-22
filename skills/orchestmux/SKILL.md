---
name: orchestmux
description: >-
  Run several coding-agent CLIs (codex, kimi, claude, opencode, gemini) in
  parallel as tmux panes and coordinate them with the `orchestmux` CLI: create
  tasks, dispatch them to workers, block on real completion, and answer blocking
  questions. Use when the user asks to run agents in parallel, delegate work to
  codex/kimi/another agent while supervising it, split a job across workers,
  watch agents work in tmux, or says "orchestmux". Do not use for a single
  one-off shell command, or for work the current agent should just do itself.
---

# orchestmux — multi-agent orchestration in tmux

`orchestmux` spawns coding-agent CLIs as tmux panes and gives every dispatched
task a reporting protocol, so a coordinator can block on actual completion
instead of scraping terminal output.

You are normally the **coordinator**. Workers are separate agent processes in
tmux panes; they report back by calling the CLI.

## Preconditions

Check once before coordinating:

```bash
orchestmux ps          # also confirms the CLI is installed and state is readable
tmux -V
```

If `orchestmux` is not on PATH, stop and tell the user how to install it
(`npm i -g orchestmux`, or `npm link` from a clone) rather than improvising a
substitute.

## When to use

- The user wants two or more agents working at the same time.
- The user wants work delegated to a *specific* agent (codex, kimi, …) while
  still getting the result back here.
- A job splits cleanly into independent pieces worth running concurrently.

## When not to use

- Work you can simply do yourself in this session. Spawning an agent to do a
  two-file edit is slower and burns another quota.
- The user asked to hand something off and explicitly does *not* want it
  supervised — then just spawn and dispatch, and do not sit in `wait`.

## The coordinator loop

```bash
orchestmux up                                   # idempotent
orchestmux spawn --name w1 --agent codex --yolo
TASK=$(orchestmux task add "<precise, self-contained spec>")
orchestmux dispatch --task $TASK --to w1
orchestmux wait --timeout 900                   # blocks; exit 2 == timeout
```

Workers land in the caller's own tmux window automatically when there is one:
orchestmux finds it through the process tree, so this works even though agent
harnesses strip `$TMUX`. Pass `--no-here` to force a dedicated session instead.

When there is no enclosing tmux window, workers go to the `orchestmux` session,
which nobody is watching by default. Run `orchestmux watch` — it opens a
terminal attached to that session (Windows Terminal under WSL, Terminal.app on
macOS) so the user can actually see the agents work.

Rules that matter:

- **Write the spec as if the worker knows nothing.** It gets the spec text and
  nothing else — no conversation history, no files you have open. Name absolute
  paths, and state the constraints ("read-only", "do not commit").
- **`--yolo` or it stalls.** Without it, codex/claude/gemini stop at an approval
  prompt and never report. Mention to the user that this grants unattended
  write access the first time you use it.
- **One worker, one task at a time.** Dispatching to a busy worker interrupts
  it and loses its first report, so `dispatch` refuses. Parallelism comes from
  spawning more workers, never from more dispatches to one.
- **One `wait` returns one message.** With N workers running, loop N times —
  or `wait --count N` to hold until all N have answered, which is what you
  want when the same task went to several agents and you mean to compare.
- **Timeout is a checkpoint, not a failure.** `wait` exits 2 when nothing
  arrived; real coding tasks run 15-60 minutes. Keep waiting, or check
  `orchestmux ps` and `tmux capture-pane -p -t <pane>` for liveness. Do not kill
  a worker just because it has not reported yet.
- **Answer `ask` promptly.** A worker that called `ask` is blocked until you
  `reply`; it cannot make progress on its own.

```bash
orchestmux wait                       # → [ask] w1 … id=m_9f8e7d6c
orchestmux reply --id m_9f8e7d6c --body "<decision>"
orchestmux wait                       # keep waiting for the eventual done
```

## Two shapes of parallel work

- **Ensemble** — the same spec to several agents at once, then compare and
  synthesise. Use when the user names multiple agents for one job, asks for the
  best result, or the task is judgement-heavy (designs, plans, improvement
  proposals) where models genuinely differ. Give each agent its own task id so
  reports stay attributable.
- **Split** — independent pieces to different workers. Use when the job
  decomposes cleanly and the pieces do not overlap.

When synthesising an ensemble, do not concatenate. Lead with what the agents
agree on, name the disagreements and check them against the code yourself, and
verify anything only one agent found before including it.

## Choosing workers

- Same worktree is fine for read-only or clearly disjoint work. For concurrent
  edits to the same files, give workers separate checkouts and say so in the
  spec — `orchestmux` does not isolate filesystems for you.
- Pick the agent the user named. If they did not name one, prefer `codex` for
  analysis and `claude` for large refactors, and say which you chose.
- Reuse an idle worker rather than spawning a duplicate; check `orchestmux ps`.

## Reporting back

When `wait` returns a `done`, its body is the worker's own summary. Read it,
verify anything load-bearing yourself (the worker may be wrong), then report to
the user in your own words. Say plainly which worker did what.

`wait` consumes each report once. Use `orchestmux report` to read them again —
when you are comparing several answers, or when the reports have scrolled out
of view. Comparing and judging the answers is your job, not the tool's.

If a worker reports failure (`--failed`) or goes silent past a reasonable
window, say so — do not quietly redo its work and present it as the worker's
result.

## Cleanup

```bash
orchestmux sweep --dry-run    # preview: idle and dead workers
orchestmux sweep              # remove them; workers still working are kept
orchestmux kill --name w1     # one specific worker
orchestmux down               # whole session
```

Do not sweep or kill immediately after reporting. The pane scrollback is the
only record of how a worker reached its conclusion, and you may need it to
check a claim. Sweep once the user has the results, or when they ask.

## Command reference

| Command | Purpose |
| --- | --- |
| `up` | Create the tmux session |
| `spawn --name <w> --agent <a> [--yolo] [--here]` | Add a worker pane (`--here` splits the current window) |
| `task add "<spec>"` | Create a task, prints its id |
| `task list [--json]` | List tasks and their status |
| `dispatch --task <id> --to <w>` | Send task + protocol to a worker |
| `wait [--types done,ask] [--timeout <s>]` | Block for the next report |
| `wait --count <n>` / `wait --all` | Hold for n reports / drain what is queued |
| `report [--task <id>] [--json]` | Re-read reports; `wait` consumes each once |
| `reply --id <msg> --body "<answer>"` | Answer a worker's `ask` |
| `ps [--json]` | Workers, tasks, unread count |
| `attach` | Attach to the tmux session (for the user) |
| `kill --name <w>` / `down` | Remove one worker / tear down |

Agents: `claude`, `codex`, `kimi`, `opencode`, `gemini`, `shell`.

Note: `shell` is a bare shell and **executes** a dispatched preamble line by
line. Use it to test the protocol by hand, never as a real dispatch target.
