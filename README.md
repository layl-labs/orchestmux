# orchestmux

[English](README.md) · [한국어](README.ko.md)

[![CI](https://github.com/layl-labs/orchestmux/actions/workflows/ci.yml/badge.svg)](https://github.com/layl-labs/orchestmux/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/orchestmux.svg)](https://www.npmjs.com/package/orchestmux)

**A lightweight, tmux-based multi-agent tool.** Tell Claude Code what you want
in plain language, and it runs Codex, Kimi, Gemini, OpenCode — every coding
CLI you're already subscribed to — in parallel, as real terminal panes you can
watch and take over.

![orchestmux driven from Claude Code](https://raw.githubusercontent.com/layl-labs/orchestmux/main/docs/demo-claude.gif)

*A real session: one plain-language request — Claude spawns codex and opencode
as tmux panes, blocks until both report back, chases down a disagreement, and
hands back one answer, ready for the next instruction.*

## What it does

You type one line into Claude Code:

```
/orchestmux:run have codex and kimi review the retry logic in packages/api
```

That's the whole interface. From there, Claude:

1. **Picks the shape of the work.** A judgement-heavy task goes to several
   agents at once so the answers can be compared (*ensemble*). A job that
   splits into independent pieces goes one piece per agent (*split*). You
   don't choose — it does.
2. **Opens a tmux pane per agent** in the terminal you already have open.
3. **Waits until each worker actually reports back** — workers call in when
   finished, so "done" is a recorded fact, not a guess from terminal output.
4. **Reads the answers and writes you one** — agreements first, disagreements
   checked against the code, lone findings verified before they're repeated.

Plain language works too — "run codex and kimi in parallel on X" does the same
thing. The slash command is just for discoverability.

## Why this and not another orchestration tool

- **No new interface to learn.** Most multi-agent tools hand you a board, a
  config format, or a DSL. Here the coordinator is Claude Code itself: you say
  what you want, in your own words, in the terminal you already use.
- **Your existing subscriptions, in parallel.** Each worker is a CLI you
  already installed and logged into. orchestmux provides no model access of
  its own and adds zero API cost — it just lets your Claude, ChatGPT/Codex,
  Kimi, and Gemini plans work at the same time.
- **Nothing is hidden.** Workers are ordinary tmux panes. Watch them think,
  scroll back through their reasoning, or type into one and take it over
  mid-task.
- **Failure is loud, not silent.** If a worker dies mid-task, the coordinator
  is told immediately instead of waiting out a timeout. Reports survive after
  panes close. Nothing gets stuck pretending to be "in progress".
- **Nothing to run.** No daemon, no server, no GUI. State is one SQLite file
  using Node's built-in module — no native builds.

## Install

If you use Claude Code, take the plugin — it installs the CLI for you:

```
/plugin marketplace add layl-labs/orchestmux
/plugin install orchestmux@orchestmux
/reload-plugins
/orchestmux:doctor
```

`/reload-plugins` activates the commands the install just added. Then
`/orchestmux:doctor` checks tmux, Node, and whichever agent CLIs you have, and
offers to install the `orchestmux` CLI itself.

Standalone CLI:

```bash
npm install -g orchestmux
```

**Requirements:** tmux (macOS, Linux, or WSL) · Node >= 22.13 · at least one
agent CLI installed and logged in.

## The two shapes of parallel work

**Ensemble** — the same task to several agents at once, answers compared.
Worth paying twice when models genuinely disagree: designs, reviews, "what's
wrong with this code". The synthesis leads with what the agents agree on,
checks their disagreements against the code, and verifies anything only one
of them found.

**Split** — independent pieces to different agents. Right when the job
decomposes cleanly: "write the parser tests and update the docs" is two
unrelated jobs, so nobody does the same work twice.

Claude picks between them from what you asked; you can always override by
saying so.

## Good to know

- **`--yolo` grants unattended write access.** It adds each agent's
  "skip approval prompts" flag. Without it agents stop to ask permission and
  stall the swarm — but turning it on is deliberately your call, not a
  default. For codex it also adds the working directory to the trusted list
  in `~/.codex/config.toml` (codex blocks on a trust prompt no flag can
  answer); this is announced when it happens.
- **Panes stay open after a worker reports** — the scrollback is the only
  record of *how* an answer was reached, and answers can be wrong. Clean up
  when you've read the results (`sweep`), not before.
- **A dead worker never strands you.** Its task is marked failed and the
  waiting coordinator is notified right away. Interrupting, killing, or
  tearing down a worker settles its in-flight task the same way.
- **Swarms are isolated per session.** Two projects orchestrating at the same
  time (`--session`) never see each other's tasks or steal each other's
  reports.

## Under the hood — the CLI

Everything above is Claude driving a small CLI. You can script it yourself:

![the orchestmux CLI driven by hand](https://raw.githubusercontent.com/layl-labs/orchestmux/main/docs/demo.gif)

*The CLI driven by hand — normally Claude types these for you. One task
dispatched to codex and opencode, both reports collected.*

This is the entire loop:

```bash
orchestmux up                                      # tmux session
orchestmux spawn --name w1 --agent codex --yolo    # worker pane
TASK=$(orchestmux task add "audit packages/api for unhandled rejections")
orchestmux dispatch --task $TASK --to w1           # task + reporting protocol
orchestmux wait                                    # blocks until w1 reports
```

`dispatch` relaunches the worker's pane with the task plus a short protocol
telling it to run `orchestmux done --task <id> --body "<summary>"` when
finished (or `ask` to pose a blocking question back). That callback is the
whole mechanism.

<details>
<summary><b>Full command reference</b></summary>

| Command | Description |
| --- | --- |
| `up` | Create the tmux session |
| `spawn --name <w> --agent <a> [--yolo] [--here] [-- <args…>]` | Add a worker pane (`--here` splits your current window; args after `--` go to the agent) |
| `task add "<spec>"` | Create a task, prints its id |
| `task list [--json]` | List tasks |
| `task update --id <id> --status <s>` | Recover a task stuck in `dispatched` |
| `task rm --id <id>` / `task clear` | Delete one task / all finished ones |
| `dispatch --task <id> --to <w> [--force]` | Inject task + protocol into a worker |
| `wait [--types done,ask] [--timeout 900]` | Block until a worker reports (exit 2 on timeout) |
| `wait --count <n>` / `wait --all` | Hold for n reports / drain what's queued |
| `report [--task <id>] [--json]` | Re-read reports `wait` already collected |
| `reply --id <msg> --body "<answer>"` | Answer a worker's `ask` |
| `ps [--json]` | Workers, tasks, unread count |
| `attach` / `watch` | Attach to the session / open a terminal attached to it |
| `sweep [--dry-run]` | Remove workers with nothing left to do |
| `kill --name <w>` / `down` | Remove one worker / tear down the session |

Called by workers inside a spawned pane:

| Command | Description |
| --- | --- |
| `done --task <id> --body "<summary>" [--failed]` | Report completion |
| `ask --task <id> --question "<q>"` | Blocking question to the coordinator |

Rules that matter:

- **One worker, one task at a time.** Dispatching to a busy worker interrupts
  it and loses its report, so `dispatch` refuses (`--force` interrupts anyway
  and marks the abandoned task failed). Parallelism comes from more workers.
- **A task that already has a report refuses a second `done`** — agents retry
  commands whose output they missed, and a duplicate must not count as a
  second worker's answer.
- **`wait` exits 2 on timeout — a checkpoint, not a failure.** Real tasks run
  15–60 minutes; loop on it: `until orchestmux wait --timeout 600; do :; done`
- **An `escalation` from `wait` means a worker died mid-task**; the task is
  already marked failed, and the pane scrollback shows why.

Agents: `claude`, `codex`, `kimi`, `opencode`, `gemini`, `qwen`, `agy`
(Antigravity CLI), `cursor` (Cursor CLI), `aider`, `amp`, `copilot` (GitHub
Copilot CLI), `crush`, `droid` (Factory), and `shell` (a plain shell for testing
the protocol by hand — don't `dispatch` to it). Only the ones actually installed
on your `PATH` can spawn; the rest fail fast with a "not found" message.

State lives in `~/.orchestmux/state.db` (`ORCHESTMUX_HOME` to move it), scoped
per session (`--session` / `ORCHESTMUX_SESSION`, default `orchestmux`).

</details>

## Scope

This is the core loop — spawn, dispatch, wait, report, ask. Left out on
purpose: judging or merging what workers report (your coordinator agent is
better at that than any rule this could ship), worktree isolation, dependency
graphs, retry/cost policy. The tool records facts and gets them to the
coordinator intact; the thinking stays with the coordinator.

## License

MIT
