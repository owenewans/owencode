import net from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { describeTunnel, isLoopback, TunnelManager, tunnelForward, validateTunnelHost, validateTunnelPort } from "../src/tunnel.js"

const managers: TunnelManager[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.closeAll()))
})

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address === "string" || !address) return reject(new Error("no port"))
      server.close(() => resolve(address.port))
    })
  })
}

function fakeSsh(script: string) {
  const manager = new TunnelManager({
    sshBinary: "/bin/sh",
    sshArgs: ["-c", script, "owencode-test"],
    host: "ignored",
  })
  managers.push(manager)
  return manager
}

function fakeTunnel(port: number) {
  const listen = `require("net").createServer((socket) => socket.end()).listen(${port}, "127.0.0.1")`
  return fakeSsh(`exec ${process.execPath} -e '${listen}'`)
}

describe("ssh tunnel", () => {
  it("builds forward specifications for every type", () => {
    expect(tunnelForward({ type: "local", bindHost: "127.0.0.1", bindPort: 8080, destinationHost: "10.0.0.5", destinationPort: 80 }))
      .toEqual({ flag: "-L", spec: "127.0.0.1:8080:10.0.0.5:80" })
    expect(tunnelForward({ type: "remote", bindHost: "127.0.0.1", bindPort: 9000, destinationHost: "127.0.0.1", destinationPort: 3000 }))
      .toEqual({ flag: "-R", spec: "127.0.0.1:9000:127.0.0.1:3000" })
    expect(tunnelForward({ type: "dynamic", bindHost: "127.0.0.1", bindPort: 1080 }))
      .toEqual({ flag: "-D", spec: "127.0.0.1:1080" })
  })

  it("rejects invalid hosts, ports and destinations", () => {
    expect(() => validateTunnelHost("evil host", "bindHost")).toThrow("invalid characters")
    expect(() => validateTunnelHost("-oProxyCommand=x", "bindHost")).toThrow("not a valid host")
    expect(() => validateTunnelPort(0, "bindPort")).toThrow("between 1 and 65535")
    expect(() => validateTunnelPort(70000, "bindPort")).toThrow("between 1 and 65535")
    expect(() => tunnelForward({ type: "local", bindHost: "127.0.0.1", bindPort: 80 })).toThrow("destinationHost")
    expect(() => tunnelForward({ type: "dynamic", bindHost: "127.0.0.1", bindPort: 80, destinationPort: 1 })).toThrow("does not take a destination")
  })

  it("identifies loopback bind addresses", () => {
    expect(isLoopback("127.0.0.1")).toBe(true)
    expect(isLoopback("::1")).toBe(true)
    expect(isLoopback("0.0.0.0")).toBe(false)
  })

  it("opens, lists and closes a tunnel process", async () => {
    const port = await freePort()
    const manager = fakeTunnel(port)
    const record = await manager.open(
      { type: "local", bindHost: "127.0.0.1", bindPort: port, destinationHost: "127.0.0.1", destinationPort: 1 },
      5000,
    )

    expect(manager.list()).toHaveLength(1)
    expect(describeTunnel(record, "dev")).toContain(`127.0.0.1:${port}`)
    expect(() => process.kill(record.pid, 0)).not.toThrow()

    expect(await manager.close(record.id)).toBe(true)
    expect(manager.list()).toHaveLength(0)
    expect(await manager.close(record.id)).toBe(false)
    expect(() => process.kill(record.pid, 0)).toThrow()
  })

  it("kills a tunnel that ignores SIGTERM before reporting it closed", async () => {
    const port = await freePort()
    const script = `trap "" TERM; exec ${process.execPath} -e 'process.on("SIGTERM", () => {}); require("net").createServer().listen(${port}, "127.0.0.1")'`
    const manager = fakeSsh(script)
    const record = await manager.open(
      { type: "local", bindHost: "127.0.0.1", bindPort: port, destinationHost: "127.0.0.1", destinationPort: 1 },
      5000,
    )
    expect(await manager.close(record.id, 300)).toBe(true)
    expect(() => process.kill(record.pid, 0)).toThrow()
  })

  it("marks remote forwards as unverified", async () => {
    const manager = fakeSsh("sleep 5")
    const record = await manager.open(
      { type: "remote", bindHost: "127.0.0.1", bindPort: 9101, destinationHost: "127.0.0.1", destinationPort: 3000 },
      3000,
    )
    expect(record.verified).toBe(false)
    expect(manager.list()[0].type).toBe("remote")
  })

  it("refuses to bind the same address twice", async () => {
    const port = await freePort()
    const manager = fakeTunnel(port)
    await manager.open({ type: "local", bindHost: "127.0.0.1", bindPort: port, destinationHost: "127.0.0.1", destinationPort: 1 }, 5000)
    await expect(
      manager.open({ type: "local", bindHost: "127.0.0.1", bindPort: port, destinationHost: "127.0.0.1", destinationPort: 1 }, 5000),
    ).rejects.toThrow("already binds")
  })

  it("reports a tunnel that exits immediately", async () => {
    const manager = fakeSsh("echo permission denied >&2; exit 255")
    await expect(
      manager.open({ type: "local", bindHost: "127.0.0.1", bindPort: 45999, destinationHost: "127.0.0.1", destinationPort: 1 }, 3000),
    ).rejects.toThrow("permission denied")
  })
})
