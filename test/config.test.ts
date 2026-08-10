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

  it("confines relative and absolute paths to root", () => {
    expect(remotePath("/srv/app", "src/main.ts")).toBe("/srv/app/src/main.ts")
    expect(remotePath("/srv/app", "/srv/app/src/main.ts")).toBe("/srv/app/src/main.ts")
    expect(() => remotePath("/srv/app", "../secret")).toThrow("escapes configured root")
    expect(() => remotePath("/srv/app", "/etc/passwd")).toThrow("escapes configured root")
    expect(remotePath("/", "/tmp/file")).toBe("/tmp/file")
  })
})
