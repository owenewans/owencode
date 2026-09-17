import { describe, expect, it } from "vitest"
import { createJobs } from "../src/browser/jobs.js"

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe("background browser jobs", () => {
  it("returns an id immediately and the result once the work finishes", async () => {
    let release: (value: string) => void = () => {}
    const jobs = createJobs(async () => await new Promise<string>((resolve) => { release = resolve }), 1000)
    const started = jobs.start("code", { label: "quiz" })
    expect(started).toMatchObject({ id: "job-1", status: "running", label: "quiz" })
    expect(jobs.pending()).toBe(1)

    // A wait that expires leaves the job running instead of failing it.
    expect(await jobs.wait("job-1", 1)).toMatchObject({ status: "running" })
    release("done")
    expect(await jobs.wait("job-1", 100)).toMatchObject({ status: "done", result: "done" })
    expect(jobs.pending()).toBe(0)
  })

  it("resolves the wait as soon as the job settles", async () => {
    const jobs = createJobs(async () => "fast", 1000)
    jobs.start("code")
    const view = await jobs.wait("job-1", 5000)
    expect(view.status).toBe("done")
    expect(view.runningMs).toBeLessThan(5000)
  })

  it("records failures with their message", async () => {
    const jobs = createJobs(async () => { throw new Error("selector missing") }, 1000)
    jobs.start("code")
    expect(await jobs.wait("job-1", 100)).toMatchObject({ status: "failed", error: "selector missing" })
  })

  it("aborts the snippet when the ceiling is reached", async () => {
    let aborted = false
    const jobs = createJobs(async (_code, signal) => {
      signal.addEventListener("abort", () => { aborted = true })
      await new Promise(() => {})
    }, 10)
    jobs.start("code")
    await tick()
    const view = await jobs.wait("job-1", 100)
    expect(view.status).toBe("timeout")
    expect(view.error).toContain("10ms")
    expect(aborted).toBe(true)
  })

  it("honours a per-job timeout override and cancellation", async () => {
    const jobs = createJobs(async () => await new Promise(() => {}), 60_000)
    expect(jobs.start("code", { timeout: 5 }).timeout).toBe(5)
    const cancelled = jobs.cancel("job-1")
    expect(cancelled).toMatchObject({ status: "failed", error: "cancelled" })
    expect(jobs.list()).toHaveLength(1)
  })

  it("rejects unknown ids", async () => {
    const jobs = createJobs(async () => undefined, 1000)
    await expect(jobs.wait("job-9", 1)).rejects.toThrow("unknown job")
  })
})
