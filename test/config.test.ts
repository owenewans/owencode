import { describe, expect, it } from "vitest"
import { parseOptions, parseRemoteTarget, remotePath, targetLabel } from "../src/config.js"

describe("configuration", () => {
  it("accepts a minimal configuration", () => {
    expect(parseOptions({ root: "/srv/app" })).toMatchObject({
      root: "/srv/app",
      sshBinary: "ssh",
    })
  })

  it("defaults the root to /", () => {
    expect(parseOptions({})).toMatchObject({ root: "/" })
  })

  it("requires an absolute root", () => {
    expect(() => parseOptions({ root: "srv/app" })).toThrow("absolute remote path")
  })

  it("validates multiplexing settings", () => {
    expect(parseOptions({ root: "/srv/app" })).toMatchObject({ controlMaster: true, maxSessions: 8 })
    expect(() => parseOptions({ root: "/srv/app", maxSessions: 20 })).toThrow("between 1 and 10")
    expect(() => parseOptions({ root: "/srv/app", controlPersist: "forever" })).toThrow("duration")
  })

  it("parses user@host targets with an optional port", () => {
    expect(parseRemoteTarget("marou@2.26.179.6", undefined)).toEqual({ user: "marou", host: "2.26.179.6", port: 22 })
    expect(parseRemoteTarget("root@93.95.228.248", 2222)).toEqual({ user: "root", host: "93.95.228.248", port: 2222 })
    expect(targetLabel(parseRemoteTarget("root@93.95.228.248", undefined))).toBe("root@93.95.228.248")
    expect(targetLabel(parseRemoteTarget("root@93.95.228.248", 2222))).toBe("root@93.95.228.248:2222")
  })

  it("rejects malformed targets", () => {
    expect(() => parseRemoteTarget("93.95.228.248", undefined)).toThrow("user@host")
    expect(() => parseRemoteTarget("@93.95.228.248", undefined)).toThrow("user@host")
    expect(() => parseRemoteTarget("root@", undefined)).toThrow("user@host")
    expect(() => parseRemoteTarget("root@-oProxyCommand=x", undefined)).toThrow("cannot start with a dash")
    expect(() => parseRemoteTarget("root@host:2222", undefined)).toThrow('cannot contain ":"')
    expect(() => parseRemoteTarget("root@93.95.228.248", 70000)).toThrow("between 1 and 65535")
    expect(() => parseRemoteTarget("bad\nuser@host", undefined)).toThrow("control character")
  })

  it("accepts a bracketed IPv6 target", () => {
    expect(parseRemoteTarget("root@[2001:db8::1]", undefined)).toEqual({ user: "root", host: "[2001:db8::1]", port: 22 })
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
