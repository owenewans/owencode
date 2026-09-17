export type GoalStatus = "active" | "paused" | "completed" | "blocked" | "stopped"

export type GoalState = {
  version: 1
  sessionID: string
  goal: string
  status: GoalStatus
  turn: number
  pendingID: string | null
  progress: string | null
  evidence: string | null
  blocker: string | null
  lastIdleEventID: string | null
  updatedAt: string
}

export type GoalEntry = {
  key: string
  value: unknown
}

export type GoalRuntime = {
  get(key: string): Promise<unknown>
  set(key: string, value: GoalState): Promise<void>
  scan(prefix: string): Promise<readonly GoalEntry[]>
  prompt(input: {
    sessionID: string
    id: string
    text: string
    delivery: "queue"
    metadata: Record<string, string | number | boolean>
  }): Promise<void>
  synthetic(input: { sessionID: string; text: string }): Promise<void>
  now(): string
  id(): string
  sleep(milliseconds: number): Promise<void>
}

const PREFIX = "sessions/"
const RETRY_DELAYS = [0, 100, 500] as const

function stateKey(sessionID: string): string {
  return `${PREFIX}${sessionID}`
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`owenloop: invalid ${field}`)
  return value.trim()
}

function parseState(value: unknown): GoalState | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("owenloop: invalid stored goal state")
  const candidate = value as Record<string, unknown>
  const statuses: GoalStatus[] = ["active", "paused", "completed", "blocked", "stopped"]
  if (
    candidate.version !== 1 ||
    typeof candidate.sessionID !== "string" ||
    typeof candidate.goal !== "string" ||
    !statuses.includes(candidate.status as GoalStatus) ||
    !Number.isSafeInteger(candidate.turn) ||
    (candidate.turn as number) < 0 ||
    (candidate.pendingID !== null && typeof candidate.pendingID !== "string") ||
    (candidate.progress !== null && typeof candidate.progress !== "string") ||
    (candidate.evidence !== null && typeof candidate.evidence !== "string") ||
    (candidate.blocker !== null && typeof candidate.blocker !== "string") ||
    (candidate.lastIdleEventID !== null && typeof candidate.lastIdleEventID !== "string") ||
    typeof candidate.updatedAt !== "string"
  ) {
    throw new Error("owenloop: invalid stored goal state")
  }
  return candidate as GoalState
}

function continuation(state: GoalState): string {
  return [
    `[owenloop continuation ${state.turn}]`,
    "Continue autonomously toward the durable goal injected in system context.",
    "Do not stop at a progress report or partial implementation.",
    "Use owenloop_progress after meaningful verified progress.",
    "Use owenloop_complete only when the full goal is proven complete, or owenloop_blocked only for a real blocker that prevents further work.",
  ].join("\n")
}

function render(state: GoalState | undefined): string {
  if (!state) return "owenloop: no goal is stored for this session"
  const details = [
    `status: ${state.status}`,
    `turn: ${state.turn}`,
    `goal: ${state.goal}`,
    state.progress ? `progress: ${state.progress}` : undefined,
    state.evidence ? `evidence: ${state.evidence}` : undefined,
    state.blocker ? `blocker: ${state.blocker}` : undefined,
  ].filter((line): line is string => line !== undefined)
  return details.join("\n")
}

export class GoalEngine {
  private readonly serial = new Map<string, Promise<unknown>>()

  constructor(private readonly runtime: GoalRuntime) {}

  private run<T>(sessionID: string, action: () => Promise<T>): Promise<T> {
    const previous = this.serial.get(sessionID) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(action)
    this.serial.set(sessionID, current)
    void current.finally(() => {
      if (this.serial.get(sessionID) === current) this.serial.delete(sessionID)
    }).catch(() => undefined)
    return current
  }

  private async load(sessionID: string): Promise<GoalState | undefined> {
    const state = parseState(await this.runtime.get(stateKey(sessionID)))
    if (state && state.sessionID !== sessionID) throw new Error("owenloop: stored goal belongs to another session")
    return state
  }

  private async save(state: GoalState): Promise<void> {
    state.updatedAt = this.runtime.now()
    await this.runtime.set(stateKey(state.sessionID), state)
  }

  private async admit(state: GoalState): Promise<void> {
    const pendingID = state.pendingID
    if (!pendingID || state.status !== "active") return
    let failure: unknown
    for (const delay of RETRY_DELAYS) {
      if (delay > 0) await this.runtime.sleep(delay)
      try {
        await this.runtime.prompt({
          sessionID: state.sessionID,
          id: pendingID,
          text: continuation(state),
          delivery: "queue",
          metadata: { owenloop: true, turn: state.turn },
        })
        return
      } catch (error) {
        failure = error
      }
    }
    const current = await this.load(state.sessionID)
    if (!current || current.status !== "active" || current.pendingID !== pendingID) return
    current.status = "blocked"
    current.pendingID = null
    current.blocker = `could not enqueue continuation after ${RETRY_DELAYS.length} attempts: ${failure instanceof Error ? failure.message : String(failure)}`
    await this.save(current)
  }

