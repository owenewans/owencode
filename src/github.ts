import { parseCommand, renderCommand } from "./cli.js"
import { runProcess, type ProcessResult } from "./process.js"

export type GhResult = ProcessResult

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

export function parseGhCommand(command: string) {
  const args = parseCommand(command, "gh", "gh")
  validateGhArgs(args)
  return args
}

export function renderGhCommand(args: string[]) {
  return renderCommand("gh", args)
}

export async function runGh(options: GhRunOptions): Promise<GhResult> {
  validateGhArgs(options.args)
  return runProcess({
    label: "GitHub",
    ...options,
    input: options.stdin,
  })
}
