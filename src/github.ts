import { spawn } from "node:child_process"

export type GhResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type GhRunOptions = {
  binary: string
  args: string[]
  cwd: string
  stdin?: string
  signal?: AbortSignal
  timeout?: number
  maxOutputBytes: number
}

export function validateGhArgs(args: string[]) {
  if (args.length === 0) throw new Error("gh requires at least one argument")
  if (args.some((arg) => /[\0\r\n]/.test(arg))) throw new Error("gh arguments cannot contain control characters")
  if (args.some((arg, index) => arg === "auth" && args[index + 1] === "token")) {
    throw new Error("gh auth token is blocked to keep credentials out of model context")
  }
  const authStatus = args.some((arg, index) => arg === "auth" && args[index + 1] === "status")
  if (authStatus && args.some((arg) => arg === "-t" || arg === "--show-token" || arg.startsWith("--show-token="))) {
    throw new Error("showing GitHub authentication tokens is blocked")
  }
}

export function renderGhCommand(args: string[]) {
  return `gh ${args.map((arg) => (/[\s'"\\]/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`
}

export async function runGh(options: GhRunOptions): Promise<GhResult> {
  validateGhArgs(options.args)
  if (options.signal?.aborted) throw new Error("GitHub operation aborted")

  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32"
    const child = spawn(options.binary, options.args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: grouped,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let settled = false
    let failure: Error | undefined
    let killTimer: NodeJS.Timeout | undefined

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener("abort", abort)
    }
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
      kill("SIGTERM")
      killTimer = setTimeout(() => kill("SIGKILL"), 1000)
    }
    const abort = () => stop(new Error("GitHub operation aborted"))
    const timer = options.timeout
      ? setTimeout(() => stop(new Error(`GitHub operation timed out after ${options.timeout}ms`)), options.timeout)
      : undefined

    options.signal?.addEventListener("abort", abort, { once: true })
    child.on("error", stop)
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > options.maxOutputBytes) return stop(new Error(`GitHub output exceeded ${options.maxOutputBytes} bytes`))
      target.push(chunk)
    }
    child.stdout.on("data", collect(stdout))
    child.stderr.on("data", collect(stderr))
    child.on("close", (code) => {
      if (settled) return
      settled = true
      cleanup()
      if (failure) return reject(failure)
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      })
    })
    child.stdin.on("error", (error) => stop(error))
    child.stdin.end(options.stdin)
  })
}
