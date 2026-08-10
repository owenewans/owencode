import path from "node:path"

export type Options = {
  host: string
  root: string
  sshBinary: string
  sshArgs: string[]
  maxOutputBytes: number
  maxTransferBytes: number
  controlMaster: boolean
  controlPersist: string
  maxSessions: number
}

export function parseOptions(input: Record<string, unknown> | undefined): Options {
  const host = input?.host
  const root = input?.root
  const sshBinary = input?.sshBinary ?? "ssh"
  const sshArgs = input?.sshArgs ?? []
  const maxOutputBytes = input?.maxOutputBytes ?? 2 * 1024 * 1024
  const maxTransferBytes = input?.maxTransferBytes ?? 256 * 1024 * 1024
  const controlMaster = input?.controlMaster ?? true
  const controlPersist = input?.controlPersist ?? "60s"
  const maxSessions = input?.maxSessions ?? 8

  if (typeof host !== "string" || host.length === 0) throw new Error("owencode: host is required")
  if (/[\0\r\n]/.test(host)) throw new Error("owencode: host contains a forbidden control character")
  if (host.startsWith("-")) throw new Error("owencode: host cannot start with a dash")
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
    host,
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

export function remotePath(root: string, value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error("remote path contains a forbidden control character")
  }

  const resolved = path.posix.isAbsolute(value) ? path.posix.normalize(value) : path.posix.resolve(root, value)
  if (root !== "/" && resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`remote path escapes configured root: ${value}`)
  }
  return resolved
}
