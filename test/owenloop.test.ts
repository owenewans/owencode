import { describe, expect, it } from "vitest"
import Owenloop from "../src/owenloop.js"

describe("owenloop V2 plugin", () => {
  it("registers the native command, tools, hooks, and event loop", async () => {
    const commands: Array<{ name: string; execute(input: unknown): Promise<void> }> = []
    const tools: Array<{ name: string; execute(input: unknown, context: unknown): Promise<unknown> }> = []
    const hooks = new Map<string, (event: unknown) => Promise<void>>()
    const namespaces: string[] = []
    const prompts: Array<{ id: string; delivery: string }> = []
    const storage = new Map<string, unknown>()
    let subscribed = false
    let aborted = false
    const context = {
      storage: {
        async get(key: string) {
          return storage.get(key)
        },
        async set(key: string, value: unknown) {
          storage.set(key, value)
        },
        async scan() {
          return { entries: [] }
        },
      },
      command: {
        async transform(transform: (editor: { add(command: (typeof commands)[number]): void }) => void) {
          transform({ add: (command) => commands.push(command) })
        },
      },
      tool: {
        async transform(transform: (editor: {
          namespace(namespace: { name: string }): void
          add(tool: (typeof tools)[number]): void
        }) => void) {
          transform({
            namespace: (namespace) => namespaces.push(namespace.name),
            add: (tool) => tools.push(tool),
          })
        },
      },
      session: {
        async hook(name: string, hook: (event: unknown) => Promise<void>) {
          hooks.set(name, hook)
        },
        async prompt(input: { id: string; delivery: string }) {
          prompts.push(input)
        },
        async synthetic() {},
      },
      event: {
        async *subscribe({ signal }: { signal: AbortSignal }) {
          subscribed = true
          signal.addEventListener("abort", () => {
            aborted = true
          })
        },
      },
    }

    expect(Owenloop.id).toBe("owenloop")
    const cleanup = await Owenloop.setup(context as never)
    await new Promise((resolve) => setImmediate(resolve))

    expect(commands.map((command) => command.name)).toEqual(["goal"])
    expect(namespaces).toEqual(["owenloop"])
    expect(tools.map((tool) => tool.name)).toEqual(["progress", "complete", "blocked"])
    expect([...hooks.keys()]).toEqual(["context", "compaction"])
    expect(subscribed).toBe(true)

    await commands[0]?.execute({ sessionID: "session", prompt: { text: "finish" } })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ delivery: "steer" })
    expect(prompts[0]?.id).toMatch(/^msg_/)

    cleanup?.()
    expect(aborted).toBe(true)
  })
})
