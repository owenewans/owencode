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

  it("accepts a root of /", () => {
    expect(parseOptions({ host: "dev", root: "/" })).toMatchObject({ root: "/" })
  })

  it("validates multiplexing settings", () => {
    expect(parseOptions({ host: "dev", root: "/srv/app" })).toMatchObject({ controlMaster: true, maxSessions: 8 })
    expect(() => parseOptions({ host: "dev", root: "/srv/app", maxSessions: 20 })).toThrow("between 1 and 10")
    expect(() => parseOptions({ host: "dev", root: "/srv/app", controlPersist: "forever" })).toThrow("duration")
  })

  // root is a base for relative paths, not a boundary: an absolute path is
  // taken as given and the approval prompt is what gates the call.
  it("resolves relative paths against root and passes absolute paths through", () => {
    expect(remotePath("/srv/app", "src/main.ts")).toBe("/srv/app/src/main.ts")
    expect(remotePath("/srv/app", "/srv/app/src/main.ts")).toBe("/srv/app/src/main.ts")
    expect(remotePath("/srv/app", "../secret")).toBe("/srv/secret")
    expect(remotePath("/srv/app", "/etc/passwd")).toBe("/etc/passwd")
    expect(remotePath("/", "/tmp/file")).toBe("/tmp/file")
    expect(() => remotePath("/srv/app", "bad\0path")).toThrow("control character")
  })
})
