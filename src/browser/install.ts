import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// The launcher name camoufox-js resolves inside the install directory.
const LAUNCHER: Record<string, string> = {
  linux: "camoufox-bin",
  win32: "camoufox.exe",
  darwin: path.join("Camoufox.app", "Contents", "MacOS", "camoufox"),
}

export function installDirectory(env = process.env) {
  return env.CAMOUFOX_INSTALL_DIR
    ? path.resolve(env.CAMOUFOX_INSTALL_DIR)
    : path.join(os.homedir(), ".cache", "camoufox")
}

async function readJson(file: string) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>
  } catch {
    return undefined
  }
}

// Two layouts exist in the wild: camoufox-js writes version.json next to a flat
// extraction, while newer upstream archives unpack into
// browsers/<channel>/<version>/ and record the active one in config.json.
export async function installedVersion(directory = installDirectory()) {
  const legacy = await readJson(path.join(directory, "version.json"))
  if (legacy) return `${legacy.version ?? "unknown"}-${legacy.release ?? "unknown"}`
  const config = await readJson(path.join(directory, "config.json"))
  const active = typeof config?.active_version === "string" ? config.active_version : undefined
  if (active) return path.basename(active)
  throw new Error(
    `Camoufox is not installed in ${directory}. Run "npm run browser:fetch" in the owencode repository.`,
  )
}

// camoufox-js repairs a broken install by deleting the whole directory and
// downloading in the background, without awaiting it. Doing that while a
// browser is running pulls the files out from under it and the window dies
// minutes later, so an unusable install has to be refused up front instead.
export async function assertInstalled(directory = installDirectory()) {
  const version = await installedVersion(directory)
  const launcher = path.join(directory, LAUNCHER[process.platform] ?? LAUNCHER.linux)
  try {
    await fs.access(launcher)
  } catch {
    throw new Error(
      `Camoufox ${version} is installed in ${directory} but ${launcher} is missing, ` +
      `which happens when an archive uses the browsers/<channel>/<version>/ layout. ` +
      `Move that version's files into ${directory} and write version.json, or reinstall with "npm run browser:fetch". ` +
      `Launching now would let camoufox-js delete the directory while a browser is using it.`,
    )
  }
  return version
}
