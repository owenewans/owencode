import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type DisplayMode = "virtual" | "headed"

export type BrowserSettings = {
  profile: string
  display: DisplayMode
  proxy?: string
  geoip: boolean
  os?: Array<"windows" | "macos" | "linux">
  locale?: string[]
  humanize: boolean | number
  capabilities?: string[]
  outputDir: string
}

type SettingsInput = Partial<BrowserSettings> & {
  os?: BrowserSettings["os"] | string
  locale?: string[] | string
}

function expandHome(value: string) {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2))
  return path.resolve(value)
}

function booleanOrNumber(value: string | undefined, fallback: boolean | number): boolean | number {
  if (value === undefined) return fallback
  if (value === "true" || value === "1") return true
  if (value === "false" || value === "0") return false
  const number = Number(value)
  if (Number.isFinite(number) && number > 0) return number
  throw new Error(`invalid boolean or positive number: ${value}`)
}

function geoipValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (value === "true" || value === "1") return true
  if (value === "false" || value === "0") return false
  throw new Error(`invalid boolean: ${value}`)
}

function list(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value
  return value?.split(",").map((item) => item.trim()).filter(Boolean)
}

export function resolveSettings(input: SettingsInput = {}, env = process.env): BrowserSettings {
  const proxy = env.OWENCODE_BROWSER_PROXY ?? input.proxy
  const display = (env.OWENCODE_BROWSER_DISPLAY ?? input.display ?? "virtual") as DisplayMode
  if (display !== "virtual" && display !== "headed") throw new Error(`invalid browser display mode: ${display}`)

  const targetOS = list(env.OWENCODE_BROWSER_OS ?? input.os) as BrowserSettings["os"]
  if (targetOS?.some((value) => !["windows", "macos", "linux"].includes(value))) {
    throw new Error(`invalid Camoufox operating system: ${targetOS.join(",")}`)
  }

  const profile = expandHome(env.OWENCODE_BROWSER_PROFILE ?? input.profile ?? "~/.local/share/owencode/browser-profile")
  const outputDirValue = env.OWENCODE_BROWSER_OUTPUT_DIR ?? input.outputDir
  return {
    profile,
    display,
    proxy,
    geoip: env.OWENCODE_BROWSER_GEOIP === undefined
      ? input.geoip ?? Boolean(proxy)
      : geoipValue(env.OWENCODE_BROWSER_GEOIP, false),
    os: targetOS,
    locale: list(env.OWENCODE_BROWSER_LOCALE ?? input.locale),
    humanize: booleanOrNumber(env.OWENCODE_BROWSER_HUMANIZE, input.humanize ?? true),
    capabilities: list(env.OWENCODE_BROWSER_CAPABILITIES ?? input.capabilities),
    outputDir: outputDirValue ? expandHome(outputDirValue) : `${profile}-output`,
  }
}

export function browserEnvironment(display: string | undefined, env = process.env) {
  const result = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  if (!display) return result

  delete result.WAYLAND_DISPLAY
  delete result.WAYLAND_SOCKET
  result.DISPLAY = display
  result.MOZ_ENABLE_WAYLAND = "0"
  result.GDK_BACKEND = "x11"
  result.XDG_SESSION_TYPE = "x11"
  return result
}

export async function loadSettings(argv = process.argv.slice(2), env = process.env) {
  let input: SettingsInput = {}
  const configIndex = argv.indexOf("--config")
  if (configIndex >= 0) {
    const configPath = argv[configIndex + 1]
    if (!configPath) throw new Error("--config requires a JSON file path")
    input = JSON.parse(await fs.readFile(expandHome(configPath), "utf8")) as SettingsInput
  }
  return resolveSettings(input, env)
}
