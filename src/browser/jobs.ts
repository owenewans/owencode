export type JobStatus = "running" | "done" | "failed" | "timeout"

export type Job = {
  id: string
  status: JobStatus
  startedAt: number
  finishedAt?: number
  result?: unknown
  error?: string
  timeout: number
  label?: string
}

export type JobView = Omit<Job, "startedAt" | "finishedAt"> & {
  startedAt: string
  finishedAt?: string
  runningMs: number
}

export type JobRunner = (code: string, signal: AbortSignal) => Promise<unknown>

export type Jobs = {
  start(code: string, options?: { timeout?: number; label?: string }): JobView
  // Waits for completion but never longer than waitMs, so the MCP round trip
  // stays short while the job itself keeps running in the background.
  wait(id: string, waitMs: number): Promise<JobView>
  list(): JobView[]
  cancel(id: string): JobView
  pending(): number
}

function view(job: Job, now: number): JobView {
  const { startedAt, finishedAt, ...rest } = job
  return {
    ...rest,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: finishedAt === undefined ? undefined : new Date(finishedAt).toISOString(),
    runningMs: (finishedAt ?? now) - startedAt,
  }
}

export function createJobs(runner: JobRunner, defaultTimeout: number, now = () => Date.now()): Jobs {
  const jobs = new Map<string, Job>()
  const controllers = new Map<string, AbortController>()
  const waiters = new Map<string, Set<() => void>>()
  let counter = 0

  const settle = (job: Job, status: JobStatus, patch: Partial<Job>) => {
    if (job.status !== "running") return
    Object.assign(job, patch, { status, finishedAt: now() })
    controllers.delete(job.id)
    for (const resume of waiters.get(job.id) ?? []) resume()
    waiters.delete(job.id)
  }

  const require = (id: string) => {
    const job = jobs.get(id)
    if (!job) throw new Error(`unknown job: ${id}`)
    return job
  }

  return {
    start(code, options = {}) {
      const id = `job-${++counter}`
      const timeout = options.timeout ?? defaultTimeout
      const job: Job = { id, status: "running", startedAt: now(), timeout, label: options.label }
      jobs.set(id, job)
      const controller = new AbortController()
      controllers.set(id, controller)
      const timer = setTimeout(() => {
        controller.abort()
        settle(job, "timeout", { error: `job exceeded ${timeout}ms` })
      }, timeout)
      // Detached on purpose: the caller gets the id immediately and polls later.
      void runner(code, controller.signal).then(
        (result) => settle(job, "done", { result }),
        (error: unknown) => settle(job, "failed", { error: error instanceof Error ? error.message : String(error) }),
      ).finally(() => clearTimeout(timer))
      return view(job, now())
    },
    async wait(id, waitMs) {
      const job = require(id)
      if (job.status === "running" && waitMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(finish, waitMs)
          const set = waiters.get(id) ?? new Set()
          set.add(finish)
          waiters.set(id, set)
          function finish() {
            clearTimeout(timer)
            waiters.get(id)?.delete(finish)
            resolve()
          }
        })
      }
      return view(job, now())
    },
    list: () => [...jobs.values()].map((job) => view(job, now())),
    cancel(id) {
      const job = require(id)
      controllers.get(id)?.abort()
      settle(job, "failed", { error: "cancelled" })
      return view(job, now())
    },
    pending: () => [...jobs.values()].filter((job) => job.status === "running").length,
  }
}
