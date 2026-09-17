---
id: REQ-OWENCODE-DURABLE-GOALS
type: req
title: Durable autonomous goals
status: active
tags:
  - owenloop
  - opencode-v2
links:
  - type: specified_by
    target: SCEN-OWENCODE-DURABLE-GOALS
  - type: verified_by
    target: TEST-OWENCODE-DURABLE-GOALS
---

Owenloop stores one goal per session, restores active work after plugin
restart, reinjects the goal during ordinary and compaction requests, and
continues after idle until explicit completion, a real blocker, or operator
stop.
