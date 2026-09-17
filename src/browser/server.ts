#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createConnection } from "@playwright/mcp"
import fs from "node:fs/promises"
import type { Page } from "playwright-core"
import { loadSettings } from "./config.js"
import { installExtensions, type Extension, type ServerLike } from "./extensions.js"
import { loadOrCreateIdentity } from "./identity.js"
import { createJobs } from "./jobs.js"
import { createActionLog } from "./log.js"
import { createSession } from "./session.js"

const MAX_RESULT = 200_000

function serialize(value: unknown) {
  if (value === undefined) return "undefined"
  const json = JSON.stringify(value, null, 2) ?? String(value)
  return json.length > MAX_RESULT ? `${json.slice(0, MAX_RESULT)}…[truncated ${json.length} chars]` : json
}

async function main() {
  // Keep stdout exclusively for MCP JSON-RPC, including logs from dependencies.
  console.log = (...args: unknown[]) => console.error(...args)
  console.debug = (...args: unknown[]) => console.error(...args)

  const settings = await loadSettings()
  const identity = await loadOrCreateIdentity(settings)
  await fs.mkdir(settings.outputDir, { recursive: true, mode: 0o700 })
  await fs.chmod(settings.outputDir, 0o700)

  const log = createActionLog(settings.outputDir, settings.log)
  const session = createSession(settings, identity)

  const jobs = createJobs(async (code, signal) => {
    const context = await session.context()
    const page = (context.pages()[0] ?? await context.newPage()) as Page
    const factory = new Function(`return (${code})`) as () => (page: Page, control: { signal: AbortSignal }) => unknown
    return await factory()(page, { signal })
  }, settings.jobTimeout)

  const extensions: Extension[] = [
    {
      name: "browser_job_start",
      description: [
        "Run a long Playwright snippet in the background and return a job id immediately.",
        "Use this instead of browser_run_code_unsafe whenever the work may exceed the client request timeout,",
        "for example iterating over many pages. The snippet is a function invoked as fn(page, { signal });",
        "check signal.aborted in long loops so cancellation and the job timeout can take effect.",
        "Poll with browser_job_wait. Avoid issuing other browser tools while a job is running: they share one page.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "async (page, { signal }) => { ... } returning a JSON-serializable value" },
          timeoutMs: { type: "number", description: `Job ceiling in ms. Defaults to ${settings.jobTimeout}.` },
          label: { type: "string", description: "Short human-readable name for the log" },
        },
        required: ["code"],
      },
      handle: (args) => serialize(jobs.start(String(args.code), {
        timeout: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
        label: typeof args.label === "string" ? args.label : undefined,
      })),
    },
    {
      name: "browser_job_wait",
      description: "Wait up to waitMs for a background job and return its status, result or error. The job keeps running if the wait expires.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          waitMs: { type: "number", description: "Maximum wait for this call, default 30000" },
        },
        required: ["id"],
      },
      handle: async (args) => serialize(await jobs.wait(String(args.id), typeof args.waitMs === "number" ? args.waitMs : 30_000)),
    },
    {
      name: "browser_job_list",
      description: "List background jobs with their status and runtime.",
      inputSchema: { type: "object", properties: {} },
      handle: () => serialize(jobs.list()),
    },
    {
      name: "browser_job_cancel",
      description: "Abort a running background job. The snippet only stops at its next signal.aborted check.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      handle: (args) => serialize(jobs.cancel(String(args.id))),
    },
    {
      name: "browser_session_status",
      description: "Report whether the browser window is up, how many times it was relaunched, and where the action log lives.",
      inputSchema: { type: "object", properties: {} },
      handle: () => serialize({
        display: settings.display,
        started: session.started(),
        alive: session.alive(),
        restarts: session.restarts(),
        pendingJobs: jobs.pending(),
        actionLog: log.file,
        jobTimeout: settings.jobTimeout,
        actionTimeout: settings.actionTimeout ?? "playwright default",
      }),
    },
  ]

  let server: Awaited<ReturnType<typeof createConnection>> | undefined
  let shutdownChain = Promise.resolve()
  const shutdown = () => {
    shutdownChain = shutdownChain
      .then(() => Promise.allSettled([server?.close(), session.close(), log.flush()]))
      .then(() => undefined)
    return shutdownChain
  }
  const requestShutdown = () => void shutdown()
  process.once("SIGINT", requestShutdown)
  process.once("SIGTERM", requestShutdown)
  process.stdin.once("end", requestShutdown)
  process.stdin.once("close", requestShutdown)

  try {
    // The context is created on first use, not here: an idle session should not
    // put a browser window on the user's screen, and a window closed by hand
    // must not poison the connection.
    server = await createConnection(
      {
        browser: {
          browserName: "firefox",
          isolated: false,
          contextOptions: { viewport: null },
        },
        capabilities: settings.capabilities as never,
        outputDir: settings.outputDir,
        imageResponses: "allow",
        codegen: "typescript",
      },
      async () => await session.context() as never,
    )
    installExtensions(server as unknown as ServerLike, { extensions, session, log, progressInterval: 15_000 })
    log.record({ event: "start", display: settings.display, profile: settings.profile })

    const transport = new StdioServerTransport()
    transport.onclose = () => void shutdown()
    await server.connect(transport)
  } catch (error) {
    await shutdown()
    throw error
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
