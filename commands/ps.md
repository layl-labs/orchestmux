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

The unread count only covers reports nobody has collected yet. If the user is
asking what a worker actually said, reach for `orchestmux report` — already
collected reports are still there, they just no longer show as unread.

A worker shown as `○` has a dead pane — its agent exited. Offer to clean it up
with `orchestmux kill --name <worker>` rather than doing it unprompted.
