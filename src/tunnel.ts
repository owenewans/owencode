import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import net from "node:net"
import { noControlArgs } from "./multiplex.js"

export type TunnelType = "local" | "remote" | "dynamic"

export type TunnelRequest = {
  type: TunnelType
  bindHost: string
  bindPort: number
  destinationHost?: string
  destinationPort?: number
}

export type TunnelRecord = TunnelRequest & {
  id: string
  pid: number
  startedAt: number
  verified: boolean
}

export type TunnelTransport = {
  sshBinary: string
  sshArgs: string[]
  host: string
}

type TunnelEntry = {
  record: TunnelRecord
  child: ChildProcess
  stderr: string
  exited: boolean
  closed: Promise<void>
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "[::1]"])

export function isLoopback(host: string) {
  return LOOPBACK.has(host.toLowerCase())
}

export function validateTunnelHost(value: string, label: string) {
  if (/[\0\r\n\s]/.test(value) || value.length === 0) throw new Error(`${label} contains invalid characters`)
  const bracketed = /^\[[0-9A-Fa-f:.]+\]$/.test(value)
  if (!bracketed && !/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`${label} is not a valid host`)
  if (value.startsWith("-")) throw new Error(`${label} cannot start with a dash`)
  return value
}

export function validateTunnelPort(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${label} must be between 1 and 65535`)
  return value
}

export function tunnelForward(request: TunnelRequest) {
  const bindHost = validateTunnelHost(request.bindHost, "bindHost")
  const bindPort = validateTunnelPort(request.bindPort, "bindPort")
  if (request.type === "dynamic") {
    if (request.destinationHost || request.destinationPort !== undefined) {
      throw new Error("a dynamic tunnel does not take a destination")
    }
    return { flag: "-D", spec: `${bindHost}:${bindPort}` }
  }
  if (!request.destinationHost || request.destinationPort === undefined) {
    throw new Error(`a ${request.type} tunnel requires destinationHost and destinationPort`)
  }
  const destinationHost = validateTunnelHost(request.destinationHost, "destinationHost")
  const destinationPort = validateTunnelPort(request.destinationPort, "destinationPort")
  return {
    flag: request.type === "local" ? "-L" : "-R",
    spec: `${bindHost}:${bindPort}:${destinationHost}:${destinationPort}`,
  }
}

export function describeTunnel(record: TunnelRecord, host: string) {
  if (record.type === "dynamic") return `${record.id} dynamic ${record.bindHost}:${record.bindPort} -> ${host}`
  const direction = record.type === "local" ? "->" : "<-"
  return `${record.id} ${record.type} ${record.bindHost}:${record.bindPort} ${direction} ${record.destinationHost}:${record.destinationPort} via ${host}`
}

function probe(host: string, port: number, timeout: number) {
  return new Promise<boolean>((resolve) => {
    const target = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.replace(/^\[|\]$/g, "")
    const socket = net.connect({ host: target, port })
    const done = (value: boolean) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeout)
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
  })
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class TunnelManager {
  private readonly tunnels = new Map<string, TunnelEntry>()
  private hooked = false

  constructor(private readonly transport: TunnelTransport) {}

  private hook() {
    if (this.hooked) return
    this.hooked = true
    process.once("exit", () => this.closeAllSync())
  }

  list(): TunnelRecord[] {
    return [...this.tunnels.values()].map((item) => item.record)
  }

  private signal(entry: TunnelEntry, signal: NodeJS.Signals) {
    try {
      entry.child.kill(signal)
    } catch {
      // The tunnel may already have exited.
    }
  }

  async close(id: string, timeout = 2000) {
    const entry = this.tunnels.get(id)
    if (!entry) return false
    this.signal(entry, "SIGTERM")
    const escalate = setTimeout(() => this.signal(entry, "SIGKILL"), timeout)
    try {
      await entry.closed
    } finally {
      clearTimeout(escalate)
      this.tunnels.delete(id)
    }
    return true
  }

  closeAllSync() {
    for (const [id, entry] of [...this.tunnels.entries()]) {
      this.signal(entry, "SIGKILL")
      this.tunnels.delete(id)
    }
  }

  async closeAll() {
    await Promise.all([...this.tunnels.keys()].map((id) => this.close(id)))
  }

  async open(request: TunnelRequest, readinessTimeout = 10_000): Promise<TunnelRecord> {
    const forward = tunnelForward(request)
    for (const existing of this.tunnels.values()) {
      if (existing.record.bindHost === request.bindHost && existing.record.bindPort === request.bindPort) {
        throw new Error(`a tunnel already binds ${request.bindHost}:${request.bindPort}`)
      }
    }
    // A port that already answers would make the readiness probe succeed on a
    // listener that is not ours, so refuse before ssh is even started rather
    // than reporting someone else's service as a verified tunnel.
    if (request.type !== "remote" && (await probe(request.bindHost, request.bindPort, 500))) {
      throw new Error(`${request.bindHost}:${request.bindPort} is already in use by another process`)
    }
    this.hook()
    const child = spawn(
      this.transport.sshBinary,
      [
        ...this.transport.sshArgs,
        ...noControlArgs(),
        "-N",
        "-T",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "BatchMode=yes",
        forward.flag,
        forward.spec,
        this.transport.host,
      ],
      { stdio: ["ignore", "ignore", "pipe"], detached: false },
    )

    const id = `tunnel-${randomBytes(4).toString("hex")}`
    const entry: TunnelEntry = {
      record: { ...request, id, pid: child.pid ?? -1, startedAt: Date.now(), verified: request.type !== "remote" },
      child,
      stderr: "",
      exited: false,
      closed: Promise.resolve(),
    }
    // A tunnel that dies on its own must leave the registry, otherwise list()
    // reports a forward that is gone and open() refuses to rebind the port.
    const retire = (resolve: () => void) => () => {
      entry.exited = true
      entry.record.verified = false
      if (this.tunnels.get(id) === entry) this.tunnels.delete(id)
      resolve()
    }
    entry.closed = new Promise<void>((resolve) => {
      child.once("close", retire(resolve))
      child.once("error", retire(resolve))
    })
    child.stderr.on("data", (chunk: Buffer) => {
      entry.stderr = `${entry.stderr}${chunk.toString("utf8")}`.slice(-4096)
    })

    const fail = (message: string) => new Error(entry.stderr.trim() || message)
    const ready = (async () => {
      if (request.type === "remote") {
        await wait(Math.min(750, readinessTimeout))
        if (entry.exited) throw fail("ssh tunnel exited immediately")
        return
      }
      const deadline = Date.now() + readinessTimeout
      while (Date.now() < deadline) {
        if (entry.exited) throw fail("ssh tunnel exited before it started listening")
        if (await probe(request.bindHost, request.bindPort, 1000)) {
          // A foreign listener on the same port would let the probe succeed while
          // ssh is still failing, so give ExitOnForwardFailure a moment to report.
          await wait(150)
          if (entry.exited) throw fail("another process is already listening on that port")
          return
        }
        await wait(150)
      }
      throw fail(`tunnel did not start listening on ${request.bindHost}:${request.bindPort}`)
    })()

    try {
      await ready
    } catch (error) {
      this.signal(entry, "SIGKILL")
      await entry.closed
      throw error
    }

    // The process can still have died between the readiness check and here.
    if (entry.exited) throw fail("ssh tunnel exited before it could be registered")
    this.tunnels.set(id, entry)
    child.unref()
    ;(child.stderr as unknown as { unref?: () => void }).unref?.()
    return entry.record
  }
}
