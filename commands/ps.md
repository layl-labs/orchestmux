---
description: Show orchestmux workers, tasks, and unread reports
allowed-tools: Bash
---

# orchestmux status

Show the current swarm at a glance.

```bash
orchestmux ps
```

Summarise for the user: which workers are alive and what agent each runs, which
tasks are still `dispatched` (i.e. someone is working), and whether any reports
are waiting to be collected with `orchestmux wait`.

A worker shown as `○` has a dead pane — its agent exited. Offer to clean it up
with `orchestmux kill --name <worker>` rather than doing it unprompted.
