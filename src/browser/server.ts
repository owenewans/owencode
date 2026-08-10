#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createConnection } from "@playwright/mcp"
import { Camoufox } from "camoufox-js"
import { VirtualDisplay } from "camoufox-js/dist/virtdisplay.js"
import fs from "node:fs/promises"
import type { BrowserContext } from "playwright-core"
import { browserEnvironment, loadSettings } from "./config.js"
import { loadOrCreateIdentity } from "./identity.js"

async function main() {
  // Keep stdout exclusively for MCP JSON-RPC, including logs from dependencies.
  console.log = (...args: unknown[]) => console.error(...args)
  console.debug = (...args: unknown[]) => console.error(...args)

  const settings = await loadSettings()
  const identity = await loadOrCreateIdentity(settings)
  await fs.mkdir(settings.outputDir, { recursive: true, mode: 0o700 })
  await fs.chmod(settings.outputDir, 0o700)
  let context: BrowserContext | undefined
  let server: Awaited<ReturnType<typeof createConnection>> | undefined
  let virtualDisplay: VirtualDisplay | undefined
  let contextClosing: Promise<void> | undefined
  const closeResources = () => {
    if (context && !contextClosing) contextClosing = context.close().catch(() => undefined)
    virtualDisplay?.kill()
    return contextClosing ?? Promise.resolve()
  }
  let shutdownRequested = false
  let shutdownChain = Promise.resolve()
  const shutdown = () => {
    shutdownRequested = true
    shutdownChain = shutdownChain.then(() => Promise.allSettled([server?.close(), closeResources()])).then(() => undefined)
    return shutdownChain
  }
  const requestShutdown = () => void shutdown()
  process.once("SIGINT", requestShutdown)
  process.once("SIGTERM", requestShutdown)
  process.stdin.once("end", requestShutdown)
  process.stdin.once("close", requestShutdown)

  try {
    const display = settings.display === "virtual"
      ? await (virtualDisplay = new VirtualDisplay(false)).get()
      : undefined
    const browserEnv = browserEnvironment(display)
    context = await Camoufox({
      config: identity.config,
      user_data_dir: settings.profile,
      headless: false,
      proxy: settings.proxy,
      geoip: settings.geoip,
      os: settings.os,
      locale: settings.locale,
      humanize: settings.humanize,
      enable_cache: true,
      i_know_what_im_doing: true,
      debug: false,
      env: browserEnv,
    }) as unknown as BrowserContext
    if (shutdownRequested) return await shutdown()

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
      async () => context as never,
    )
    if (shutdownRequested) return await shutdown()
    const transport = new StdioServerTransport()
    transport.onclose = () => void closeResources()
    try {
      await server.connect(transport)
    } catch (error) {
      await shutdown()
      throw error
    }
  } catch (error) {
    await closeResources()
    throw error
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
