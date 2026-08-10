import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Options } from "../src/config.js"
import { shellQuote, sha256, SshClient } from "../src/ssh.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function localClient(root = "/"): SshClient {
  const options: Options = {
    host: "ignored",
    root,
    sshBinary: "/bin/sh",
    sshArgs: ["-c", 'exec /bin/sh -c "$2"', "owencode-test"],
    maxOutputBytes: 1024 * 1024,
    maxTransferBytes: 1024 * 1024,
    controlMaster: false,
    controlPersist: "60s",
    maxSessions: 8,
  }
  return new SshClient(options)
}

describe("ssh helpers", () => {
  it("quotes shell arguments", () => {
    expect(shellQuote("a'b c")).toBe("'a'\\''b c'")
  })

  it("hashes content deterministically", () => {
    expect(sha256("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
  })

  it("reads, atomically writes and deletes through the ssh transport", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "owencode-"))
    directories.push(directory)
    const filePath = path.join(directory, "nested", "file.txt")
    const client = localClient()

    await client.writeFile(filePath, "first\n", "missing")
    expect(await client.textFile(filePath)).toBe("first\n")
    await client.writeFile(filePath, "second\n", sha256("first\n"))
    expect(await readFile(filePath, "utf8")).toBe("second\n")
    await expect(client.writeFile(filePath, "stale\n", sha256("first\n"))).rejects.toThrow("changed")
    await client.deleteFile(filePath, sha256("second\n"))
    await expect(readFile(filePath)).rejects.toThrow()
  })

  it("passes script arguments without shell expansion", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "owencode-"))
    directories.push(directory)
    const filePath = path.join(directory, "quote ' and space.txt")
    await writeFile(filePath, "safe")

    const result = await localClient().script('cat -- "$1"\n', [filePath])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe("safe")
  })

  it("follows symlinks like any other path", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "owencode-"))
    directories.push(directory)
    await writeFile(path.join(directory, "target"), "content")
    await symlink(path.join(directory, "target"), path.join(directory, "link"))

    await expect(localClient(directory).textFile(path.join(directory, "link"))).resolves.toBe("content")
  })

  it("limits combined stdout and stderr", async () => {
    await expect(
      localClient().run("printf 123456; printf abcdef >&2", { maxOutputBytes: 10 }),
    ).rejects.toThrow("SSH output exceeded 10 bytes")
  })
})
