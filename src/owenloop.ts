import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { GoalEngine, type GoalEntry, type GoalState } from "./loop.js"

async function scanAll(ctx: Context, prefix: string): Promise<GoalEntry[]> {
  const entries: GoalEntry[] = []
  let after: string | undefined
  do {
    const page = await ctx.storage.scan({ prefix, after, limit: 100 })
    entries.push(...page.entries)
    after = page.next
  } while (after)
  return entries
}

export function createGoalEngine(ctx: Context): GoalEngine {
  return new GoalEngine({
    get: (key) => ctx.storage.get(key),
    set: (key, value) => ctx.storage.set(key, value),
    scan: (prefix) => scanAll(ctx, prefix),
    prompt: async (input) => {
      await ctx.session.prompt({ ...input, resume: true })
    },
    synthetic: async ({ sessionID, text }) => {
      await ctx.session.synthetic({ sessionID, text, description: "owenloop", delivery: "steer", resume: true })
    },
    now: () => new Date().toISOString(),
    id: () => `msg_${randomUUID().replaceAll("-", "")}`,
    sleep: (milliseconds) => sleep(milliseconds),
  })
}

const stringInput = (name: string, description: string) => ({
  type: "object" as const,
  properties: { [name]: { type: "string" as const, minLength: 1, description } },
  required: [name],
  additionalProperties: false,
})

const Owenloop = Plugin.define({
  id: "owenloop",
  async setup(ctx) {
    const engine = createGoalEngine(ctx)
    const controller = new AbortController()

    await ctx.command.transform((editor) => {
      editor.add({
        name: "goal",
        description: "Start a durable goal, or run status, pause, resume, or stop",
        execute: ({ sessionID, prompt }) => engine.command(sessionID, prompt.text),
      })
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "owenloop", description: "Durable autonomous goal lifecycle" })
      editor.add({
        name: "progress",
        description: "Persist meaningful verified progress for the active durable goal",
        input: stringInput("summary", "Verified progress and the next unfinished work"),
        options: { namespace: "owenloop" },
        execute: async (input, tool) => {
          const state = await engine.progress(tool.sessionID, (input as { summary: string }).summary)
          return { content: `owenloop progress saved for turn ${state.turn}` }
        },
      })
      editor.add({
        name: "complete",
        description: "Stop the loop only after the entire goal is proven complete",
        input: stringInput("evidence", "Concrete completion evidence, including relevant gates"),
        options: { namespace: "owenloop" },
        execute: async (input, tool) => {
          await engine.complete(tool.sessionID, (input as { evidence: string }).evidence)
          return { content: "owenloop goal completed" }
        },
      })
      editor.add({
        name: "blocked",
        description: "Stop the loop when a real external blocker prevents further work",
        input: stringInput("reason", "The blocker and why no further work can proceed"),
        options: { namespace: "owenloop" },
        execute: async (input, tool) => {
          await engine.blocked(tool.sessionID, (input as { reason: string }).reason)
          return { content: "owenloop goal blocked" }
        },
      })
    })

    const inject = async (event: { sessionID: string; system: Array<{ type: string; text: string }> }) => {
      const goal = await engine.system(event.sessionID)
      if (goal) event.system.push({ type: "text", text: goal })
    }
    await ctx.session.hook("context", inject)
    await ctx.session.hook("compaction", inject)

    void (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if (event.type === "session.idle") await engine.idle(event.data.sessionID, event.id)
          }
        } catch (error) {
          if (!controller.signal.aborted) console.error("owenloop event stream failed", error)
        }
        if (!controller.signal.aborted) {
          try {
            await sleep(1_000, undefined, { signal: controller.signal })
          } catch {
            break
          }
        }
      }
    })()

    await engine.recover()
    return () => controller.abort()
  },
})

export type { GoalState }
export default Owenloop
