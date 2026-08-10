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
  if (args.some((arg) => /[\0\r\n]/.test(arg))) throw new Error("git arguments cannot contain control characters")
  if (args.some((arg) => arg === "credential" || arg.startsWith("credential-"))) {
    throw new Error("git credential commands are blocked to keep credentials out of model context")
  }
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument.startsWith("--config-env")) {
      throw new Error("git --config-env is blocked because it hides configuration from the approval prompt")
    }
    const value = argument === "-c" ? args[index + 1] : argument.startsWith("-c") ? argument.slice(2) : undefined
    if (!value) continue
    if (/^(?:credential\.|http\..*\.extraheader)/i.test(value)) {
      throw new Error("git credential configuration is blocked to keep credentials out of model context")
    }
    if (/^alias\./i.test(value)) {
      throw new Error("git alias configuration is blocked because it hides the executed command from the approval prompt")
    }
  }
}

export function parseGitCommand(command: string) {
  const args = parseCommand(command, "git", "git")
  validateGitArgs(args)
  return args
}

export function renderGitCommand(args: string[]) {
  return renderCommand("git", args)
}

export function redactGitOutput(output: string) {
  return output
    .replace(/\b(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1[redacted]@")
    .replace(/(authorization\s*[:=]\s*)(?:basic|bearer)\s+\S+/gi, "$1[redacted]")
    .replace(/^(password|username)=.*$/gim, "$1=[redacted]")
}

export async function runGit(options: GitRunOptions): Promise<ProcessResult> {
  validateGitArgs(options.args)
  const result = await runProcess({
    label: "Git",
    ...options,
    input: options.stdin,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  })
  return { ...result, stdout: redactGitOutput(result.stdout), stderr: redactGitOutput(result.stderr) }
}
