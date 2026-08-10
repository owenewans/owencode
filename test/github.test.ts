import { describe, expect, it } from "vitest"
import { renderGhCommand, runGh, validateGhArgs } from "../src/github.js"

describe("github cli", () => {
  it("renders approval commands without executing a shell", () => {
    expect(renderGhCommand(["repo", "view", "owner/repo", "--json", "name description"])).toBe(
      'gh repo view owner/repo --json "name description"',
    )
  })

  it("blocks token disclosure and control characters", () => {
    expect(() => validateGhArgs(["auth", "token"])).toThrow("blocked")
    expect(() => validateGhArgs(["auth", "status", "--show-token"])).toThrow("tokens")
    expect(() => validateGhArgs(["auth", "status", "-t"])).toThrow("tokens")
    expect(() => validateGhArgs(["repo", "view\nwhoami"])).toThrow("control characters")
  })

  it("executes argument arrays and captures output", async () => {
    const result = await runGh({
      binary: "/bin/sh",
      args: ["-c", 'printf "%s" "$1"', "gh-test", "safe value"],
      cwd: "/tmp",
      maxOutputBytes: 1024,
    })
    expect(result).toEqual({ stdout: "safe value", stderr: "", exitCode: 0 })
  })

  it("honors an already aborted context", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runGh({ binary: "/bin/true", args: ["status"], cwd: "/tmp", signal: controller.signal, maxOutputBytes: 1024 }),
    ).rejects.toThrow("aborted")
  })
})
