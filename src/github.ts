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
  if (/\0|\r|\n/.test(command)) throw new Error("gh command cannot contain control characters")
  const args: string[] = []
  let value = ""
  let quote: "single" | "double" | undefined
  let escaped = false
  let started = false

  const flush = () => {
    if (!started) return
    args.push(value)
    value = ""
    started = false
  }
  for (const character of command.trim()) {
    if (escaped) {
      value += character
      escaped = false
      started = true
      continue
    }
    if (character === "\\" && quote !== "single") {
      escaped = true
      started = true
      continue
    }
    if (quote === "single") {
      if (character === "'") quote = undefined
      else value += character
      continue
    }
    if (quote === "double") {
      if (character === '"') quote = undefined
      else value += character
      continue
    }
    if (character === "'") {
      quote = "single"
      started = true
    } else if (character === '"') {
      quote = "double"
      started = true
    } else if (/\s/.test(character)) flush()
    else {
      value += character
      started = true
    }
  }
  if (escaped || quote) throw new Error("gh command contains an unterminated quote or escape")
  flush()
  if (args[0] === "gh") throw new Error("pass gh arguments without the leading gh")
  validateGhArgs(args)
  return args
}

export function renderGhCommand(args: string[]) {
  return `gh ${args.map((arg) => (/[\s'"\\]/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`
}

export async function runGh(options: GhRunOptions): Promise<GhResult> {
  validateGhArgs(options.args)
  return runProcess({
    label: "GitHub",
    ...options,
    input: options.stdin,
  })
}
