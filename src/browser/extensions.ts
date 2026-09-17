import type { ActionLog } from "./log.js"
import type { BrowserSession } from "./session.js"

export type ToolResult = {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

export type ToolRequest = {
  params?: {
    name?: string
    arguments?: Record<string, unknown>
    _meta?: { progressToken?: string | number }
  }
}

export type RequestHandler = (request: ToolRequest, extra: unknown) => Promise<ToolResult>

// Only the two members the wrapper needs, so tests can pass a plain object
// instead of a real MCP server.
export type ServerLike = {
  _requestHandlers: Map<string, RequestHandler>
  notification(notification: { method: string; params?: Record<string, unknown> }): Promise<void>
}

export type Extension = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handle(args: Record<string, unknown>): Promise<string> | string
}

export type ExtensionOptions = {
  extensions: Extension[]
  session: BrowserSession
  log: ActionLog
  // Keeps clients that reset their deadline on progress from timing out a long
  // tool call. Harmless for clients that ignore progress notifications.
  progressInterval?: number
}

const text = (value: string, isError = false): ToolResult => ({
  content: [{ type: "text", text: value }],
  ...isError ? { isError: true } : {},
})

export function installExtensions(server: ServerLike, options: ExtensionOptions) {
  const { extensions, session, log } = options
  const handlers = server._requestHandlers
  const originalCall = handlers.get("tools/call")
  const originalList = handlers.get("tools/list")
  if (!originalCall || !originalList) throw new Error("MCP server exposes no tool handlers to wrap")
  const byName = new Map(extensions.map((extension) => [extension.name, extension]))

  handlers.set("tools/list", async (request, extra) => {
    const result = await originalList(request, extra) as unknown as { tools?: unknown[] }
    return {
      ...result,
      tools: [...result.tools ?? [], ...extensions.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }))],
    } as unknown as ToolResult
  })

  handlers.set("tools/call", async (request, extra) => {
    const name = request.params?.name ?? ""
    const args = request.params?.arguments ?? {}
    const started = Date.now()
    const extension = byName.get(name)

    if (extension) {
      try {
        const result = await extension.handle(args)
        log.record({ tool: name, args, ms: Date.now() - started, ok: true })
        return text(result)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        log.record({ tool: name, args, ms: Date.now() - started, ok: false, error: message })
        return text(`### Error\n${message}`, true)
      }
    }

    // Playwright caches its backend, and with it the dead context, for the
    // lifetime of the connection. browser_close is the only supported way to
    // drop that cache, so a lost window is repaired by closing first and
    // letting the next call start a fresh browser.
    if (session.started() && !session.alive() && name !== "browser_close") {
      await originalCall({ params: { name: "browser_close", arguments: {} } }, extra).catch(() => undefined)
      log.record({ event: "relaunch", tool: name, restarts: session.restarts() })
    }

    const token = request.params?._meta?.progressToken
    let ticker: NodeJS.Timeout | undefined
    if (token !== undefined && options.progressInterval) {
      let progress = 0
      ticker = setInterval(() => {
        void server.notification({
          method: "notifications/progress",
          params: { progressToken: token, progress: ++progress, message: `${name} running` },
        }).catch(() => undefined)
      }, options.progressInterval)
      ticker.unref?.()
    }

    try {
      const result = await originalCall(request, extra)
      log.record({ tool: name, args, ms: Date.now() - started, ok: !result.isError })
      return result
    } finally {
      if (ticker) clearInterval(ticker)
    }
  })
}
