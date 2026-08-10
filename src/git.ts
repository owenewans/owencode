import { parseCommand, renderCommand } from "./cli.js"
import { runProcess, type ProcessResult } from "./process.js"

export type GitRunOptions = {
  binary: string
  args: string[]
  cwd: string
  stdin?: string
  signal?: AbortSignal
  timeout?: number
  maxOutputBytes: number
}

export function validateGitArgs(args: string[]) {
  if (args.length === 0) throw new Error("git requires at least one argument")
}

export function parseGitCommand(command: string) {
  const args = parseCommand(command, "git", "git")
  validateGitArgs(args)
  return args
}

export function renderGitCommand(args: string[]) {
  return renderCommand("git", args)
}

export async function runGit(options: GitRunOptions): Promise<ProcessResult> {
  validateGitArgs(options.args)
  // Git is run with no argument restrictions: whatever is approved is what runs,
  // including -c overrides that execute code. The full command is rendered into
  // the approval prompt, so the decision is made there rather than here.
  // GIT_TERMINAL_PROMPT stays off only because there is no terminal to prompt
  // on, and git would otherwise block until the tool timed out.
  return runProcess({
    label: "Git",
    ...options,
    input: options.stdin,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  })
}
