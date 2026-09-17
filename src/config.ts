import path from "node:path"

export type Options = {
  root: string
  sshBinary: string
  sshArgs: string[]
  maxOutputBytes: number
  maxTransferBytes: number
  controlMaster: boolean
  controlPersist: string
  maxSessions: number
}

// Every ssh tool takes the target per call instead of reading a host from the
// configuration, so one plugin instance serves any number of machines.
export type RemoteTarget = {
  user: string
  host: string
  port: number
}

export function parseRemoteTarget(value: string, port: number | undefined): RemoteTarget {
  const at = value.indexOf("@")
  if (at <= 0) throw new Error('target must be "user@host"')
  const user = value.slice(0, at)
  const host = value.slice(at + 1)
  if (host.length === 0) throw new Error('target must be "user@host"')
  if (/[\0\r\n]/.test(value)) throw new Error("target contains a forbidden control character")
  if (host.startsWith("-")) throw new Error("target host cannot start with a dash")
  if (host.includes(":") && !/^\[[0-9A-Fa-f:.]+\]$/.test(host)) {
    throw new Error('target host cannot contain ":"; put the port in the port argument or bracket the IPv6 address')
  }
  const resolved = port ?? 22
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 65535) {
    throw new Error("port must be an integer between 1 and 65535")
  }
  return { user, host, port: resolved }
}

// The label shows up in approval patterns, so it stays stable and readable:
// the port is only displayed when it differs from the ssh default.
export function targetLabel(target: RemoteTarget): string {
  return target.port === 22 ? `${target.user}@${target.host}` : `${target.user}@${target.host}:${target.port}`
}

// The string ssh itself consumes as the destination.
export function targetArgument(target: RemoteTarget): string {
  return `${target.user}@${target.host}`
}

export function parseOptions(input: Record<string, unknown> | undefined): Options {
  const root = input?.root ?? "/"
  const sshBinary = input?.sshBinary ?? "ssh"
  const sshArgs = input?.sshArgs ?? []
  const maxOutputBytes = input?.maxOutputBytes ?? 2 * 1024 * 1024
  const maxTransferBytes = input?.maxTransferBytes ?? 256 * 1024 * 1024
  const controlMaster = input?.controlMaster ?? true
  const controlPersist = input?.controlPersist ?? "60s"
  const maxSessions = input?.maxSessions ?? 8

  if (typeof root !== "string" || !path.posix.isAbsolute(root)) {
    throw new Error("owencode: root must be an absolute remote path")
  }
  if (/[\0\r\n]/.test(root)) throw new Error("owencode: root contains a forbidden control character")
  if (typeof sshBinary !== "string" || sshBinary.length === 0) {
    throw new Error("owencode: sshBinary must be a non-empty string")
  }
  if (!Array.isArray(sshArgs) || !sshArgs.every((item) => typeof item === "string" && !/[\0\r\n]/.test(item))) {
    throw new Error("owencode: sshArgs must be an array of strings")
  }
  if (!Number.isSafeInteger(maxOutputBytes) || Number(maxOutputBytes) < 1024) {
    throw new Error("owencode: maxOutputBytes must be an integer of at least 1024")
  }
  if (!Number.isSafeInteger(maxTransferBytes) || Number(maxTransferBytes) < 1024) {
    throw new Error("owencode: maxTransferBytes must be an integer of at least 1024")
  }
  if (typeof controlMaster !== "boolean") throw new Error("owencode: controlMaster must be a boolean")
  if (typeof controlPersist !== "string" || !/^(?:\d+[smh]?|yes|no)$/.test(controlPersist)) {
    throw new Error("owencode: controlPersist must be a duration such as 60s")
  }
  // sshd defaults to MaxSessions 10 for the whole multiplexed connection, so
  // the plugin has to stay below that or concurrent calls start failing.
  if (!Number.isSafeInteger(maxSessions) || Number(maxSessions) < 1 || Number(maxSessions) > 10) {
    throw new Error("owencode: maxSessions must be an integer between 1 and 10")
  }
  return {
    root: path.posix.normalize(root),
    sshBinary,
    sshArgs,
    maxOutputBytes: Number(maxOutputBytes),
    maxTransferBytes: Number(maxTransferBytes),
    controlMaster,
    controlPersist,
    maxSessions: Number(maxSessions),
  }
}

// root is the base a relative path is resolved against, not a sandbox. Nothing
// here pretends to confine the tools: an absolute path is used as given, and
// every call still goes through the approval prompt.
export function remotePath(root: string, value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error("remote path contains a forbidden control character")
  }
  return path.posix.isAbsolute(value) ? path.posix.normalize(value) : path.posix.resolve(root, value)
}
