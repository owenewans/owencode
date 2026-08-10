import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { launchOptions } from "camoufox-js"
import type { BrowserSettings } from "./config.js"

export type Identity = {
  schema: 1
  key: string
  browserVersion: string
  config: Record<string, unknown>
}

function installDirectory() {
  return process.env.CAMOUFOX_INSTALL_DIR
    ? path.resolve(process.env.CAMOUFOX_INSTALL_DIR)
    : path.join(os.homedir(), ".cache", "camoufox")
}

async function browserVersion() {
  const versionPath = path.join(installDirectory(), "version.json")
  try {
    const value = JSON.parse(await fs.readFile(versionPath, "utf8")) as { version?: string; release?: string }
    return `${value.version ?? "unknown"}-${value.release ?? "unknown"}`
  } catch {
    throw new Error(`Camoufox is not installed. Run \"npm run browser:fetch\" in the owencode repository.`)
  }
}

export type IdentityDependencies = {
  browserVersion?: () => Promise<string>
  generate?: typeof launchOptions
}

export function extractCamouConfig(env: Record<string, unknown> | undefined) {
  const chunks = Object.entries(env ?? {})
    .filter(([key]) => /^CAMOU_CONFIG_\d+$/.test(key))
    .sort(([left], [right]) => Number(left.slice(13)) - Number(right.slice(13)))
    .map(([, value]) => String(value))
  if (chunks.length === 0) throw new Error("camoufox-js did not generate CAMOU_CONFIG")
  return JSON.parse(chunks.join("")) as Record<string, unknown>
}

export function settingsKey(settings: BrowserSettings, version: string) {
  return createHash("sha256")
    .update(JSON.stringify({
      version,
      proxy: settings.proxy,
      geoip: settings.geoip,
      os: settings.os,
      locale: settings.locale,
      humanize: settings.humanize,
    }))
    .digest("hex")
}

export async function loadOrCreateIdentity(
  settings: BrowserSettings,
  dependencies: IdentityDependencies = {},
): Promise<Identity> {
  const identityPath = path.join(settings.profile, ".owencode-identity.json")
  const version = await (dependencies.browserVersion ?? browserVersion)()
  const key = settingsKey(settings, version)
  await fs.mkdir(settings.profile, { recursive: true, mode: 0o700 })
  await fs.chmod(settings.profile, 0o700)
  try {
    const current = JSON.parse(await fs.readFile(identityPath, "utf8")) as Identity
    if (current.schema === 1 && current.key === key && current.browserVersion === version) {
      await fs.chmod(identityPath, 0o600)
      return current
    }
  } catch {
    // A missing or invalid identity is regenerated below.
  }

  const generated = await (dependencies.generate ?? launchOptions)({
    env: {},
    proxy: settings.proxy,
    geoip: settings.geoip,
    os: settings.os,
    locale: settings.locale,
    humanize: settings.humanize,
    headless: false,
  })
  const identity: Identity = {
    schema: 1,
    key,
    browserVersion: version,
    config: extractCamouConfig(generated.env as Record<string, unknown>),
  }
  const temporary = `${identityPath}.${process.pid}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
    await fs.rename(temporary, identityPath)
  } finally {
    await fs.rm(temporary, { force: true })
  }
  return identity
}
