import { createHash, randomBytes } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runProcess, type ProcessResult } from "./process.js"
import { shellQuote } from "./ssh.js"

export type NodeRunOptions = {
  binary: string
  code: string
  args?: string[]
  cwd: string
  signal?: AbortSignal
  timeout?: number
  maxOutputBytes: number
}

export function nodeFileArguments(file: string, args: string[] = []) {
  if (args.some((arg) => /[\0\r\n]/.test(arg))) throw new Error("Node script arguments cannot contain control characters")
  return ["--experimental-strip-types", "--no-warnings", file, ...args]
}

export function remoteNodeJob(
  binary: string,
  workdir: string,
  args: string[] = [],
  timeoutMs = 120_000,
  token = randomBytes(12).toString("hex"),
) {
  const state = `/tmp/owencode-node-${token}`
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  const supervisor = [
    "set -eu",
    'workdir="$1"',
    'node="$2"',
    'state="$3"',
    'limit="$4"',
    "shift 4",
    "umask 077",
    'mkdir -- "$state"',
    'cd -- "$workdir"',
    'temporary=$(mktemp "$workdir/.owencode-node.XXXXXX.ts")',
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
    'setsid timeout --signal=TERM --kill-after=1s "$limit" env NO_COLOR=1 NODE_NO_WARNINGS=1 "$node" --experimental-strip-types --no-warnings "$temporary" "$@" &',
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
    '  case "$temporary" in "$workdir"/.owencode-node.*.ts) rm -f -- "$temporary";; esac',
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

export function nodeEnvironment() {
  return {
    ...process.env,
    NO_COLOR: "1",
    NODE_NO_WARNINGS: "1",
  }
}

export function nodeExecutionHash(code: string, args: string[] = []) {
  return createHash("sha256").update(JSON.stringify({ code, args })).digest("hex")
}

export async function runNode(options: NodeRunOptions): Promise<ProcessResult> {
  if (!options.code.trim()) throw new Error("Node source code is required")
  const directory = await mkdtemp(path.join(tmpdir(), "owencode-node-"))
  const file = path.join(directory, "script.ts")
  try {
    await writeFile(file, options.code, "utf8")
    return await runProcess({
      label: "Node",
      binary: options.binary,
      args: nodeFileArguments(file, options.args),
      cwd: options.cwd,
      input: undefined,
      env: nodeEnvironment(),
      signal: options.signal,
      timeout: options.timeout,
      maxOutputBytes: options.maxOutputBytes,
    })
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}
