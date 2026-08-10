import path from "node:path"
import os from "node:os"
import { describe, expect, it } from "vitest"
import { resolveSettings } from "../src/browser/config.js"

describe("browser configuration", () => {
  it("defaults to a persistent virtual profile", () => {
    expect(resolveSettings({}, {})).toMatchObject({
      profile: path.join(os.homedir(), ".local/share/owencode/browser-profile"),
      display: "virtual",
      geoip: false,
      humanize: true,
      outputDir: `${path.join(os.homedir(), ".local/share/owencode/browser-profile")}-output`,
    })
  })

  it("reads Camoufox options from the MCP environment", () => {
    expect(resolveSettings({}, {
      OWENCODE_BROWSER_PROFILE: "/tmp/profile",
      OWENCODE_BROWSER_DISPLAY: "headed",
      OWENCODE_BROWSER_PROXY: "http://proxy.example:8080",
      OWENCODE_BROWSER_GEOIP: "true",
      OWENCODE_BROWSER_OS: "windows,macos",
      OWENCODE_BROWSER_LOCALE: "en-US,de-DE",
      OWENCODE_BROWSER_HUMANIZE: "2.5",
      OWENCODE_BROWSER_CAPABILITIES: "core,network,storage",
    })).toEqual({
      profile: "/tmp/profile",
      display: "headed",
      proxy: "http://proxy.example:8080",
      geoip: true,
      os: ["windows", "macos"],
      locale: ["en-US", "de-DE"],
      humanize: 2.5,
      capabilities: ["core", "network", "storage"],
      outputDir: "/tmp/profile-output",
    })
  })

  it("enables geoip by default when a proxy is configured", () => {
    expect(resolveSettings({ proxy: "socks5://localhost:1080" }, {}).geoip).toBe(true)
  })

  it("rejects unsupported display and OS values", () => {
    expect(() => resolveSettings({}, { OWENCODE_BROWSER_DISPLAY: "headless" })).toThrow("display")
    expect(() => resolveSettings({}, { OWENCODE_BROWSER_OS: "android" })).toThrow("operating system")
  })
})
