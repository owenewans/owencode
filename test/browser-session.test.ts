import { describe, expect, it } from "vitest"
import { resolveSettings } from "../src/browser/config.js"
import { createSession } from "../src/browser/session.js"
import type { Identity } from "../src/browser/identity.js"

const identity: Identity = { schema: 1, key: "k", browserVersion: "1", config: {} }

function fakeContext() {
  const listeners: Array<() => void> = []
  return {
    closed: false,
    timeouts: [] as number[],
    once(event: string, listener: () => void) {
      if (event === "close") listeners.push(listener)
    },
    setDefaultTimeout(value: number) {
      this.timeouts.push(value)
    },
    setDefaultNavigationTimeout(value: number) {
      this.timeouts.push(value)
    },
    async close() {
      this.closed = true
      for (const listener of listeners) listener()
    },
    // Simulates the user closing the window or Firefox crashing.
    kill() {
      for (const listener of listeners) listener()
    },
  }
}

function session(overrides: Record<string, string> = {}) {
  const settings = resolveSettings({}, { OWENCODE_BROWSER_DISPLAY: "headed", ...overrides })
  const contexts: ReturnType<typeof fakeContext>[] = []
  const displays: Array<{ killed: boolean }> = []
  const instance = createSession(settings, identity, {
    verifyInstall: async () => "152.0.4-beta.28",
    launch: async () => {
      const context = fakeContext()
      contexts.push(context)
      return context as never
    },
    openDisplay: () => {
      const display = { killed: false }
      displays.push(display)
      return { get: async () => ":99", kill: () => { display.killed = true } }
    },
  })
  return { instance, contexts, displays }
}

describe("browser session", () => {
  it("does not launch a browser until a tool asks for the context", async () => {
    const { instance, contexts } = session()
    expect(contexts).toHaveLength(0)
    expect(instance.started()).toBe(false)
    await instance.context()
    expect(contexts).toHaveLength(1)
    expect(instance.started()).toBe(true)
  })

  it("reuses one context and starts only once under concurrent callers", async () => {
    const { instance, contexts } = session()
    const [first, second] = await Promise.all([instance.context(), instance.context()])
    expect(first).toBe(second)
    expect(contexts).toHaveLength(1)
  })

  it("relaunches after the window is closed and reports it as not alive", async () => {
    const { instance, contexts } = session()
    const first = await instance.context()
    contexts[0].kill()
    expect(instance.alive()).toBe(false)
    expect(instance.started()).toBe(true)
    const second = await instance.context()
    expect(second).not.toBe(first)
    expect(contexts).toHaveLength(2)
    expect(instance.restarts()).toBe(1)
  })

  it("keeps the virtual display across relaunches", async () => {
    const { instance, contexts, displays } = session({ OWENCODE_BROWSER_DISPLAY: "virtual" })
    await instance.context()
    contexts[0].kill()
    await instance.context()
    expect(displays).toHaveLength(1)
    expect(displays[0].killed).toBe(false)
    await instance.close()
    expect(displays[0].killed).toBe(true)
  })

  it("applies the configured action timeout to every context", async () => {
    const { instance, contexts } = session({ OWENCODE_BROWSER_TIMEOUT_MS: "120000" })
    await instance.context()
    expect(contexts[0].timeouts).toEqual([120_000, 120_000])
  })

  it("refuses to launch when the Camoufox install is unusable", async () => {
    const settings = resolveSettings({}, { OWENCODE_BROWSER_DISPLAY: "headed" })
    let launched = 0
    const instance = createSession(settings, identity, {
      verifyInstall: async () => { throw new Error("camoufox-bin is missing") },
      launch: async () => { launched += 1; return fakeContext() as never },
    })
    await expect(instance.context()).rejects.toThrow("camoufox-bin is missing")
    // Never reaching camoufox-js is the point: it would wipe the install
    // directory in the background while another browser is still using it.
    expect(launched).toBe(0)
    // The failure is not sticky, so a repaired install works without a restart.
    await expect(instance.context()).rejects.toThrow("camoufox-bin is missing")
  })

  it("refuses to hand out a context after shutdown", async () => {
    const { instance, contexts } = session()
    await instance.context()
    await instance.close()
    expect(contexts[0].closed).toBe(true)
    await expect(instance.context()).rejects.toThrow("shut down")
  })
})
