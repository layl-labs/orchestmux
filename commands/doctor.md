---
description: Check that orchestmux and its prerequisites are ready on this machine
allowed-tools: Bash
---

# orchestmux doctor

Verify this machine can run orchestmux, and report exactly what is missing.

## Tasks

Run the checks below, then summarise for the user in their language. Do not fix
anything without asking — just report.

```bash
echo "── tmux ──";      command -v tmux >/dev/null && tmux -V || echo "MISSING: tmux (sudo apt install tmux)"
echo "── node ──";      node --version 2>/dev/null || echo "MISSING: node"
echo "── orchestmux ──"; command -v orchestmux >/dev/null && orchestmux version || echo "MISSING: orchestmux (npm i -g orchestmux)"
echo "── agents ──"
for b in claude codex kimi opencode gemini; do
  p=$(command -v $b 2>/dev/null) && echo "  ok   $b -> $p" || echo "  none $b"
done
echo "── state ──";     orchestmux ps 2>/dev/null | head -20 || true
```

## Interpreting the result

- **tmux missing** — nothing works without it. orchestmux runs workers as tmux
  panes; there is no fallback. On WSL/Ubuntu: `sudo apt install tmux`.
- **node older than 22.5** — the CLI uses the built-in `node:sqlite` module and
  will not start on older runtimes.
- **orchestmux missing** — `npm i -g orchestmux`.
- **no agents found** — orchestmux provides no AI of its own; it drives the
  agent CLIs already installed and logged in on this machine. At least one of
  claude / codex / kimi / opencode / gemini must be present, authenticated with
  that person's own subscription.

Report which agents are usable, since that determines what can be dispatched.
