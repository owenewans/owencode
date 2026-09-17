import fs from "node:fs/promises"
import path from "node:path"

export type ActionLog = {
  file: string
  record(entry: Record<string, unknown>): void
  flush(): Promise<void>
}

// Arguments carry page content, selectors and occasionally credentials typed
// into a form, so every value is capped before it reaches the disk.
function truncate(value: unknown, limit = 300): unknown {
  if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}…[${value.length}]` : value
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => truncate(item, limit))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, truncate(item, limit)]))
  }
  return value
}

export function createActionLog(directory: string, enabled: boolean, now = () => new Date()): ActionLog {
  const file = path.join(directory, `actions-${now().toISOString().slice(0, 10)}.jsonl`)
  // A serialized tail keeps the file ordered and stops a slow disk from
  // blocking a tool call; logging must never be the reason a request fails.
  let tail = Promise.resolve()
  return {
    file,
    record(entry) {
      if (!enabled) return
      const line = `${JSON.stringify({ at: now().toISOString(), ...truncate(entry) as Record<string, unknown> })}\n`
      tail = tail.then(() => fs.appendFile(file, line, { mode: 0o600 })).catch(() => undefined)
    },
    flush: () => tail,
  }
}
