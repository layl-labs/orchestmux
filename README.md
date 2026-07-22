# orchestmux

[English](README.md) · [한국어](README.ko.md)

[![CI](https://github.com/younghotkim/orchestmux/actions/workflows/ci.yml/badge.svg)](https://github.com/younghotkim/orchestmux/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/orchestmux.svg)](https://www.npmjs.com/package/orchestmux)

Running coding agents in parallel is easy. Knowing when they are *done* is not.

`orchestmux` dispatches tasks to Claude Code, Codex, Kimi, OpenCode, or Gemini
workers and blocks until they actually report back — no polling terminal output,
no guessing. Workers are real tmux panes, so you can attach mid-task and take
one over. One terminal, no GUI, no daemon.

![orchestmux demo](https://raw.githubusercontent.com/younghotkim/orchestmux/main/docs/demo.gif)

*Dispatching one task to codex and opencode, then collecting both reports.*

## Why

Polling is the usual answer: watch the pane, wait for the prompt to come back,
call it done. It misreads an agent that paused for input, and it burns the
coordinator's own context re-reading output that has not changed.

orchestmux inverts that. Every dispatched task carries a reporting protocol, so
completion is a recorded fact: `orchestmux wait` returns because the worker said
it was done, not because a heuristic decided it looked done. The same channel
runs backwards — a blocked worker can `ask`, and the coordinator can `reply`
without restarting the task.

- **Real panes.** Workers are tmux panes. Attach, scroll back, type into them,
  take over an agent mid-task. Nothing is hidden behind a viewer.
- **Any CLI agent.** If it runs in a terminal, it can be a worker.
- **No runtime dependencies.** State lives in SQLite via Node's built-in
  `node:sqlite`. No native builds, no background service.

## Requirements

- **tmux** — workers are tmux panes; there is no fallback. macOS, Linux, or WSL.
  Native Windows is not supported.
- **Node >= 22.13** — the CLI uses the built-in `node:sqlite` module, which is
  only available unflagged from 22.13 (or 23.4) onwards.
- **At least one agent CLI**, installed and logged in. orchestmux provides no
  model access of its own: every worker runs on that machine's own
  subscriptions, so each person uses their own Claude/ChatGPT/Kimi plan and
  orchestmux itself costs nothing.

## Install

```bash
npm install -g orchestmux
```

From source:

```bash
git clone https://github.com/<you>/orchestmux && cd orchestmux
npm install && npm run build && npm link
```

## Quick start

```bash
orchestmux up                                        # create the tmux session
orchestmux spawn --name w1 --agent codex --yolo      # add a worker pane
orchestmux attach                                    # (optional) watch it live

TASK=$(orchestmux task add "Audit packages/api for unhandled promise rejections")
orchestmux dispatch --task $TASK --to w1

orchestmux wait --timeout 900                        # blocks until w1 reports
```

Parallel workers, then collect results one completion at a time:

```bash
orchestmux spawn --name w2 --agent kimi --yolo
orchestmux dispatch --task $(orchestmux task add "Write tests for src/parser") --to w2

for i in 1 2; do orchestmux wait --timeout 1800; done
```

## Watching workers

By default workers live in a dedicated `orchestmux` tmux session, and you watch
them with `orchestmux attach`.

If the caller is **already inside tmux**, workers split its current window
automatically, so they are visible the moment they spawn. orchestmux finds that
window through the process tree rather than `$TMUX`, which agent harnesses
routinely strip — pass `--no-here` if you want a dedicated session anyway.

```bash
orchestmux spawn --name w1 --agent codex --yolo
orchestmux spawn --name w2 --agent kimi  --yolo
```

Otherwise workers go to the `orchestmux` session, which nobody is attached to
by default. `orchestmux watch` fixes that: it opens a terminal already attached
(Windows Terminal under WSL, Terminal.app on macOS).

```
┌─ your window ───────────────────────────────────┐
│ $ orchestmux wait          │ w1  codex          │
│ (coordinator, your shell)  │ working…           │
│                            ├────────────────────┤
│                            │ w2  kimi           │
└────────────────────────────┴────────────────────┘
```

Panes are real: scroll back, type into them, take an agent over mid-task.
`orchestmux down` removes worker panes but never kills a session you are
sitting in.

Panes deliberately stay open after a worker reports. The scrollback is the only
record of *how* it reached its conclusion, and reports can be wrong — closing
the pane on `done` would destroy the evidence you need to check one. Clear the
finished ones when you have read the results:

```bash
orchestmux sweep --dry-run   # what would go
orchestmux sweep             # workers still working are kept
```

A worker whose pane died before reporting also has its task marked `failed`,
so nothing sits in `dispatched` pretending to still be in flight.

## How dispatch works

`dispatch` relaunches the worker's pane with the agent, handing it the task
spec and a short protocol block as a launch argument:

```
[ORCHESTMUX TASK t_a1b2c3d4]

<your task spec>

--- reporting protocol (required) ---
A coordinator is blocked waiting on you. When the work is finished, run exactly:
  orchestmux done --task t_a1b2c3d4 --body "<3-5 sentence summary>"

If you are blocked and need a decision before you can continue, run:
  orchestmux ask --task t_a1b2c3d4 --question "<your question>"
```

The worker's pane is spawned with `ORCHESTMUX_WORKER` set, so `done` and `ask`
know who is calling without any extra flags. That callback is the whole
mechanism — completion is a recorded fact, not an inference from scrollback.

The prompt never gets typed into a live composer. Doing that has to win three
races — the agent must be mounted, the bracketed paste must finish before the
submit key lands, and the pane must not be in tmux copy-mode — and losing any
one of them strands the prompt unsent with no error. Launch arguments have none
of those failure modes, so each dispatch relaunches the agent with a clean
context.

`ask` blocks the worker until the coordinator answers:

```bash
# coordinator
orchestmux wait                       # → [ask] w1 … id=m_9f8e7d6c
orchestmux reply --id m_9f8e7d6c --body "Use the v2 endpoint."
```

## Commands

| Command | Description |
| --- | --- |
| `up` | Create the tmux session |
| `spawn --name <w> --agent <a> [--yolo]` | Add a worker pane running an agent |
| `task add "<spec>"` | Create a task, prints its id |
| `task list [--json]` | List tasks |
| `task update --id <id> --status <s>` | Recover a task stuck in `dispatched` |
| `task rm --id <id>` | Delete a task |
| `dispatch --task <id> --to <w>` | Inject task + protocol into a worker |
| `wait [--types done,ask] [--timeout 900]` | Block until a worker reports |
| `wait --count <n>` / `wait --all` | Collect n reports, or everything queued |
| `report [--task <id>] [--json]` | Re-read reports `wait` already collected |
| `reply --id <msg> --body "<answer>"` | Answer a worker's `ask` |
| `ps [--json]` | Workers, tasks, unread count |
| `attach` | Attach to the tmux session |
| `watch` | Open a terminal already attached to the session |
| `sweep [--dry-run]` | Remove workers with nothing left to do |
| `kill --name <w>` / `down` | Remove one worker / tear down the session |

Called by workers inside a spawned pane:

| Command | Description |
| --- | --- |
| `done --task <id> --body "<summary>" [--failed]` | Report completion |
| `ask --task <id> --question "<q>"` | Blocking question to the coordinator |

One worker runs one task at a time: dispatching again to a busy worker
interrupts it and loses its first report, so `dispatch` refuses. Parallelism
comes from more workers, never from more dispatches.

`wait` exits `2` on timeout — a checkpoint, not a failure. Long tasks routinely
outlive one window, so loop on it rather than treating it as an error:

```bash
until orchestmux wait --timeout 600; do echo "still working…"; done
```

## Agents

`claude`, `codex`, `kimi`, `opencode`, `gemini`, and `shell`.

`--yolo` adds each agent's "run without approval prompts" flag
(`--dangerously-skip-permissions` for Claude Code,
`--dangerously-bypass-approvals-and-sandbox` for Codex, `--yolo` for Gemini).
It is **off by default** — an agent that stops for approval will stall the
coordinator, but granting unattended write access is your call to make
explicitly.

> **`--yolo` with codex also edits your codex config.** Codex blocks on a
> per-directory trust prompt that no flag can answer, so spawning a codex
> worker with `--yolo` adds the working directory to the trusted list in
> `~/.codex/config.toml`. Without it the worker would sit on that prompt and
> never read its task. It is announced when it happens, and nothing else in
> orchestmux writes outside its own state directory.

Extra arguments after the flags are passed to the agent:

```bash
orchestmux spawn --name w1 --agent codex --yolo -- --model gpt-5.5
```

`shell` spawns a plain shell. It is useful for exercising the protocol by hand,
but note that a bare shell **executes** the pasted preamble line by line — do
not `dispatch` to it and expect agent-like behaviour. Call `done` yourself
instead.

## Two shapes of parallel work

**Ensemble** — give the same task to several agents at once and compare what
comes back. Worth the extra tokens when judgement actually differs between
models: design proposals, review, "what is wrong with this code".

```bash
SPEC="Propose improvements to packages/api, citing the code"
for a in codex kimi; do
  orchestmux spawn --name w_$a --agent $a --yolo
  orchestmux dispatch --task "$(orchestmux task add "$SPEC")" --to w_$a
done
orchestmux wait --count 2 --timeout 1800    # holds until both have answered
```

`wait` consumes each report once, so `orchestmux report` is how you read them
again while you write the synthesis up — or later, once the panes are gone.

Do not concatenate the reports. **Where the agents agree** is the strongest
signal and belongs first; **where they disagree**, go read the code and say
which one was right; **what only one of them found** goes in after you have
checked it. That synthesis is deliberately yours — see [Scope](#scope).

**Split** — hand each worker an independent piece. Right when the work
decomposes cleanly and the pieces do not touch each other.

## Use it from Claude Code

`orchestmux` ships as a Claude Code plugin: a skill that teaches an agent to
act as the coordinator, plus slash commands.

```bash
npm i -g orchestmux
```
```
/plugin marketplace add younghotkim/orchestmux
/plugin install orchestmux@orchestmux
```

Installing the plugin does **not** install the CLI — Claude Code plugins ship
skills and commands, not binaries. On a fresh machine run `/orchestmux:doctor`
first: it checks tmux, Node, and the agent CLIs, and offers to
`npm i -g orchestmux` for you, so onboarding never leaves the editor.

| Command | Purpose |
| --- | --- |
| `/orchestmux:doctor` | Check prerequisites; offer to install the CLI |
| `/orchestmux:run <what to do>` | Spawn workers, dispatch, wait, report |
| `/orchestmux:ps` | Workers, tasks, unread reports |
| `/orchestmux:down` | Tear down workers |

```
/orchestmux:run audit packages/api for unhandled promise rejections
/orchestmux:run split the parser tests across codex and kimi
```

The skill also fires on plain language — "run codex and kimi in parallel on
X" — so the commands are for discoverability, not a requirement.

Prefer no plugin? Link the skill by hand:

```bash
ln -s "$(npm root -g)/orchestmux/skills/orchestmux" ~/.claude/skills/orchestmux
```

## State

Everything lives in `~/.orchestmux/state.db` (override with `ORCHESTMUX_HOME`):
workers, tasks, and the message log. Sessions default to the tmux session
`orchestmux` (override with `--session` or `ORCHESTMUX_SESSION`), so several
independent swarms can run side by side.

## Scope

This is the core loop — spawn, dispatch, wait, report, ask. Left out on
purpose, not missing:

- **Judging or merging what workers report.** No consensus, no best-of-N, no
  auto-review of one agent's diff by another.
- **Worktree isolation and merge.** Workers share the directory you point them
  at; keeping their edits apart is your call.
- **Task dependency graphs, decision gates, coordinator auto-loops.**
- **Retry, cost, and timeout policy.**

The first one is the load-bearing decision. This tool's whole claim is that
completion is a *recorded fact* rather than something inferred from terminal
output — and "which of these two answers is better" is exactly the kind of
inference it refuses to make on your behalf. Your coordinator is usually an
agent that is far better at that judgement than any rule this could ship, so
orchestmux gets the reports to it intact and stops there.

The rest is held back until the core proves itself in daily use.

## License

MIT
