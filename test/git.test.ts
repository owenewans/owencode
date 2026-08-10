import { describe, expect, it } from "vitest"
import { parseGitCommand, redactGitOutput, renderGitCommand, runGit, validateGitArgs } from "../src/git.js"

describe("git cli", () => {
  it("parses and renders commands without a shell", () => {
    expect(parseGitCommand('commit -m "safe message"')).toEqual(["commit", "-m", "safe message"])
    expect(renderGitCommand(["commit", "-m", "safe message"])).toBe('git commit -m "safe message"')
    expect(() => parseGitCommand("git status")).toThrow("without the leading git")
  })

  it("blocks credential operations and sensitive command configuration", () => {
    expect(() => validateGitArgs(["credential", "fill"])).toThrow("blocked")
    expect(() => validateGitArgs(["credential-cache", "exit"])).toThrow("blocked")
    expect(() => validateGitArgs(["-c", "credential.helper=store", "fetch"])).toThrow("blocked")
    expect(() => validateGitArgs(["-chttp.x.extraHeader=secret", "fetch"])).toThrow("blocked")
    expect(() => validateGitArgs(["-c", "alias.leak=credential", "leak", "fill"])).toThrow("alias")
    expect(() => validateGitArgs(["--config-env=credential.helper=EVIL", "fetch"])).toThrow("config-env")
  })

  it("redacts credentials in command output", () => {
    expect(redactGitOutput("https://user:secret@example.com/repo\nAuthorization: Bearer token"))
      .toBe("https://[redacted]@example.com/repo\nAuthorization: [redacted]")
    expect(redactGitOutput("username=owenewans\npassword=hunter2")).toBe("username=[redacted]\npassword=[redacted]")
  })

  it("executes argument arrays with interactive authentication disabled", async () => {
    const result = await runGit({
      binary: "/bin/sh",
      args: ["-c", 'printf "%s:%s" "$GIT_TERMINAL_PROMPT" "$GCM_INTERACTIVE"'],
      cwd: "/tmp",
      maxOutputBytes: 1024,
    })
    expect(result.stdout).toBe("0:never")
  })
})
