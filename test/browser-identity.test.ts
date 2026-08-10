import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { extractCamouConfig, loadOrCreateIdentity, settingsKey } from "../src/browser/identity.js"
import { resolveSettings } from "../src/browser/config.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("browser identity", () => {
  it("reassembles chunked Camoufox configuration in numeric order", () => {
    expect(extractCamouConfig({
      CAMOU_CONFIG_2: '"value"}',
      PATH: "/usr/bin",
      CAMOU_CONFIG_1: '{"key":',
    })).toEqual({ key: "value" })
  })

  it("changes the identity key with fingerprint-relevant settings", () => {
    const first = resolveSettings({ profile: "/tmp/profile", os: ["linux"] }, {})
    const second = resolveSettings({ profile: "/tmp/profile", os: ["windows"] }, {})
    expect(settingsKey(first, "browser-1")).not.toBe(settingsKey(second, "browser-1"))
    expect(settingsKey(first, "browser-1")).not.toBe(settingsKey(first, "browser-2"))
  })

  it("does not include profile or display mode in the identity key", () => {
    const virtual = resolveSettings({ profile: "/tmp/a", display: "virtual" }, {})
    const headed = resolveSettings({ profile: "/tmp/b", display: "headed" }, {})
    expect(settingsKey(virtual, "browser-1")).toBe(settingsKey(headed, "browser-1"))
  })

  it("persists and reuses a private identity", async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), "owencode-identity-"))
    directories.push(profile)
    const settings = resolveSettings({ profile }, {})
    let generations = 0
    const dependencies = {
      browserVersion: async () => "browser-1",
      generate: async () => {
        generations++
        return { env: { CAMOU_CONFIG_1: '{"navigator.userAgent":"stable"}' } }
      },
    }

    const first = await loadOrCreateIdentity(settings, dependencies as never)
    const second = await loadOrCreateIdentity(settings, dependencies as never)
    const identityPath = path.join(profile, ".owencode-identity.json")
    expect(first).toEqual(second)
    expect(generations).toBe(1)
    expect((await fs.stat(profile)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(identityPath)).mode & 0o777).toBe(0o600)
  })
})
