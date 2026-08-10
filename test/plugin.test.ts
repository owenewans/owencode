import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ToolContext } from "@opencode-ai/plugin"
import Owencode from "../src/index.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("plugin", () => {
  it("registers remote tools and uses native approval requests", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "owencode-plugin-"))
    directories.push(root)
    await writeFile(path.join(root, "file.txt"), "hello\n")
    const approvals: Array<{ permission: string; patterns: string[]; always: string[] }> = []
    const hooks = await Owencode({} as never, {
      host: "ignored",
      root,
      sshBinary: "/bin/sh",
      sshArgs: ["-c", 'exec /bin/sh -c "$2"', "owencode-test"],
      ghBinary: "/bin/echo",
    })
    const context = {
      sessionID: "session",
      messageID: "message",
      agent: "build",
      directory: root,
      worktree: root,
      abort: new AbortController().signal,
      metadata() {},
      async ask(request: { permission: string; patterns: string[]; always: string[] }) {
        approvals.push(request)
      },
    } as ToolContext

    expect(Object.keys(hooks.tool ?? {})).toEqual([
      "ssh_read",
      "ssh_glob",
      "ssh_grep",
      "ssh_bash",
      "deno_run",
      "ssh_deno_run",
      "ssh_write",
      "ssh_edit",
      "ssh_apply_patch",
      "gh",
    ])
    const result = await hooks.tool?.ssh_read.execute({ filePath: "file.txt" }, context)
    expect(result).toMatchObject({ output: "1: hello" })
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ permission: "ssh_read", patterns: ["ignored:file.txt"] })

    await hooks.tool?.gh.execute({ command: "--repo owner/repo pr merge 1" }, context)
    expect(approvals[1]).toMatchObject({
      permission: "gh",
      patterns: ["gh --repo owner/repo pr merge 1"],
      always: ["gh --repo owner/repo pr merge 1"],
    })

    await hooks.tool?.gh.execute({ args: ["repo", "view", "owner/repo"] } as never, context)
    expect(approvals[2]).toMatchObject({
      permission: "gh",
      patterns: ["gh repo view owner/repo"],
    })
  })
})
