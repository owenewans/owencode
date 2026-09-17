import { Camoufox } from "camoufox-js"
import { VirtualDisplay } from "camoufox-js/dist/virtdisplay.js"
import type { BrowserContext } from "playwright-core"
import { browserEnvironment, type BrowserSettings } from "./config.js"
import type { Identity } from "./identity.js"
import { assertInstalled } from "./install.js"

export type SessionDependencies = {
  launch?: (display: string | undefined) => Promise<BrowserContext>
  openDisplay?: () => { get(): Promise<string>; kill(): void }
  verifyInstall?: () => Promise<unknown>
}

export type BrowserSession = {
  // Resolves the live context, starting the browser on first use and after the
  // window has gone away.
  context(): Promise<BrowserContext>
  // True once a context has been created and is still usable. The tool wrapper
  // uses it to decide whether Playwright's cached backend has to be dropped.
  alive(): boolean
  started(): boolean
  restarts(): number
  close(): Promise<void>
}

function defaultLaunch(settings: BrowserSettings, identity: Identity) {
  return async (display: string | undefined) =>
    await Camoufox({
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
      env: browserEnvironment(display),
    }) as unknown as BrowserContext
}

export function createSession(
  settings: BrowserSettings,
  identity: Identity,
  dependencies: SessionDependencies = {},
): BrowserSession {
  const launch = dependencies.launch ?? defaultLaunch(settings, identity)
  const openDisplay = dependencies.openDisplay ?? (() => new VirtualDisplay(false))
  const verifyInstall = dependencies.verifyInstall ?? (() => assertInstalled())
  let display: { get(): Promise<string>; kill(): void } | undefined
  let current: BrowserContext | undefined
  let pending: Promise<BrowserContext> | undefined
  let started = false
  let restarts = 0
  let shutdown = false

  const start = async () => {
    await verifyInstall()
    // The virtual display outlives individual browsers: restarting Xvfb for
    // every relaunch would drop the window the user is watching in headed mode
    // and waste a second in virtual mode.
    if (settings.display === "virtual" && !display) display = openDisplay()
    const context = await launch(display ? await display.get() : undefined)
    if (settings.actionTimeout !== undefined) {
      context.setDefaultTimeout(settings.actionTimeout)
      context.setDefaultNavigationTimeout(settings.actionTimeout)
    }
    // Closing the window, killing Firefox or a browser crash all surface here.
    // Forgetting the context is what makes the next tool call relaunch instead
    // of failing with "Target page, context or browser has been closed".
    context.once("close", () => {
      if (current === context) current = undefined
    })
    if (shutdown) {
      await context.close().catch(() => undefined)
      throw new Error("browser session is shut down")
    }
    return context
  }

  return {
    async context() {
      if (shutdown) throw new Error("browser session is shut down")
      if (current) return current
      if (!pending) {
        if (started) restarts += 1
        pending = start().then(
          (context) => {
            current = context
            started = true
            pending = undefined
            return context
          },
          (error: unknown) => {
            pending = undefined
            throw error
          },
        )
      }
      return await pending
    },
    alive: () => current !== undefined,
    started: () => started,
    restarts: () => restarts,
    async close() {
      shutdown = true
      const context = current ?? (await pending?.catch(() => undefined))
      current = undefined
      pending = undefined
      await context?.close().catch(() => undefined)
      display?.kill()
      display = undefined
    },
  }
}
