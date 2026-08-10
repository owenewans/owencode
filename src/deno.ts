import { createHash, randomBytes } from "node:crypto"
import { runProcess, type ProcessResult } from "./process.js"
import { shellQuote } from "./ssh.js"

export type DenoRunOptions = {
  binary: string
  code: string
  args?: string[]
  cwd: string
  signal?: AbortSignal
  timeout?: number
  maxOutputBytes: number
}

export function denoArguments(args: string[] = []) {
  if (args.some((arg) => /[\0\r\n]/.test(arg))) throw new Error("Deno script arguments cannot contain control characters")
  return denoFileArguments("-", args)
}

export function denoFileArguments(file: string, args: string[] = []) {
  if (args.some((arg) => /[\0\r\n]/.test(arg))) throw new Error("Deno script arguments cannot contain control characters")
  return [
    "run",
    "--allow-all",
    "--allow-scripts",
    "--quiet",
    "--no-prompt",
    "--no-lock",
    "--ext=ts",
    file,
    ...args,
  ]
}

export function remoteDenoJob(
  binary: string,
  workdir: string,
  args: string[] = [],
  timeoutMs = 120_000,
  token = randomBytes(12).toString("hex"),
) {
  denoFileArguments("remote.ts", args)
  const state = `/tmp/owencode-deno-${token}`
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  const supervisor = [
    "set -eu",
    'workdir="$1"',
    'deno="$2"',
    'state="$3"',
    'limit="$4"',
    "shift 4",
    "umask 077",
    'mkdir -- "$state"',
    'cd -- "$workdir"',
    'temporary=$(mktemp "$workdir/.owencode-deno.XXXXXX.ts")',
    'printf "%s\\n" "$temporary" > "$state/temporary"',
    'child=""',
    "cleanup() {",
    "  status=$?",
    "  trap - EXIT HUP INT TERM",
    '  if [ -n "$child" ]; then',
    '    kill -TERM -- "-$child" 2>/dev/null || true',
    "    sleep 0.2",
    '    kill -KILL -- "-$child" 2>/dev/null || true',
    "  fi",
    '  rm -f -- "$temporary"',
    '  rm -f -- "$state/pid" "$state/temporary"',
    '  rmdir -- "$state" 2>/dev/null || true',
    '  exit "$status"',
    "}",
    "trap cleanup EXIT HUP INT TERM",
    'cat > "$temporary"',
    'setsid timeout --signal=TERM --kill-after=1s "$limit" env NO_COLOR=1 DENO_NO_UPDATE_CHECK=1 DENO_NO_PROMPT=1 "$deno" run --allow-all --allow-scripts --quiet --no-prompt --no-lock --ext=ts "$temporary" "$@" &',
    "child=$!",
    'printf "%s\\n" "$child" > "$state/pid"',
    'wait "$child"',
  ].join("\n")
  const cleanup = [
    "set -u",
    'state="$1"',
    'workdir="$2"',
    'if [ -f "$state/pid" ]; then',
    '  pid=$(cat -- "$state/pid")',
    '  case "$pid" in *[!0-9]*|"") ;; *)',
    '    kill -TERM -- "-$pid" 2>/dev/null || true',
    "    sleep 0.2",
    '    kill -KILL -- "-$pid" 2>/dev/null || true',
    "  ;; esac",
    "fi",
    'if [ -f "$state/temporary" ]; then',
    '  temporary=$(cat -- "$state/temporary")',
    '  case "$temporary" in "$workdir"/.owencode-deno.*.ts) rm -f -- "$temporary";; esac',
    "fi",
    'rm -f -- "$state/pid" "$state/temporary"',
    'rmdir -- "$state" 2>/dev/null || true',
  ].join("\n")
  return {
    command: `sh -c ${shellQuote(supervisor)} sh ${[workdir, binary, state, `${timeoutSeconds}s`, ...args].map(shellQuote).join(" ")}`,
    cleanupCommand: `sh -c ${shellQuote(cleanup)} sh ${[state, workdir].map(shellQuote).join(" ")}`,
    state,
  }
}

export function denoEnvironment() {
  return {
    ...process.env,
    NO_COLOR: "1",
    DENO_NO_UPDATE_CHECK: "1",
    DENO_NO_PROMPT: "1",
  }
}

export function denoExecutionHash(code: string, args: string[] = []) {
  return createHash("sha256").update(JSON.stringify({ code, args })).digest("hex")
}

export async function runDeno(options: DenoRunOptions): Promise<ProcessResult> {
  if (!options.code.trim()) throw new Error("Deno source code is required")
  return runProcess({
    label: "Deno",
    binary: options.binary,
    args: denoArguments(options.args),
    cwd: options.cwd,
    input: options.code,
    env: denoEnvironment(),
    signal: options.signal,
    timeout: options.timeout,
    maxOutputBytes: options.maxOutputBytes,
  })
}
