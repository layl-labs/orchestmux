---
description: Check orchestmux prerequisites and offer to install what is missing
allowed-tools: Bash
---

# orchestmux doctor

Verify this machine can run orchestmux, report what is missing, and offer to
install the CLI if it is absent.

Installing the plugin does **not** install the CLI — plugins ship skills and
commands, not binaries — so a fresh machine will usually be missing it.

## 1. Check

```bash
echo "── tmux ──";       command -v tmux >/dev/null && tmux -V || echo "MISSING: tmux"
echo "── node ──";       node --version 2>/dev/null || echo "MISSING: node"
echo "── orchestmux ──"; command -v orchestmux >/dev/null && orchestmux version || echo "MISSING: orchestmux"
echo "── agents ──"
for b in claude codex kimi opencode gemini; do
  p=$(command -v $b 2>/dev/null) && echo "  ok   $b -> $p" || echo "  none $b"
done
echo "── state ──";      orchestmux ps 2>/dev/null | head -20 || true
```

## 2. Offer to install the CLI

If `orchestmux` is missing, ask the user whether to install it, then run:

```bash
npm i -g orchestmux
```

Ask first — this is a global install. If it fails with `EACCES`, npm's global
prefix is a system directory; report that and offer `sudo npm i -g orchestmux`
as a second step rather than running sudo unprompted. Do not silently rewrite
the user's npm prefix.

Confirm afterwards:

```bash
command -v orchestmux && orchestmux version
```

## 3. Report

Say plainly what is ready and what still blocks the user.

- **tmux missing** — nothing works without it; workers are tmux panes and there
  is no fallback. WSL/Ubuntu: `sudo apt install tmux`. Native Windows is not
  supported.
- **node older than 22.5** — the CLI uses the built-in `node:sqlite` module and
  will not start on older runtimes. Do not attempt to upgrade node for them.
- **no agents found** — orchestmux provides no model access of its own; it
  drives the agent CLIs already installed and authenticated on this machine.
  At least one of claude / codex / kimi / opencode / gemini is required, and
  each runs on that person's own subscription.

Finish by listing which agents are usable, since that is what determines what
can actually be dispatched.
