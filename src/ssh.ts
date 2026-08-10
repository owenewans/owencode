import { createHash, randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import path from "node:path"
import type { Options } from "./config.js"

export type RunOptions = {
  input?: string | Buffer
  signal?: AbortSignal
  timeout?: number
  maxOutputBytes?: number
}

export type RunResult = {
  stdout: Buffer
  stderr: string
  exitCode: number
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex")
}

export class SshClient {
  constructor(private readonly options: Options) {}

  async run(command: string, options: RunOptions = {}): Promise<RunResult> {
    if (options.signal?.aborted) throw new Error("SSH operation aborted")
    const limit = options.maxOutputBytes ?? this.options.maxOutputBytes
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.sshBinary, [...this.options.sshArgs, this.options.host, command], {
        stdio: ["pipe", "pipe", "pipe"],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false

      const stop = (error: Error) => {
        if (settled) return
        settled = true
        child.kill("SIGTERM")
        reject(error)
      }
      const abort = () => stop(new Error("SSH operation aborted"))
      const timer = options.timeout
        ? setTimeout(() => stop(new Error(`SSH operation timed out after ${options.timeout}ms`)), options.timeout)
        : undefined

      options.signal?.addEventListener("abort", abort, { once: true })
      child.on("error", stop)
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length
        if (stdoutBytes > limit) return stop(new Error(`SSH stdout exceeded ${limit} bytes`))
        stdout.push(chunk)
      })
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length
        if (stderrBytes > limit) return stop(new Error(`SSH stderr exceeded ${limit} bytes`))
        stderr.push(chunk)
      })
      child.on("close", (code) => {
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener("abort", abort)
        if (settled) return
        settled = true
        resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: code ?? 255 })
      })

      if (options.input !== undefined) child.stdin.end(options.input)
      else child.stdin.end()
    })
  }

  async script(script: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    const command = `sh -s -- ${args.map(shellQuote).join(" ")}`
    return this.run(command, { ...options, input: script })
  }

  private guardScript(targetVariable = "$target") {
    return [
      `case ${shellQuote(this.options.root)} in /) ;; *)`,
      `  root=$(realpath -m -- ${shellQuote(this.options.root)})`,
      `  target=$(realpath -m -- "${targetVariable}")`,
      `  case "$target" in "$root"|"$root"/*) ;; *) printf "remote path resolves outside configured root: %s\\n" "${targetVariable}" >&2; exit 77;; esac`,
      ";; esac",
    ].join("\n")
  }

  async textFile(filePath: string, signal?: AbortSignal): Promise<string> {
    const result = await this.script(
      `${this.guardScript("$1")}\ntest -f "$1" || { printf "not a regular file: %s\\n" "$1" >&2; exit 44; }\ncat -- "$1"\n`,
      [filePath],
      { signal },
    )
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `failed to read ${filePath}`)
    return result.stdout.toString("utf8")
  }

  async guardPath(root: string, filePath: string, signal?: AbortSignal) {
    const script = [
      "set -eu",
      'root=$(realpath -m -- "$1")',
      'target=$(realpath -m -- "$2")',
      'case "$root" in /) exit 0;; esac',
      'case "$target" in "$root"|"$root"/*) exit 0;; esac',
      'printf "remote path resolves outside configured root: %s\\n" "$2" >&2',
      "exit 77",
    ].join("\n")
    const result = await this.script(script, [root, filePath], { signal })
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `remote path escaped ${root}`)
  }

  async writeFile(filePath: string, content: string, expectedHash: string | undefined, signal?: AbortSignal) {
    const parent = path.posix.dirname(filePath)
    const temporary = `${filePath}.owencode-${process.pid}-${randomBytes(6).toString("hex")}`
    const expected = expectedHash ?? "-"
    const script = [
      "set -eu",
      'destination="$1"',
      'parent="$2"',
      'temporary="$3"',
      'expected="$4"',
      this.guardScript("$destination"),
      'mkdir -p -- "$parent"',
      'if [ "$expected" = "missing" ] && [ -e "$destination" ]; then echo "remote file already exists" >&2; exit 73; fi',
      'if [ "$expected" != "-" ] && [ "$expected" != "missing" ]; then',
      '  actual=$(sha256sum -- "$destination" 2>/dev/null | cut -d " " -f 1 || true)',
      '  [ "$actual" = "$expected" ] || { echo "remote file changed after it was read" >&2; exit 74; }',
      "fi",
      "umask 077",
      "trap 'rm -f -- \"$temporary\"' EXIT HUP INT TERM",
      'cat > "$temporary"',
      'if [ -e "$destination" ]; then chmod --reference="$destination" -- "$temporary" 2>/dev/null || true; fi',
      'mv -f -- "$temporary" "$destination"',
      'trap - EXIT HUP INT TERM',
    ].join("\n")
    const command = `sh -c ${shellQuote(script)} sh ${[filePath, parent, temporary, expected].map(shellQuote).join(" ")}`
    const result = await this.run(command, { input: content, signal })
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `failed to write ${filePath}`)
  }

  async deleteFile(filePath: string, expectedHash: string, signal?: AbortSignal) {
    const script = [
      "set -eu",
      'target="$1"',
      this.guardScript("$target"),
      'actual=$(sha256sum -- "$1" 2>/dev/null | cut -d " " -f 1 || true)',
      '[ "$actual" = "$2" ] || { echo "remote file changed after it was read" >&2; exit 74; }',
      'rm -- "$1"',
    ].join("\n")
    const result = await this.script(script, [filePath, expectedHash], { signal })
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `failed to delete ${filePath}`)
  }
}
