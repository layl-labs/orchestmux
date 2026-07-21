---
description: Tear down orchestmux workers and the tmux session
allowed-tools: Bash
---

# orchestmux down

Stop every worker and remove the session.

Before running, check whether anything is still in flight:

```bash
orchestmux ps
```

If any task is still `dispatched`, tell the user which one and confirm before
tearing down — killing a pane loses that agent's in-progress work and its
report will never arrive.

```bash
orchestmux down
```

Workers spawned with `--here` live in the user's own tmux session; `down`
removes those panes but deliberately leaves the session running.
