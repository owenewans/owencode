import { spawn } from "node:child_process"

export type ProcessResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type ProcessRunOptions = {
  label: string
  binary: string
  args: string[]
  cwd: string
  input?: string | Buffer
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeout?: number
  maxOutputBytes: number
}

export async function runProcess(options: ProcessRunOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) throw new Error(`${options.label} operation aborted`)

  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32"
    const child = spawn(options.binary, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
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
    const abort = () => stop(new Error(`${options.label} operation aborted`))
    const timer = options.timeout
      ? setTimeout(() => stop(new Error(`${options.label} operation timed out after ${options.timeout}ms`)), options.timeout)
      : undefined

    options.signal?.addEventListener("abort", abort, { once: true })
    child.on("error", stop)
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > options.maxOutputBytes) {
        return stop(new Error(`${options.label} output exceeded ${options.maxOutputBytes} bytes`))
      }
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
    child.stdin.end(options.input)
  })
}
