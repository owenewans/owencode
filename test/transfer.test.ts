import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { localTransferPath, probeRemote, transfer, type TransferTransport } from "../src/transfer.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "owencode-transfer-"))
  directories.push(directory)
  return directory
}

function transport(root: string, maxTransferBytes = 8 * 1024 * 1024): TransferTransport {
  return {
    sshBinary: "/bin/sh",
    sshArgs: ["-c", 'exec /bin/sh -c "$2"', "owencode-test"],
    host: "ignored",
    root,
    tarBinary: "tar",
    maxTransferBytes,
  }
}

const binary = Buffer.from([0x00, 0xff, 0x0a, 0x0d, 0x1a, 0x7f, 0x80, 0x00, 0xfe])

describe("ssh transfer", () => {
  it("resolves local paths and rejects control characters", async () => {
    expect(localTransferPath("/tmp", "file.bin")).toBe("/tmp/file.bin")
    expect(() => localTransferPath("/tmp", "file\n.bin")).toThrow("control character")
  })

  it("uploads binary content and preserves the executable bit", async () => {
    const root = await workspace()
    const source = path.join(root, "local.bin")
    await writeFile(source, binary)
    await chmod(source, 0o750)

    const result = await transfer(transport(root), {
      direction: "upload",
      localPath: source,
      remotePath: path.join(root, "nested", "remote.bin"),
      recursive: false,
      overwrite: false,
    })

    expect(result).toMatchObject({ kind: "file", bytes: binary.length })
    const written = await readFile(path.join(root, "nested", "remote.bin"))
    expect(written.equals(binary)).toBe(true)
    expect((await stat(path.join(root, "nested", "remote.bin"))).mode & 0o777).toBe(0o750)
  })

  it("downloads binary content unchanged", async () => {
    const root = await workspace()
    const remote = path.join(root, "remote.bin")
    await writeFile(remote, binary)
    await chmod(remote, 0o755)
    const destination = path.join(root, "out", "local.bin")

    const result = await transfer(transport(root), {
      direction: "download",
      localPath: destination,
      remotePath: remote,
      recursive: false,
      overwrite: false,
    })

    expect(result.kind).toBe("file")
    expect((await readFile(destination)).equals(binary)).toBe(true)
    expect((await stat(destination)).mode & 0o100).toBe(0o100)
  })

  it("refuses to replace an existing destination unless overwrite is set", async () => {
    const root = await workspace()
    const source = path.join(root, "a.bin")
    const target = path.join(root, "b.bin")
    await writeFile(source, binary)
    await writeFile(target, "existing")

    await expect(
      transfer(transport(root), { direction: "upload", localPath: source, remotePath: target, recursive: false, overwrite: false }),
    ).rejects.toThrow("already exists")

    await transfer(transport(root), { direction: "upload", localPath: source, remotePath: target, recursive: false, overwrite: true })
    expect((await readFile(target)).equals(binary)).toBe(true)
  })

  it("transfers directory trees in both directions", async () => {
    const root = await workspace()
    const tree = path.join(root, "tree")
    await mkdir(path.join(tree, "inner"), { recursive: true })
    await writeFile(path.join(tree, "inner", "data.bin"), binary)
    await writeFile(path.join(tree, "top.txt"), "top\n")

    await transfer(transport(root), {
      direction: "upload",
      localPath: tree,
      remotePath: path.join(root, "uploaded"),
      recursive: true,
      overwrite: false,
    })
    expect((await readFile(path.join(root, "uploaded", "inner", "data.bin"))).equals(binary)).toBe(true)

    await transfer(transport(root), {
      direction: "download",
      localPath: path.join(root, "fetched"),
      remotePath: path.join(root, "uploaded"),
      recursive: true,
      overwrite: false,
    })
    expect(await readFile(path.join(root, "fetched", "top.txt"), "utf8")).toBe("top\n")
  })

  it("requires the recursive flag for directories", async () => {
    const root = await workspace()
    await mkdir(path.join(root, "dir"))
    await expect(
      transfer(transport(root), {
        direction: "upload",
        localPath: path.join(root, "dir"),
        remotePath: path.join(root, "copy"),
        recursive: false,
        overwrite: false,
      }),
    ).rejects.toThrow("recursive")
  })

  it("enforces the transfer size limit", async () => {
    const root = await workspace()
    const source = path.join(root, "big.bin")
    await writeFile(source, Buffer.alloc(4096, 7))
    await expect(
      transfer(transport(root, 1024), {
        direction: "upload",
        localPath: source,
        remotePath: path.join(root, "big-copy.bin"),
        recursive: false,
        overwrite: false,
      }),
    ).rejects.toThrow("limit")
  })

  it("does not write through symlinks that already exist in the destination", async () => {
    const root = await workspace()
    const outside = path.join(root, "outside")
    await mkdir(outside, { recursive: true })
    await mkdir(path.join(root, "dest"), { recursive: true })
    await symlink(outside, path.join(root, "dest", "link"))
    await mkdir(path.join(root, "tree", "link"), { recursive: true })
    await writeFile(path.join(root, "tree", "link", "planted.txt"), "planted\n")

    await transfer(transport(root), {
      direction: "upload",
      localPath: path.join(root, "tree"),
      remotePath: path.join(root, "dest"),
      recursive: true,
      overwrite: true,
    })

    expect(await readdir(outside)).toEqual([])
    expect((await lstat(path.join(root, "dest", "link"))).isDirectory()).toBe(true)
    expect(await readFile(path.join(root, "dest", "link", "planted.txt"), "utf8")).toBe("planted\n")
  })

  it("does not extract a downloaded tree through a local symlink", async () => {
    const root = await workspace()
    const outside = path.join(root, "outside")
    await mkdir(outside, { recursive: true })
    await mkdir(path.join(root, "local"), { recursive: true })
    await symlink(outside, path.join(root, "local", "link"))
    await mkdir(path.join(root, "remote", "link"), { recursive: true })
    await writeFile(path.join(root, "remote", "link", "planted.txt"), "planted\n")

    await transfer(transport(root), {
      direction: "download",
      localPath: path.join(root, "local"),
      remotePath: path.join(root, "remote"),
      recursive: true,
      overwrite: true,
    })

    expect(await readdir(outside)).toEqual([])
    expect(await readFile(path.join(root, "local", "link", "planted.txt"), "utf8")).toBe("planted\n")
  })

  it("reports a missing tar binary instead of crashing", async () => {
    const root = await workspace()
    await mkdir(path.join(root, "tree"), { recursive: true })
    const broken = { ...transport(root), tarBinary: "/nonexistent/tar" }
    await expect(
      transfer(broken, {
        direction: "upload",
        localPath: path.join(root, "tree"),
        remotePath: path.join(root, "copy"),
        recursive: true,
        overwrite: false,
      }),
    ).rejects.toThrow(/tar/)
  })

  it("leaves no staging directory behind after a failed recursive download", async () => {
    const root = await workspace()
    await expect(
      transfer(transport(root), {
        direction: "download",
        localPath: path.join(root, "out"),
        remotePath: path.join(root, "absent"),
        recursive: true,
        overwrite: false,
      }),
    ).rejects.toThrow("not found")
    expect(await readdir(root)).toEqual([])
  })

  it("confines remote paths to the configured root", async () => {
    const root = await workspace()
    await expect(probeRemote(transport(root), "/etc/passwd")).rejects.toThrow("outside configured root")
  })

  it("reports missing remote files", async () => {
    const root = await workspace()
    await expect(
      transfer(transport(root), {
        direction: "download",
        localPath: path.join(root, "out.bin"),
        remotePath: path.join(root, "absent.bin"),
        recursive: false,
        overwrite: false,
      }),
    ).rejects.toThrow("not found")
  })
})
