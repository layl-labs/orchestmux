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

If the user wants to watch the workers and you are running inside tmux, spawn
with `--here` so panes split the user's current window — `attach` cannot nest
into a second tmux session, so a dedicated session would be invisible to them.

Rules that matter:

- **Write the spec as if the worker knows nothing.** It gets the spec text and
  nothing else — no conversation history, no files you have open. Name absolute
  paths, and state the constraints ("read-only", "do not commit").
- **`--yolo` or it stalls.** Without it, codex/claude/gemini stop at an approval
  prompt and never report. Mention to the user that this grants unattended
  write access the first time you use it.
- **One `wait` returns one message.** With N workers running, loop N times.
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

If a worker reports failure (`--failed`) or goes silent past a reasonable
window, say so — do not quietly redo its work and present it as the worker's
result.

## Cleanup

```bash
orchestmux kill --name w1     # one worker
orchestmux down               # whole session
```

Leave workers running if the user may want to keep using them; tear down when
the job is finished and the user has the results.

## Command reference

| Command | Purpose |
| --- | --- |
| `up` | Create the tmux session |
| `spawn --name <w> --agent <a> [--yolo] [--here]` | Add a worker pane (`--here` splits the current window) |
| `task add "<spec>"` | Create a task, prints its id |
| `task list [--json]` | List tasks and their status |
| `dispatch --task <id> --to <w>` | Send task + protocol to a worker |
| `wait [--types done,ask] [--timeout <s>]` | Block for the next report |
| `reply --id <msg> --body "<answer>"` | Answer a worker's `ask` |
| `send --to <w> --body "<text>"` | Free-form message to a worker |
| `ps [--json]` | Workers, tasks, unread count |
| `attach` | Attach to the tmux session (for the user) |
| `kill --name <w>` / `down` | Remove one worker / tear down |

Agents: `claude`, `codex`, `kimi`, `opencode`, `gemini`, `shell`.

Note: `shell` is a bare shell and **executes** a dispatched preamble line by
line. Use it to test the protocol by hand, never as a real dispatch target.
