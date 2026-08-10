import { describe, expect, it } from "vitest"
import { parseOptions, remotePath } from "../src/config.js"

describe("configuration", () => {
  it("accepts a minimal configuration", () => {
    expect(parseOptions({ host: "dev", root: "/srv/app" })).toMatchObject({
      host: "dev",
      root: "/srv/app",
      sshBinary: "ssh",
    })
  })

  it("requires an absolute root", () => {
    expect(() => parseOptions({ host: "dev", root: "srv/app" })).toThrow("absolute remote path")
  })

  it("refuses an unconfined root unless it is acknowledged", () => {
    expect(() => parseOptions({ host: "dev", root: "/" })).toThrow("disables every path guard")
    expect(() => parseOptions({ host: "dev", root: "/../" })).toThrow("disables every path guard")
    expect(parseOptions({ host: "dev", root: "/", unconfined: true })).toMatchObject({ root: "/", unconfined: true })
  })

  it("keeps credential protection on by default", () => {
    expect(parseOptions({ host: "dev", root: "/srv/app" }).allowSensitivePaths).toBe(false)
  })

  it("validates multiplexing settings", () => {
    expect(parseOptions({ host: "dev", root: "/srv/app" })).toMatchObject({ controlMaster: true, maxSessions: 8 })
    expect(() => parseOptions({ host: "dev", root: "/srv/app", maxSessions: 20 })).toThrow("between 1 and 10")
    expect(() => parseOptions({ host: "dev", root: "/srv/app", controlPersist: "forever" })).toThrow("duration")
  })

  it("confines relative and absolute paths to root", () => {
    expect(remotePath("/srv/app", "src/main.ts")).toBe("/srv/app/src/main.ts")
    expect(remotePath("/srv/app", "/srv/app/src/main.ts")).toBe("/srv/app/src/main.ts")
    expect(() => remotePath("/srv/app", "../secret")).toThrow("escapes configured root")
    expect(() => remotePath("/srv/app", "/etc/passwd")).toThrow("escapes configured root")
    expect(remotePath("/", "/tmp/file")).toBe("/tmp/file")
  })
})
