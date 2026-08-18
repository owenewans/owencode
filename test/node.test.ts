import { describe, expect, it } from "vitest"
import { nodeExecutionHash, nodeFileArguments, remoteNodeJob, runNode } from "../src/node.js"

describe("node runner", () => {
  it("strips types and runs the given file with arguments", () => {
    expect(nodeFileArguments("script.ts", ["one", "two words"])).toEqual([
      "--experimental-strip-types",
      "--no-warnings",
      "script.ts",
      "one",
      "two words",
    ])
  })

  it("rejects control characters in script arguments", () => {
    expect(() => nodeFileArguments("script.ts", ["bad\nargument"])).toThrow("control characters")
  })

  it("binds approvals to source code and script arguments", () => {
    expect(nodeExecutionHash("console.log(process.argv)", ["one"]))
      .not.toBe(nodeExecutionHash("console.log(process.argv)", ["two"]))
  })

  it("builds a quoted remote supervisor without embedding source code", () => {
    const job = remoteNodeJob("/usr/bin/node", "/root/path with spaces", ["two words"], 5_000, "fixed")
    expect(job.command).toContain("setsid timeout")
    expect(job.command).toContain(".owencode-node.XXXXXX.ts")
    expect(job.command).toContain("'/root/path with spaces'")
    expect(job.command).toContain("'two words'")
    expect(job.cleanupCommand).toContain("/tmp/owencode-node-fixed")
  })

  it("executes multiline TypeScript with process.argv", async () => {
    const result = await runNode({
      binary: process.execPath,
      code: `
        const values: string[] = process.argv.slice(2)
        console.log(JSON.stringify({ values, cwd: process.cwd() }))
      `,
      args: ["one", "two words"],
      cwd: "/tmp",
      timeout: 30_000,
      maxOutputBytes: 1024 * 1024,
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ values: ["one", "two words"], cwd: "/tmp" })
    expect(result.stderr).toBe("")
  })
})
