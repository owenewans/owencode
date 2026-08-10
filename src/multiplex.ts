import { chmodSync, mkdirSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export type MultiplexSettings = {
  enabled: boolean
  persist: string
  maxSessions: number
}

// A unix socket path cannot exceed sun_path, which is 108 bytes on Linux and
// 104 on macOS. ssh expands %C to a 40 character hash, so the directory has to
// stay well below that ceiling or the master silently fails to bind.
const SOCKET_PATH_LIMIT = 100

let cached: string | undefined | null = null

function usable(directory: string) {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const info = statSync(directory)
    if (!info.isDirectory()) return false
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) return false
    // Anyone able to write this socket gets an authenticated session on the
    // remote host without presenting a credential, so group and other bits
    // must be clear even if the directory already existed.
    if ((info.mode & 0o077) !== 0) chmodSync(directory, 0o700)
    return path.join(directory, "%C").length <= SOCKET_PATH_LIMIT
  } catch {
    return false
  }
}

export function socketDirectory(): string | undefined {
  if (cached !== null) return cached
  const candidates = [
    process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, "owencode") : undefined,
    path.join(os.tmpdir(), `owencode-${typeof process.getuid === "function" ? process.getuid() : "user"}`),
  ].filter((item): item is string => Boolean(item))
  cached = candidates.find(usable)
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
