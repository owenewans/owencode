import { describe, expect, it, vi } from "vitest"
import { installExtensions, type Extension, type RequestHandler, type ServerLike, type ToolResult } from "../src/browser/extensions.js"
import type { BrowserSession } from "../src/browser/session.js"

function harness(sessionState: Partial<Record<"started" | "alive", boolean>> = {}) {
  const calls: string[] = []
  const handlers = new Map<string, RequestHandler>()
  handlers.set("tools/list", async () => ({ tools: [{ name: "browser_click" }] }) as unknown as ToolResult)
  handlers.set("tools/call", async (request) => {
    calls.push(request.params?.name ?? "")
    return { content: [{ type: "text", text: "ok" }] }
  })
  const server: ServerLike = { _requestHandlers: handlers, notification: vi.fn(async () => undefined) }
  const entries: Record<string, unknown>[] = []
  const session = {
    context: async () => ({}) as never,
    started: () => sessionState.started ?? true,
    alive: () => sessionState.alive ?? true,
    restarts: () => 1,
    close: async () => undefined,
  } satisfies BrowserSession
  const log = { file: "/tmp/log", record: (entry: Record<string, unknown>) => entries.push(entry), flush: async () => undefined }
  return { calls, handlers, server, session, log, entries }
}

const extension: Extension = {
  name: "browser_job_start",
  description: "start",
  inputSchema: { type: "object", properties: {} },
  handle: (args) => `started ${String(args.code)}`,
}

const call = (handlers: Map<string, RequestHandler>, name: string, args: Record<string, unknown> = {}) =>
  handlers.get("tools/call")!({ params: { name, arguments: args } }, {})

describe("browser MCP extensions", () => {
  it("advertises the extra tools next to the Playwright ones", async () => {
    const { server, handlers, session, log } = harness()
    installExtensions(server, { extensions: [extension], session, log })
    const result = await handlers.get("tools/list")!({}, {}) as unknown as { tools: Array<{ name: string }> }
    expect(result.tools.map((tool) => tool.name)).toEqual(["browser_click", "browser_job_start"])
  })

  it("handles its own tools without touching Playwright", async () => {
    const { server, handlers, session, log, calls } = harness()
    installExtensions(server, { extensions: [extension], session, log })
    expect(await call(handlers, "browser_job_start", { code: "x" })).toMatchObject({
      content: [{ type: "text", text: "started x" }],
    })
    expect(calls).toEqual([])
  })

  it("reports extension failures as tool errors instead of crashing the server", async () => {
    const { server, handlers, session, log } = harness()
    installExtensions(server, {
      extensions: [{ ...extension, handle: () => { throw new Error("unknown job: job-9") } }],
      session,
      log,
    })
    expect(await call(handlers, "browser_job_start")).toMatchObject({ isError: true })
  })

  it("drops the cached backend with browser_close when the window died", async () => {
    const { server, handlers, session, log, calls, entries } = harness({ started: true, alive: false })
    installExtensions(server, { extensions: [], session, log })
    await call(handlers, "browser_snapshot")
    expect(calls).toEqual(["browser_close", "browser_snapshot"])
    expect(entries.some((entry) => entry.event === "relaunch")).toBe(true)
  })

  it("does not reset a healthy session or one that never started", async () => {
    const healthy = harness({ started: true, alive: true })
    installExtensions(healthy.server, { extensions: [], session: healthy.session, log: healthy.log })
    await call(healthy.handlers, "browser_snapshot")
    expect(healthy.calls).toEqual(["browser_snapshot"])

    const cold = harness({ started: false, alive: false })
    installExtensions(cold.server, { extensions: [], session: cold.session, log: cold.log })
    await call(cold.handlers, "browser_navigate")
    expect(cold.calls).toEqual(["browser_navigate"])
  })

  it("logs every delegated call with its duration", async () => {
    const { server, handlers, session, log, entries } = harness()
    installExtensions(server, { extensions: [], session, log })
    await call(handlers, "browser_click", { target: "e1" })
    expect(entries[0]).toMatchObject({ tool: "browser_click", args: { target: "e1" }, ok: true })
    expect(typeof entries[0].ms).toBe("number")
  })

  it("emits progress while a slow call runs so clients can extend their deadline", async () => {
    const { server, handlers, session, log } = harness()
    handlers.set("tools/call", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return { content: [] }
    })
    installExtensions(server, { extensions: [], session, log, progressInterval: 5 })
    await handlers.get("tools/call")!({ params: { name: "browser_snapshot", _meta: { progressToken: 7 } } }, {})
    expect(server.notification).toHaveBeenCalled()
    expect(vi.mocked(server.notification).mock.calls[0][0]).toMatchObject({
      method: "notifications/progress",
      params: { progressToken: 7 },
    })
  })
})
