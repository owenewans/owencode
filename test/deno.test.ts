import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { denoArguments, denoExecutionHash, remoteDenoJob, runDeno } from "../src/deno.js"

describe("deno runner", () => {
  it("uses full permissions and reads TypeScript source from stdin", () => {
    expect(denoArguments(["one", "two words"])).toEqual([
      "run",
      "--allow-all",
      "--allow-scripts",
      "--quiet",
      "--no-prompt",
      "--no-lock",
      "--ext=ts",
      "-",
      "one",
      "two words",
    ])
  })

  it("rejects control characters in script arguments", () => {
    expect(() => denoArguments(["bad\nargument"])).toThrow("control characters")
  })

  it("binds approvals to source code and script arguments", () => {
    expect(denoExecutionHash("console.log(Deno.args)", ["one"]))
      .not.toBe(denoExecutionHash("console.log(Deno.args)", ["two"]))
  })

  it("builds a quoted remote supervisor without embedding source code", () => {
    const job = remoteDenoJob("/root/.deno/bin/deno", "/root/path with spaces", ["two words"], 5_000, "fixed")
    expect(job.command).toContain("setsid timeout")
    expect(job.command).toContain(".owencode-deno.XXXXXX.ts")
    expect(job.command).toContain("'/root/path with spaces'")
    expect(job.command).toContain("'two words'")
    expect(job.cleanupCommand).toContain("/tmp/owencode-deno-fixed")
  })

  it.skipIf(!existsSync("/usr/bin/deno"))("executes multiline TypeScript with Deno.args", async () => {
    const result = await runDeno({
      binary: "/usr/bin/deno",
      code: `
        const values: string[] = Deno.args
        console.log(JSON.stringify({ values, cwd: Deno.cwd() }))
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
