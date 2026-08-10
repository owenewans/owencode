import { spawn, type StdioOptions } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import type { Readable, Writable } from "node:stream"
import { controlArgs, Semaphore, type MultiplexSettings } from "./multiplex.js"
import { shellQuote } from "./ssh.js"

export type TransferDirection = "upload" | "download"

export type TransferTransport = {
  sshBinary: string
  sshArgs: string[]
  host: string
  root: string
  tarBinary: string
  maxTransferBytes: number
  multiplex: MultiplexSettings
  sessions: Semaphore
}

export type TransferRequest = {
  direction: TransferDirection
  localPath: string
  remotePath: string
  recursive: boolean
  overwrite: boolean
  signal?: AbortSignal
  timeout?: number
}

export type TransferResult = {
  bytes: number
  mode?: number
  kind: "file" | "directory"
}

export type RemoteEntry = {
  kind: "file" | "directory" | "missing" | "other"
  size: number
  mode: number
}

type StreamOptions = {
  transport: TransferTransport
  command: string
  source?: Readable
  destination?: Writable
  maxBytes: number
  signal?: AbortSignal
  timeout?: number
}

type StreamResult = {
  bytes: number
  exitCode: number
  stdout: Buffer
  stderr: string
}

// A dangling symlink is not "missing": replacing it would still clobber a name
// the caller can see, so existence is tested with -e or -L everywhere.
const EXISTS = (variable: string) => `{ [ -e "${variable}" ] || [ -L "${variable}" ]; }`

function remoteCommand(script: string, args: string[]) {
  return `sh -c ${shellQuote(script)} sh ${args.map(shellQuote).join(" ")}`
}

function stagingPath(target: string, kind = "staging") {
  return `${target}.owencode-${kind}-${process.pid}-${randomBytes(6).toString("hex")}`
}

// Rename the old tree aside instead of deleting it, so a failure between the
// two renames leaves a complete copy rather than nothing at all.
async function install(staging: string, destination: string, replacing: boolean) {
  const backup = replacing ? stagingPath(destination, "backup") : undefined
  if (backup) await rename(destination, backup)
  try {
    await rename(staging, destination)
  } catch (error) {
    if (backup) await rename(backup, destination).catch(() => undefined)
    throw error
  }
  if (backup) await rm(backup, { recursive: true, force: true }).catch(() => undefined)
}

export function localTransferPath(directory: string, value: string) {
  if (/[\0\r\n]/.test(value)) throw new Error("local path contains a forbidden control character")
  return path.resolve(directory, value)
}

type TarProcess = ReturnType<typeof spawnTar>

function spawnTar(binary: string, args: string[], stdio: StdioOptions) {
  const child = spawn(binary, args, { stdio })
  const errors: Buffer[] = []
  let errorBytes = 0
  child.stderr?.on("data", (chunk: Buffer) => {
    errorBytes += chunk.length
    if (errorBytes > 64 * 1024) return
    errors.push(chunk)
  })
  const outcome = new Promise<{ code: number; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: -1, error }))
    child.once("close", (code) => resolve({ code: code ?? 1 }))
  })
  return {
    child,
    outcome,
    async settle(label: string) {
      const result = await outcome
      if (result.error) throw new Error(`${label}: ${result.error.message}`)
      if (result.code !== 0) throw new Error(errors.length ? Buffer.concat(errors).toString("utf8").trim() : `${label} exited with code ${result.code}`)
    },
    stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    },
  }
}

async function sshStream(options: StreamOptions): Promise<StreamResult> {
  const release = await options.transport.sessions.acquire()
  try {
    return await spawnStream(options)
  } finally {
    release()
  }
}

function spawnStream(options: StreamOptions): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error("SSH transfer aborted"))
    const grouped = process.platform !== "win32"
    const child = spawn(
      options.transport.sshBinary,
      [
        ...options.transport.sshArgs,
        ...controlArgs(options.transport.multiplex),
        options.transport.host,
        options.command,
      ],
      { stdio: ["pipe", "pipe", "pipe"], detached: grouped },
    )

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let stderrBytes = 0
    let settled = false
    let failure: Error | undefined
    let killTimer: NodeJS.Timeout | undefined
    let pending = 1

    const kill = (signal: NodeJS.Signals) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        // The process may have exited between the event and the signal.
      }
    }
    const stop = (error: Error) => {
      if (settled || failure) return
      failure = error
      options.source?.destroy?.()
      kill("SIGTERM")
      killTimer = setTimeout(() => kill("SIGKILL"), 1000)
    }
    const abort = () => stop(new Error("SSH transfer aborted"))
    const timer = options.timeout
      ? setTimeout(() => stop(new Error(`SSH transfer timed out after ${options.timeout}ms`)), options.timeout)
      : undefined
    const finish = () => {
      pending -= 1
      if (pending > 0 || settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener("abort", abort)
      options.source?.destroy?.()
      if (failure) return reject(failure)
      resolve({
        bytes,
        exitCode: child.exitCode ?? 255,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      })
    }

    options.signal?.addEventListener("abort", abort, { once: true })
    child.on("error", stop)
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stop(error)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > 64 * 1024) return
      stderr.push(chunk)
    })

    const count = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > options.maxBytes) stop(new Error(`transfer exceeded ${options.maxBytes} bytes`))
    }

    if (options.source) {
      options.source.on("data", count)
      options.source.on("error", stop)
      options.source.pipe(child.stdin)
    } else {
      child.stdin.end()
    }

    if (options.destination) {
      pending += 1
      const destination = options.destination
      destination.on("error", stop)
      destination.on("close", finish)
      child.stdout.on("data", count)
      child.stdout.pipe(destination)
    } else {
      child.stdout.on("data", (chunk: Buffer) => {
        count(chunk)
        if (!failure) stdout.push(chunk)
      })
    }

    child.on("close", finish)
  })
}

