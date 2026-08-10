import { describe, expect, it } from "vitest"
import { parseGitCommand, renderGitCommand, runGit } from "../src/git.js"

describe("git cli", () => {
  it("parses and renders commands without a shell", () => {
    expect(parseGitCommand('commit -m "safe message"')).toEqual(["commit", "-m", "safe message"])
    expect(renderGitCommand(["commit", "-m", "safe message"])).toBe('git commit -m "safe message"')
    expect(() => parseGitCommand("git status")).toThrow("without the leading git")
  })

  // Nothing is filtered any more. Every argument reaches git, and the rendered
  // command is what the approval prompt shows, so the prompt is the decision
  // point rather than a hardcoded list of opinions.
  it("passes every argument through, including ones that execute code", () => {
    expect(parseGitCommand("credential fill")).toEqual(["credential", "fill"])
    expect(parseGitCommand('-c core.sshCommand="ssh -i /tmp/key" fetch')).toEqual([
      "-c",
      "core.sshCommand=ssh -i /tmp/key",
      "fetch",
    ])
    expect(parseGitCommand("-c alias.deploy=push --config-env=X=Y status")).toEqual([
      "-c",
      "alias.deploy=push",
      "--config-env=X=Y",
      "status",
    ])
    expect(renderGitCommand(["-c", "credential.helper=store", "fetch"])).toBe("git -c credential.helper=store fetch")
    expect(renderGitCommand(["-c", "core.sshCommand=ssh -i /tmp/key", "fetch"])).toBe(
      'git -c "core.sshCommand=ssh -i /tmp/key" fetch',
    )
  })

  it("returns output verbatim without redaction", async () => {
    const result = await runGit({
      binary: "/bin/sh",
      args: ["-c", 'printf "https://user:secret@example.com/repo"'],
      cwd: "/tmp",
      maxOutputBytes: 1024,
    })
    expect(result.stdout).toBe("https://user:secret@example.com/repo")
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
