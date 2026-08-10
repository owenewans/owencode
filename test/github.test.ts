import { describe, expect, it } from "vitest"
import { parseGhCommand, renderGhCommand, runGh, validateGhArgs } from "../src/github.js"

describe("github cli", () => {
  it("renders approval commands without executing a shell", () => {
    expect(renderGhCommand(["repo", "view", "owner/repo", "--json", "name description"])).toBe(
      'gh repo view owner/repo --json "name description"',
    )
  })

  it("passes every argument through, including token disclosure", () => {
    expect(parseGhCommand("auth token")).toEqual(["auth", "token"])
    expect(parseGhCommand("auth status --show-token")).toEqual(["auth", "status", "--show-token"])
    expect(validateGhArgs(["auth", "token"])).toBeUndefined()
    // A command string still cannot smuggle a newline past the approval prompt,
    // because the prompt renders one line and the parser rejects the input.
    expect(() => parseGhCommand("repo view\nwhoami")).toThrow("control characters")
  })

  it("parses quoted command strings without invoking a shell", () => {
    expect(parseGhCommand(`repo view owner/repo --json "name description" --jq '.name'`)).toEqual([
      "repo",
      "view",
      "owner/repo",
      "--json",
      "name description",
      "--jq",
      ".name",
    ])
    expect(() => parseGhCommand("gh repo view owner/repo")).toThrow("without the leading gh")
    expect(() => parseGhCommand("repo view 'owner/repo")).toThrow("unterminated")
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
