import { describe, expect, it } from "vitest"
import { assertNotSensitive, isEnvFile, isSensitivePath, sensitiveGlobs } from "../src/sensitive.js"

describe("credential paths", () => {
  it("refuses ssh key material anywhere in the tree", () => {
    expect(isSensitivePath("/root/.ssh/id_ed25519")).toBe(true)
    expect(isSensitivePath("/root/.ssh/authorized_keys")).toBe(true)
    expect(isSensitivePath("/home/deploy/.ssh/config")).toBe(true)
    expect(isSensitivePath("/srv/app/backup/.ssh/id_rsa")).toBe(true)
    expect(isSensitivePath("/srv/app/keys/id_ed25519.pub")).toBe(true)
  })

  it("refuses system authentication databases", () => {
    expect(isSensitivePath("/etc/shadow")).toBe(true)
    expect(isSensitivePath("/etc/gshadow")).toBe(true)
    expect(isSensitivePath("/etc/sudoers")).toBe(true)
    expect(isSensitivePath("/etc/sudoers.d/90-cloud-init")).toBe(true)
  })

  it("refuses cloud and package manager credentials", () => {
    expect(isSensitivePath("/root/.aws/credentials")).toBe(true)
    expect(isSensitivePath("/root/.config/gh/hosts.yml")).toBe(true)
    expect(isSensitivePath("/root/.docker/config.json")).toBe(true)
    expect(isSensitivePath("/root/.kube/config")).toBe(true)
    expect(isSensitivePath("/home/app/.git-credentials")).toBe(true)
    expect(isSensitivePath("/home/app/.netrc")).toBe(true)
    expect(isSensitivePath("/home/app/.npmrc")).toBe(true)
  })

  it("treats env files as secrets but allows their templates", () => {
    expect(isEnvFile(".env")).toBe(true)
    expect(isEnvFile(".env.production")).toBe(true)
    expect(isEnvFile(".env.example")).toBe(false)
    expect(isEnvFile(".env.sample")).toBe(false)
    expect(isEnvFile(".env.template")).toBe(false)
    expect(isSensitivePath("/srv/app/.env")).toBe(true)
    expect(isSensitivePath("/srv/app/.env.example")).toBe(false)
  })

  it("does not fire on ordinary project files", () => {
    for (const safe of [
      "/srv/app/src/index.ts",
      "/srv/app/package.json",
      "/srv/app/README.md",
      "/srv/app/config/database.yml",
      "/srv/app/environment.ts",
      "/srv/app/src/shadow.ts",
      "/srv/app/docs/sudoers.md",
    ]) {
      expect(isSensitivePath(safe), safe).toBe(false)
    }
  })

  it("is not fooled by traversal or redundant separators", () => {
    expect(isSensitivePath("/srv/app/../../root/.ssh/id_rsa")).toBe(true)
    expect(isSensitivePath("/srv//app/./../../etc/shadow")).toBe(true)
  })

  it("explains itself and can be switched off deliberately", () => {
    expect(() => assertNotSensitive("/root/.ssh/id_rsa", "ssh_read", false)).toThrow("credentials")
    expect(() => assertNotSensitive("/root/.ssh/id_rsa", "ssh_read", false)).toThrow("allowSensitivePaths")
    expect(() => assertNotSensitive("/root/.ssh/id_rsa", "ssh_read", true)).not.toThrow()
    expect(() => assertNotSensitive("/srv/app/main.go", "ssh_read", false)).not.toThrow()
  })

  it("ships exclusions for the recursive search tools", () => {
    const globs = sensitiveGlobs()
    expect(globs.every((glob) => glob.startsWith("!"))).toBe(true)
    expect(globs).toContain("!.ssh/**")
    expect(globs).toContain("!.env")
    expect(globs).toContain("!etc/shadow")
  })
})
