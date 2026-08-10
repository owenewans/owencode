import { chmodSync, lstatSync, mkdirSync, mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export type MultiplexSettings = {
  enabled: boolean
  persist: string
  maxSessions: number
}

// A unix socket path cannot exceed sun_path: 108 bytes on Linux, 104 on macOS,
// including the terminating NUL. ssh expands %C to a 40 character hash, so the
// expansion has to be measured, not the two character placeholder.
const SOCKET_PATH_LIMIT = process.platform === "darwin" ? 103 : 107
const EXPANDED = "0".repeat(40)

function fits(directory: string) {
  return Buffer.byteLength(path.join(directory, EXPANDED)) <= SOCKET_PATH_LIMIT
}

let cached: string | undefined | null = null

// $XDG_RUNTIME_DIR is created by the system for this user alone, so a directory
// underneath it cannot be pre-created by anyone else.
function runtimeDirectory(base: string) {
  const directory = path.join(base, "owencode")
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    // lstat, not stat: a symlink planted here must be rejected rather than
    // followed, because whoever can write the control socket gets an
    // authenticated session on the remote host without presenting a credential.
    const info = lstatSync(directory)
    if (!info.isDirectory()) return undefined
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) return undefined
    if ((info.mode & 0o077) !== 0) chmodSync(directory, 0o700)
    return fits(directory) ? directory : undefined
  } catch {
    return undefined
  }
}

// The fallback lives in a world writable /tmp, where a predictable name can be
// pre-created as a symlink by any local user. mkdtemp creates the directory
// atomically under a name nobody can guess, so there is nothing to hijack.
function temporaryDirectory() {
  try {
    const directory = mkdtempSync(path.join(os.tmpdir(), "owencode-"))
    chmodSync(directory, 0o700)
    return fits(directory) ? directory : undefined
  } catch {
    return undefined
  }
}

export function socketDirectory(): string | undefined {
  if (cached !== null) return cached
  const base = process.env.XDG_RUNTIME_DIR
  cached = (base ? runtimeDirectory(base) : undefined) ?? temporaryDirectory()
  return cached
}

export function resetSocketDirectory() {
  cached = null
}

export function controlArgs(settings: MultiplexSettings, directory: string | null | undefined = socketDirectory()) {
  if (!settings.enabled || !directory) return []
  return [
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${path.join(directory, "%C")}`,
    "-o",
    `ControlPersist=${settings.persist}`,
  ]
}

// Long lived forwards must not share a multiplexed connection: the master can
// expire or die while the forward is still expected to be up, and a single
// broken connection would take every tunnel down with it.
export function noControlArgs() {
  return ["-o", "ControlMaster=no", "-o", "ControlPath=none"]
}

export class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly limit: number) {}

  get pending() {
    return this.queue.length
  }

  get inFlight() {
    return this.active
  }

  async acquire(): Promise<() => void> {
    // The slot is handed straight to the next waiter on release instead of
    // being freed and re-taken, otherwise a caller arriving between the
    // release and the waiter resuming could steal it and exceed the limit.
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.queue.push(resolve))
    else this.active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.queue.shift()
      if (next) next()
      else this.active -= 1
    }
  }
}
