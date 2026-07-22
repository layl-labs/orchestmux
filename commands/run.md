---
description: Spawn workers, dispatch the requested work, and wait for their reports
allowed-tools: Bash, Read, Grep, Glob
argument-hint: <what to do, and optionally which agents>
---

# orchestmux run

Run `$ARGUMENTS` across one or more agent workers and report back.

## 1. Understand the request

From `$ARGUMENTS`, decide **which shape** the work has:

- **Ensemble** — the same task, given to several agents at once, so their
  answers can be compared and the best parts combined. Use this when the user
  names multiple agents for one job ("codex랑 kimi로 X"), asks for the best
  result, or when the task is judgement-heavy (a design, a plan, an improvement
  proposal) where different models genuinely differ.
- **Split** — different, independent pieces to different workers. Use this when
  the job decomposes cleanly and the pieces do not overlap.

Then decide:

- **Which agents** — use the ones the user named. If unnamed, list what is
  available (`orchestmux ps`, or the agents in the skill) and pick: `codex` for
  analysis, `claude` for large refactors. Say which you chose and why.
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

**One worker runs one task at a time.** Dispatching again to a busy worker
interrupts it and its first report is lost, so `dispatch` refuses. Parallelism
comes from more workers, never from more dispatches.

Ensemble — one spec, one task per agent, so each report is attributable:

```bash
SPEC="<the shared spec>"
for a in codex kimi; do
  orchestmux spawn --name w_$a --agent $a --yolo
  orchestmux dispatch --task "$(orchestmux task add "$SPEC")" --to w_$a
done
```

Split — a different spec per worker:

```bash
orchestmux dispatch --task "$(orchestmux task add "<spec A>")" --to w1
orchestmux dispatch --task "$(orchestmux task add "<spec B>")" --to w2
```

## 4. Wait

```bash
orchestmux wait --types done,ask,escalation --timeout 900
```

- One `wait` returns one message — loop once per outstanding worker.
- For an **ensemble**, hold for the whole set instead:
  `orchestmux wait --count <n> --timeout 1800`. Reacting to whichever agent
  finished first is exactly what you are trying to avoid when comparing. If the
  timeout hits first it still prints the reports that did arrive, and exits 2.
- Exit code 2 is a **timeout, not a failure**. Coding tasks routinely run
  15-60 minutes. Keep waiting; check liveness with `orchestmux ps` and
  `tmux capture-pane -p -t <pane>` rather than killing the worker.
- An `ask` blocks that worker until you answer:
  `orchestmux reply --id <msg> --body "<decision>"`, then keep waiting.
- An `escalation` means the worker's pane died mid-task; the task is already
  marked `failed`. Check `tmux capture-pane -p -t <pane>` for the cause, then
  re-dispatch to a fresh worker or report the failure — do not wait further
  for that task.

## 5. Report

Read each `done` body and verify anything load-bearing yourself — the worker
may be wrong. `wait` consumes each report once, so use `orchestmux report`
(optionally `--task <id>`) to read them again while you write the synthesis, or
after the panes are gone. Then summarise in the user's language, saying which worker did
what. If a worker failed or went silent, say so plainly instead of quietly
redoing its work.

For an **ensemble**, do not just concatenate the answers. Compare them:

- Where do they agree? Agreement across independent models is the strongest
  signal you have — lead with it.
- Where do they disagree? Say so explicitly, check the disagreement against the
  code yourself, and state which one holds up and why.
- What did only one of them find? Verify it before including it; a unique
  finding is either the most valuable result or a hallucination.

Deliver one synthesised answer with the best parts of each, and attribute the
non-obvious findings to the agent that produced them.

Leave workers running unless the user asks to clean up; mention
`/orchestmux:down` as the option.
