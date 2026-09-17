---
id: TEST-OWENCODE-DURABLE-GOALS
type: test
title: Owenloop engine and V2 activation suite
status: passing
verification_scope: integration
verification_perspective: consumer
text_ref: test/loop.test.ts
tags:
  - owenloop
  - opencode-v2
links:
  - type: validates
    target: REQ-OWENCODE-DURABLE-GOALS
  - type: validates
    target: SCEN-OWENCODE-DURABLE-GOALS
---

The engine tests cover lifecycle, idle deduplication, retries, recovery, and
context injection. The plugin test covers V2 command, tool, hook, and event
registrations, `msg_` continuation IDs, and steer delivery. Host activation is
checked with OpenCode 2.0.5 through a real start, complete, and status cycle.