export async function probeRemote(transport: TransferTransport, remotePath: string, signal?: AbortSignal): Promise<RemoteEntry> {
  const script = [
    "set -eu",
    'if [ -d "$1" ]; then printf "directory 0 %s\\n" "$(stat -c %a -- "$1")"',
    'elif [ -f "$1" ]; then printf "file %s %s\\n" "$(stat -c %s -- "$1")" "$(stat -c %a -- "$1")"',
    'elif [ -e "$1" ] || [ -L "$1" ]; then printf "other 0 0\\n"',
    'else printf "missing 0 0\\n"',
    "fi",
  ].join("\n")
  const result = await sshStream({
    transport,
    command: remoteCommand(script, [remotePath]),
    maxBytes: 4096,
    signal,
    timeout: 60_000,
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `failed to inspect ${remotePath}`)
  const [kind, size, mode] = result.stdout.toString("utf8").trim().split(" ")
  return {
    kind: kind === "file" || kind === "directory" || kind === "other" ? kind : "missing",
    size: Number.parseInt(size ?? "0", 10) || 0,
    mode: Number.parseInt(mode ?? "0", 8) || 0,
  }
}

function uploadFileScript() {
  return [
    "set -eu",
    'destination="$1"; overwrite="$2"; parent="$3"; staging="$4"; mode="$5"; size="$6"',
    `if [ "$overwrite" != "1" ] && ${EXISTS("$destination")}; then`,
    '  printf "remote path already exists: %s\\n" "$destination" >&2; exit 73',
    "fi",
    'if [ -d "$destination" ]; then printf "remote path is a directory: %s\\n" "$destination" >&2; exit 73; fi',
    'mkdir -p -- "$parent"',
    "umask 077",
    "trap 'rm -f -- \"$staging\"' EXIT HUP INT TERM",
    'cat > "$staging"',
    'received=$(stat -c %s -- "$staging")',
    '[ "$received" = "$size" ] || { printf "upload truncated: expected %s bytes, stored %s\\n" "$size" "$received" >&2; exit 75; }',
    'chmod "$mode" -- "$staging"',
    // -T keeps a directory that appeared at the destination from swallowing the
    // upload and reporting success.
    'mv -fT -- "$staging" "$destination"',
    "trap - EXIT HUP INT TERM",
  ].join("\n")
}

function uploadDirectoryScript() {
  return [
    "set -eu",
    'destination="$1"; overwrite="$2"; staging="$3"; parent="$4"; backup="$5"',
    `if [ "$overwrite" != "1" ] && ${EXISTS("$destination")}; then`,
    '  printf "remote path already exists: %s\\n" "$destination" >&2; exit 73',
    "fi",
    `if ${EXISTS("$destination")} && [ ! -d "$destination" ]; then`,
    '  printf "remote path is not a directory: %s\\n" "$destination" >&2; exit 73',
    "fi",
    'mkdir -p -- "$parent"',
    "umask 077",
    'rm -rf -- "$staging" "$backup"',
    'mkdir -- "$staging"',
    "trap 'rm -rf -- \"$staging\"' EXIT HUP INT TERM",
    'tar -xf - -C "$staging"',
    // The previous tree is renamed aside rather than deleted, so an interrupted
    // replacement can still be rolled back instead of losing both copies.
    "saved=0",
    `if ${EXISTS("$destination")}; then`,
    '  mv -T -- "$destination" "$backup"',
    "  saved=1",
    "fi",
    'if mv -T -- "$staging" "$destination"; then',
    '  if [ "$saved" = "1" ]; then rm -rf -- "$backup"; fi',
    "  trap - EXIT HUP INT TERM",
    "else",
    '  if [ "$saved" = "1" ]; then mv -T -- "$backup" "$destination"; fi',
    '  printf "failed to install the uploaded directory; the previous contents were restored\\n" >&2',
    "  exit 76",
    "fi",
  ].join("\n")
}

function downloadFileScript() {
  return ["set -eu", 'test -f "$1" || { printf "remote file not found: %s\\n" "$1" >&2; exit 44; }', 'exec cat -- "$1"'].join("\n")
}

function downloadDirectoryScript() {
  return [
    "set -eu",
    'test -d "$1" || { printf "remote directory not found: %s\\n" "$1" >&2; exit 44; }',
    'exec tar -cf - -C "$1" .',
  ].join("\n")
}

async function localEntry(localPath: string) {
  try {
    return await stat(localPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function withTar<T>(tar: TarProcess, label: string, body: () => Promise<T>): Promise<T> {
  try {
    const value = await body()
    await tar.settle(label)
    return value
  } catch (error) {
    tar.stop()
    await tar.outcome
    throw error
  }
}

async function upload(transport: TransferTransport, request: TransferRequest): Promise<TransferResult> {
  const entry = await localEntry(request.localPath)
  if (!entry) throw new Error(`local path not found: ${request.localPath}`)
  const overwrite = request.overwrite ? "1" : "0"

  if (entry.isDirectory()) {
    if (!request.recursive) throw new Error("local path is a directory; set recursive to transfer it")
    const tar = spawnTar(transport.tarBinary, ["-cf", "-", "-C", request.localPath, "."], ["ignore", "pipe", "pipe"])
    return withTar(tar, "local tar", async () => {
      const result = await sshStream({
        transport,
        command: remoteCommand(uploadDirectoryScript(), [
          request.remotePath,
          overwrite,
          stagingPath(request.remotePath),
          path.posix.dirname(request.remotePath),
          stagingPath(request.remotePath, "backup"),
        ]),
        source: tar.child.stdout!,
        maxBytes: transport.maxTransferBytes,
        signal: request.signal,
        timeout: request.timeout,
      })
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "remote upload failed")
      return { bytes: result.bytes, kind: "directory" as const }
    })
  }

  if (!entry.isFile()) throw new Error(`local path is not a regular file: ${request.localPath}`)
  if (entry.size > transport.maxTransferBytes) {
    throw new Error(`local file is ${entry.size} bytes, above the ${transport.maxTransferBytes} byte limit`)
  }
  const mode = (entry.mode & 0o777).toString(8).padStart(3, "0")
  const result = await sshStream({
    transport,
    command: remoteCommand(uploadFileScript(), [
      request.remotePath,
      overwrite,
      path.posix.dirname(request.remotePath),
      stagingPath(request.remotePath),
      mode,
      String(entry.size),
    ]),
    source: createReadStream(request.localPath),
    maxBytes: transport.maxTransferBytes,
    signal: request.signal,
    timeout: request.timeout,
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `failed to upload ${request.localPath}`)
  return { bytes: result.bytes, mode: entry.mode & 0o777, kind: "file" }
}

async function download(transport: TransferTransport, request: TransferRequest): Promise<TransferResult> {
  const remote = await probeRemote(transport, request.remotePath, request.signal)
  if (remote.kind === "missing") throw new Error(`remote path not found: ${request.remotePath}`)
  if (remote.kind === "other") throw new Error(`remote path is not a regular file or directory: ${request.remotePath}`)

  const existing = await localEntry(request.localPath)
  if (existing && !request.overwrite) throw new Error(`local path already exists: ${request.localPath}`)

  if (remote.kind === "directory") {
    if (!request.recursive) throw new Error("remote path is a directory; set recursive to transfer it")
    if (existing && !existing.isDirectory()) throw new Error(`local path is not a directory: ${request.localPath}`)
    const staging = stagingPath(request.localPath)
    await mkdir(staging, { recursive: true, mode: 0o700 })
    try {
      const tar = spawnTar(transport.tarBinary, ["-xf", "-", "-C", staging], ["pipe", "ignore", "pipe"])
      const result = await withTar(tar, "local tar", async () => {
        const stream = await sshStream({
          transport,
          command: remoteCommand(downloadDirectoryScript(), [request.remotePath]),
          destination: tar.child.stdin!,
          maxBytes: transport.maxTransferBytes,
          signal: request.signal,
          timeout: request.timeout,
        })
        if (stream.exitCode !== 0) throw new Error(stream.stderr.trim() || "remote download failed")
        return stream
      })
      await install(staging, request.localPath, Boolean(existing))
      return { bytes: result.bytes, kind: "directory" }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  if (remote.size > transport.maxTransferBytes) {
    throw new Error(`remote file is ${remote.size} bytes, above the ${transport.maxTransferBytes} byte limit`)
  }
  if (existing && existing.isDirectory()) throw new Error(`local path is a directory: ${request.localPath}`)
  await mkdir(path.dirname(request.localPath), { recursive: true })
  const temporary = stagingPath(request.localPath)
  try {
    const result = await sshStream({
      transport,
      command: remoteCommand(downloadFileScript(), [request.remotePath]),
      destination: createWriteStream(temporary, { mode: 0o600 }),
      maxBytes: transport.maxTransferBytes,
      signal: request.signal,
      timeout: request.timeout,
    })
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `failed to download ${request.remotePath}`)
    if (result.bytes !== remote.size) {
      throw new Error(`download truncated: expected ${remote.size} bytes, received ${result.bytes}`)
    }
    await chmod(temporary, remote.mode & 0o111 ? 0o700 : 0o600)
    await rename(temporary, request.localPath)
    return { bytes: result.bytes, mode: remote.mode, kind: "file" }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function transfer(transport: TransferTransport, request: TransferRequest): Promise<TransferResult> {
  return request.direction === "upload" ? upload(transport, request) : download(transport, request)
}
