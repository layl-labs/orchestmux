---
description: Spawn workers, dispatch the requested work, and wait for their reports
allowed-tools: Bash, Read, Grep, Glob
argument-hint: <what to do, and optionally which agents>
---

# orchestmux run

Run `$ARGUMENTS` across one or more agent workers and report back.

## 1. Understand the request

From `$ARGUMENTS`, decide:

- **What work** — one task, or several independent pieces worth parallelising.
- **Which agents** — use the ones the user named. If unnamed, pick `codex` for
  analysis and `claude` for large refactors, and say which you chose and why.
- **Where** — the current directory unless the user names a path.

If the request is too vague to write a self-contained spec from (no target, no
success criterion), ask one clarifying question before spawning anything.
Spawning a worker on a guess wastes that agent's quota.

## 2. Check and spawn

```bash
orchestmux ps
```

Reuse an idle worker running the right agent instead of spawning a duplicate.
Otherwise:

```bash
orchestmux spawn --name <w> --agent <agent> --yolo [--here]
```

- `--yolo` is required in practice: without it the agent stops at an approval
  prompt and never reports. Say once that this lets it act unattended.
- Use `--here` when you are running inside tmux, so panes split the user's
  current window and they can watch. Otherwise tell them `orchestmux attach`.

## 3. Dispatch

Write the spec as if the worker knows nothing — it receives that text and
nothing else. Absolute paths, explicit constraints (`read-only`, `do not
commit`), and a clear definition of done.

```bash
TASK=$(orchestmux task add "<spec>")
orchestmux dispatch --task $TASK --to <w>
```

Repeat per worker for parallel work.

## 4. Wait

```bash
orchestmux wait --types done,ask,escalation --timeout 900
```

- One `wait` returns one message — loop once per outstanding worker.
- Exit code 2 is a **timeout, not a failure**. Coding tasks routinely run
  15-60 minutes. Keep waiting; check liveness with `orchestmux ps` and
  `tmux capture-pane -p -t <pane>` rather than killing the worker.
- An `ask` blocks that worker until you answer:
  `orchestmux reply --id <msg> --body "<decision>"`, then keep waiting.

## 5. Report

Read each `done` body, verify anything load-bearing yourself — the worker may
be wrong — then summarise in the user's language, saying which worker did what.
If a worker failed or went silent, say so plainly instead of quietly redoing
its work.

Leave workers running unless the user asks to clean up; mention
`/orchestmux:down` as the option.
