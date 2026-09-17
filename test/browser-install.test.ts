import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { assertInstalled, installDirectory, installedVersion } from "../src/browser/install.js"

const directories: string[] = []

async function temporaryInstall(files: Record<string, string>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "camoufox-test-"))
  directories.push(directory)
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true })
    await fs.writeFile(path.join(directory, name), content)
  }
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("Camoufox install discovery", () => {
  it("honours CAMOUFOX_INSTALL_DIR and otherwise falls back to the user cache", () => {
    expect(installDirectory({ CAMOUFOX_INSTALL_DIR: "/opt/camoufox" })).toBe("/opt/camoufox")
    expect(installDirectory({})).toBe(path.join(os.homedir(), ".cache", "camoufox"))
  })

  it("reads the flat layout written by camoufox-js", async () => {
    const directory = await temporaryInstall({ "version.json": '{"version":"152.0.4","release":"beta.28"}' })
    expect(await installedVersion(directory)).toBe("152.0.4-beta.28")
  })

  it("reads the newer channel layout from config.json", async () => {
    const directory = await temporaryInstall({
      "config.json": '{"active_version":"browsers/official/152.0.4-beta.28-924f3109"}',
    })
    expect(await installedVersion(directory)).toBe("152.0.4-beta.28-924f3109")
  })

  it("explains how to install when neither layout is present", async () => {
    const directory = await temporaryInstall({})
    await expect(installedVersion(directory)).rejects.toThrow("browser:fetch")
  })

  it("refuses an install whose launcher sits in a version subdirectory", async () => {
    const directory = await temporaryInstall({
      "config.json": '{"active_version":"browsers/official/152.0.4-beta.28-924f3109"}',
      "browsers/official/152.0.4-beta.28-924f3109/camoufox-bin": "binary",
    })
    await expect(assertInstalled(directory)).rejects.toThrow("camoufox-bin is missing")
  })

  it("accepts an install with the launcher in place", async () => {
    const directory = await temporaryInstall({
      "version.json": '{"version":"152.0.4","release":"beta.28"}',
      "camoufox-bin": "binary",
    })
    expect(await assertInstalled(directory)).toBe("152.0.4-beta.28")
  })
})
