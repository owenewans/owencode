---
id: SCEN-OWENCODE-DURABLE-GOALS
type: scenario
title: Goal survives compaction and restart
status: active
tags:
  - owenloop
links:
  - type: verified_by
    target: TEST-OWENCODE-DURABLE-GOALS
---

Given an active goal, every unique idle event schedules one fenced continuation.
Compaction and restart preserve the goal and pending message identity. Progress
does not stop the loop; completion, blocking, pause, and stop do.
