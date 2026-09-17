import { describe, expect, it } from "vitest"
import { GoalEngine, type GoalEntry, type GoalRuntime, type GoalState } from "../src/loop.js"

function harness() {
  const storage = new Map<string, GoalState>()
  const prompts: Parameters<GoalRuntime["prompt"]>[0][] = []
  const synthetic: string[] = []
  let ids = 0
  let promptFailures = 0
  const runtime: GoalRuntime = {
    async get(key) {
      return storage.get(key)
    },
    async set(key, value) {
      storage.set(key, structuredClone(value))
    },
    async scan(prefix) {
      return [...storage.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]): GoalEntry => ({ key, value }))
    },
    async prompt(input) {
      if (promptFailures > 0) {
        promptFailures -= 1
        throw new Error("offline")
      }
      prompts.push(input)
    },
    async synthetic(input) {
      synthetic.push(input.text)
    },
    now: () => "2026-09-17T00:00:00.000Z",
    id: () => `continuation-${++ids}`,
    async sleep() {},
  }
  return {
    engine: new GoalEngine(runtime),
    storage,
    prompts,
    synthetic,
    failPrompts(count: number) {
      promptFailures = count
    },
  }
}

describe("GoalEngine", () => {
  it("starts a durable goal and schedules an idempotent continuation", async () => {
    const test = harness()
    await test.engine.command("session", "ship the complete release")

    expect(test.storage.get("sessions/session")).toMatchObject({
      goal: "ship the complete release",
      status: "active",
      turn: 1,
      pendingID: "continuation-1",
    })
    expect(test.prompts).toHaveLength(1)
    expect(test.prompts[0]).toMatchObject({ sessionID: "session", id: "continuation-1", delivery: "queue" })
  })

  it("continues once for each unique idle event", async () => {
    const test = harness()
    await test.engine.command("session", "finish")
    await test.engine.progress("session", "first gate passed")
    await test.engine.idle("session", "idle-1")
    await test.engine.idle("session", "idle-1")

    expect(test.prompts.map((prompt) => prompt.id)).toEqual(["continuation-1", "continuation-2"])
    expect(test.storage.get("sessions/session")).toMatchObject({ turn: 2, progress: "first gate passed" })
  })

  it("pauses, resumes, reports status, and stops", async () => {
    const test = harness()
    await test.engine.command("session", "start finish")
    await test.engine.command("session", "pause")
    await test.engine.idle("session", "idle-paused")
    expect(test.prompts).toHaveLength(1)

    await test.engine.command("session", "status")
    expect(test.synthetic.at(-1)).toContain("status: paused")
    await test.engine.command("session", "resume")
    expect(test.prompts).toHaveLength(2)
    await test.engine.command("session", "stop")
    expect(test.storage.get("sessions/session")?.status).toBe("stopped")
  })

  it("only terminal tools stop active continuation", async () => {
    const completed = harness()
    await completed.engine.command("complete", "goal")
    await completed.engine.complete("complete", "all tests passed")
    await completed.engine.idle("complete", "idle-complete")
    expect(completed.prompts).toHaveLength(1)
    expect(completed.storage.get("sessions/complete")).toMatchObject({ status: "completed", evidence: "all tests passed" })

    const blocked = harness()
    await blocked.engine.command("blocked", "goal")
    await blocked.engine.blocked("blocked", "missing credential")
    await blocked.engine.idle("blocked", "idle-blocked")
    expect(blocked.prompts).toHaveLength(1)
    expect(blocked.storage.get("sessions/blocked")).toMatchObject({ status: "blocked", blocker: "missing credential" })
  })

  it("injects the goal into model and compaction context", async () => {
    const test = harness()
    await test.engine.command("session", "preserve me")
    const system = await test.engine.system("session")
    expect(system).toContain("OWENLOOP DURABLE GOAL")
    expect(system).toContain("goal: preserve me")
    expect(system).toContain("status: active")
  })

  it("recovers the same pending message without creating a duplicate ID", async () => {
    const test = harness()
    await test.engine.command("session", "recover me")
    test.prompts.length = 0
    await test.engine.recover()
    expect(test.prompts.map((prompt) => prompt.id)).toEqual(["continuation-1"])
  })

  it("marks a durable blocker after fenced admission retries fail", async () => {
    const test = harness()
    test.failPrompts(3)
    await test.engine.command("session", "goal")
    expect(test.storage.get("sessions/session")).toMatchObject({
      status: "blocked",
      pendingID: null,
      blocker: "could not enqueue continuation after 3 attempts: offline",
    })
  })
})
