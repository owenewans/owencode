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