  private async schedule(state: GoalState): Promise<void> {
    if (state.status !== "active" || state.pendingID) return
    state.turn += 1
    state.pendingID = this.runtime.id()
    await this.save(state)
    await this.admit(state)
  }

  async command(sessionID: string, raw: string): Promise<void> {
    await this.run(sessionID, async () => {
      const input = raw.trim()
      const action = input.toLowerCase()
      if (input.length === 0 || action === "status") {
        await this.runtime.synthetic({ sessionID, text: render(await this.load(sessionID)) })
        return
      }
      if (action === "pause") {
        const state = await this.load(sessionID)
        if (!state || state.status !== "active") throw new Error("owenloop: only an active goal can be paused")
        state.status = "paused"
        await this.save(state)
        await this.runtime.synthetic({ sessionID, text: render(state) })
        return
      }
      if (action === "resume") {
        const state = await this.load(sessionID)
        if (!state || (state.status !== "paused" && state.status !== "blocked")) {
          throw new Error("owenloop: only a paused or blocked goal can be resumed")
        }
        state.status = "active"
        state.blocker = null
        state.pendingID = null
        await this.save(state)
        await this.schedule(state)
        return
      }
      if (action === "stop") {
        const state = await this.load(sessionID)
        if (!state) throw new Error("owenloop: no goal is stored for this session")
        state.status = "stopped"
        state.pendingID = null
        await this.save(state)
        await this.runtime.synthetic({ sessionID, text: render(state) })
        return
      }

      const goal = text(input.replace(/^start\s+/i, ""), "goal")
      const state: GoalState = {
        version: 1,
        sessionID,
        goal,
        status: "active",
        turn: 0,
        pendingID: null,
        progress: null,
        evidence: null,
        blocker: null,
        lastIdleEventID: null,
        updatedAt: this.runtime.now(),
      }
      await this.save(state)
      await this.schedule(state)
    })
  }

  async idle(sessionID: string, eventID: string): Promise<void> {
    await this.run(sessionID, async () => {
      const state = await this.load(sessionID)
      if (!state || state.status !== "active" || state.lastIdleEventID === eventID) return
      state.lastIdleEventID = eventID
      state.pendingID = null
      await this.save(state)
      await this.schedule(state)
    })
  }

  async progress(sessionID: string, summary: string): Promise<GoalState> {
    return this.run(sessionID, async () => {
      const state = await this.load(sessionID)
      if (!state || state.status !== "active") throw new Error("owenloop: progress requires an active goal")
      state.progress = text(summary, "progress summary")
      await this.save(state)
      return state
    })
  }

  async complete(sessionID: string, evidence: string): Promise<GoalState> {
    return this.run(sessionID, async () => {
      const state = await this.load(sessionID)
      if (!state || state.status !== "active") throw new Error("owenloop: completion requires an active goal")
      state.status = "completed"
      state.pendingID = null
      state.evidence = text(evidence, "completion evidence")
      await this.save(state)
      return state
    })
  }

  async blocked(sessionID: string, reason: string): Promise<GoalState> {
    return this.run(sessionID, async () => {
      const state = await this.load(sessionID)
      if (!state || state.status !== "active") throw new Error("owenloop: blocking requires an active goal")
      state.status = "blocked"
      state.pendingID = null
      state.blocker = text(reason, "blocker reason")
      await this.save(state)
      return state
    })
  }

  async system(sessionID: string): Promise<string | undefined> {
    const state = await this.load(sessionID)
    if (!state) return undefined
    return [
      "OWENLOOP DURABLE GOAL",
      render(state),
      "The stored goal survives compaction and plugin restart.",
      state.status === "active"
        ? "Continue until the whole goal is proven complete or a real blocker prevents further work. Report state through the owenloop tools; do not claim completion in prose alone."
        : "Do not continue this goal unless its state is active.",
    ].join("\n")
  }

  async recover(): Promise<void> {
    const entries = await this.runtime.scan(PREFIX)
    for (const entry of entries) {
      const state = parseState(entry.value)
      if (!state || state.status !== "active") continue
      await this.run(state.sessionID, async () => {
        const current = await this.load(state.sessionID)
        if (!current || current.status !== "active") return
        if (current.pendingID) await this.admit(current)
        else await this.schedule(current)
      })
    }
  }
}
