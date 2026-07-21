# orchestmux

Multi-agent orchestration for coding CLIs, in tmux.

Spawn Claude Code, Codex, Kimi, OpenCode, or Gemini as workers in tmux panes,
dispatch tasks to them, and block until they report back — all from one
terminal, with no GUI and no daemon.

```
┌─ orchestmux ─────────────────────────────────────────┐
│ coordinator (you, or an agent)                       │
├──────────────────┬───────────────────┬───────────────┤
│ w1  codex        │ w2  kimi          │ w3  opencode  │
│ [TASK t_a1b2]    │ [TASK t_c3d4]     │ idle          │
│ working…         │ asking a question │               │
└──────────────────┴───────────────────┴───────────────┘
```

## Why

Running several coding agents in parallel is easy; knowing when they are *done*
is not. `orchestmux` adds the missing piece: every dispatched task carries a
reporting protocol, so the coordinator can block on real completion instead of
polling terminal output and guessing.

- **Real panes.** Workers are tmux panes. Attach, scroll back, type into them,
  take over an agent mid-task. Nothing is hidden behind a viewer.
- **Any CLI agent.** If it runs in a terminal, it can be a worker.
- **No runtime dependencies.** State lives in SQLite via Node's built-in
  `node:sqlite`. No native builds, no background service.

## Requirements

- **tmux** — workers are tmux panes; there is no fallback. macOS, Linux, or WSL.
  Native Windows is not supported.
- **Node >= 22.5** — the CLI uses the built-in `node:sqlite` module.
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

If you are **already inside tmux**, attach cannot nest into a second session.
Use `--here` instead: workers become split panes in your current window, so
they are visible the moment they spawn and you never switch sessions.

```bash
orchestmux spawn --name w1 --agent codex --yolo --here
orchestmux spawn --name w2 --agent kimi  --yolo --here
```

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

## How dispatch works

`dispatch` pastes the task spec into the worker's pane followed by a short
protocol block:

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
| `dispatch --task <id> --to <w>` | Inject task + protocol into a worker |
| `wait [--types done,ask] [--timeout 900]` | Block until a worker reports |
| `reply --id <msg> --body "<answer>"` | Answer a worker's `ask` |
| `send --to <w> --body "<text>"` | Message a worker |
| `ps [--json]` | Workers, tasks, unread count |
| `attach` | Attach to the tmux session |
| `kill --name <w>` / `down` | Remove one worker / tear down the session |

Called by workers inside a spawned pane:

| Command | Description |
| --- | --- |
| `done --task <id> --body "<summary>" [--failed]` | Report completion |
| `ask --task <id> --question "<q>"` | Blocking question to the coordinator |

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
explicitly. Extra arguments after the flags are passed to the agent:

```bash
orchestmux spawn --name w1 --agent codex --yolo -- --model gpt-5.5
```

`shell` spawns a plain shell. It is useful for exercising the protocol by hand,
but note that a bare shell **executes** the pasted preamble line by line — do
not `dispatch` to it and expect agent-like behaviour. Call `done` yourself
instead.

## Use it from Claude Code

`orchestmux` ships a skill so an agent can act as the coordinator for you, and
a plugin that installs it.

```bash
npm i -g orchestmux            # the CLI (you and the workers both call it)
```
```
/plugin marketplace add younghotkim/orchestmux
/plugin install orchestmux@orchestmux
```

The plugin adds the skill plus `/orchestmux:doctor` (check prerequisites),
`/orchestmux:ps`, and `/orchestmux:down`. Run `/orchestmux:doctor` first — it
reports exactly what is missing on a new machine.

Prefer no plugin? Link the skill by hand instead:

```bash
ln -s "$(npm root -g)/orchestmux/skills/orchestmux" ~/.claude/skills/orchestmux
```

Then just say what you want:

> orchestmux로 codex랑 kimi 병렬로 돌려서 packages/api 감사해줘

The agent creates the tasks, dispatches them, waits on real completions, answers
any blocking `ask`, and reports back. You can `orchestmux attach` at any time to
watch the panes or take one over.

## State

Everything lives in `~/.orchestmux/state.db` (override with `ORCHESTMUX_HOME`):
workers, tasks, and the message log. Sessions default to the tmux session
`orchestmux` (override with `--session` or `ORCHESTMUX_SESSION`), so several
independent swarms can run side by side.

## Scope

This is the core loop — spawn, dispatch, wait, report, ask. Task dependency
graphs, decision gates, and coordinator auto-loops are deliberately left out
until the core proves itself in daily use.

## License

MIT
