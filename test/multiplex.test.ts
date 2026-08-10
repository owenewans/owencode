import { lstat, mkdtemp, rm, stat, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { controlArgs, noControlArgs, resetSocketDirectory, Semaphore, socketDirectory } from "../src/multiplex.js"

const previous = process.env.XDG_RUNTIME_DIR
const directories: string[] = []

afterEach(async () => {
  if (previous === undefined) delete process.env.XDG_RUNTIME_DIR
  else process.env.XDG_RUNTIME_DIR = previous
  resetSocketDirectory()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("ssh multiplexing", () => {
  it("builds control arguments with a hashed socket path", () => {
    const args = controlArgs({ enabled: true, persist: "60s", maxSessions: 8 }, "/run/user/1000/owencode")
    expect(args).toEqual([
      "-o",
      "ControlMaster=auto",
      "-o",
      "ControlPath=/run/user/1000/owencode/%C",
      "-o",
      "ControlPersist=60s",
    ])
  })

  it("emits nothing when disabled or when no socket directory is usable", () => {
    expect(controlArgs({ enabled: false, persist: "60s", maxSessions: 8 }, "/run/user/1000/owencode")).toEqual([])
    expect(controlArgs({ enabled: true, persist: "60s", maxSessions: 8 }, null)).toEqual([])
  })

  it("opts long lived forwards out of multiplexing", () => {
    expect(noControlArgs()).toEqual(["-o", "ControlMaster=no", "-o", "ControlPath=none"])
  })

  it("creates a private socket directory and repairs loose permissions", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "owencode-xdg-"))
    directories.push(base)
    process.env.XDG_RUNTIME_DIR = base
    resetSocketDirectory()

    const directory = socketDirectory()
    expect(directory).toBe(path.join(base, "owencode"))
    expect((await stat(directory!)).mode & 0o777).toBe(0o700)
  })

  it("measures the expanded %C hash, not the placeholder, against sun_path", async () => {
    // 60 characters leaves room for "/%C" as two characters but not for the
    // 40 character hash ssh actually substitutes.
    const base = await mkdtemp(path.join(os.tmpdir(), `owencode-${"x".repeat(60)}-`))
    directories.push(base)
    process.env.XDG_RUNTIME_DIR = base
    resetSocketDirectory()

    const directory = socketDirectory()
    expect(directory).not.toBe(path.join(base, "owencode"))
    expect(path.join(directory!, "0".repeat(40)).length).toBeLessThanOrEqual(107)
  })

  it("does not follow a symlink planted at the socket directory", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "owencode-xdg-"))
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "owencode-target-"))
    directories.push(base, elsewhere)
    await symlink(elsewhere, path.join(base, "owencode"))
    process.env.XDG_RUNTIME_DIR = base
    resetSocketDirectory()

    const directory = socketDirectory()
    expect(directory).not.toBe(path.join(base, "owencode"))
    expect((await lstat(directory!)).isSymbolicLink()).toBe(false)
  })

  it("falls back to an unguessable directory rather than a predictable name in tmp", async () => {
    delete process.env.XDG_RUNTIME_DIR
    resetSocketDirectory()

    const directory = socketDirectory()!
    directories.push(directory)
    expect(directory.startsWith(path.join(os.tmpdir(), "owencode-"))).toBe(true)
    expect(directory).not.toBe(path.join(os.tmpdir(), `owencode-${process.getuid?.()}`))
    expect((await lstat(directory)).isSymbolicLink()).toBe(false)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
  })

  it("never exceeds the configured concurrency", async () => {
    const semaphore = new Semaphore(3)
    let active = 0
    let peak = 0
    await Promise.all(
      Array.from({ length: 25 }, async () => {
        const release = await semaphore.acquire()
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        release()
      }),
    )
    expect(peak).toBe(3)
    expect(semaphore.inFlight).toBe(0)
    expect(semaphore.pending).toBe(0)
  })

  it("hands a released slot to the waiter instead of letting a newcomer steal it", async () => {
    const semaphore = new Semaphore(1)
    const first = await semaphore.acquire()
    const order: string[] = []

    const waiter = semaphore.acquire().then((release) => {
      order.push("waiter")
      release()
    })
    await new Promise((resolve) => setImmediate(resolve))
    first()

    const newcomer = semaphore.acquire().then((release) => {
      order.push("newcomer")
      release()
    })
    await Promise.all([waiter, newcomer])
    expect(order).toEqual(["waiter", "newcomer"])
  })

  it("releases only once even if called repeatedly", async () => {
    const semaphore = new Semaphore(1)
    const release = await semaphore.acquire()
    release()
    release()
    expect(semaphore.inFlight).toBe(0)
  })
})
