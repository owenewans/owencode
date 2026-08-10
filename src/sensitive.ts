import path from "node:path"

// Paths that hold credentials or authentication material. None of them are a
// legitimate part of a coding task, and all of them are what an attacker who
// reached the model through untrusted content would try to read or plant.
// The list is deliberately narrow: every entry is a file whose only purpose is
// to hold a secret or grant access, so false positives stay near zero.
const BASENAMES = new Set([
  "authorized_keys",
  "authorized_keys2",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ecdsa_sk",
  "id_ed25519",
  "id_ed25519_sk",
  "shadow",
  "gshadow",
  "sudoers",
  ".git-credentials",
  ".netrc",
  ".pgpass",
  ".npmrc",
  ".pypirc",
  ".htpasswd",
])

const SUFFIX_PATHS = [
  ".aws/credentials",
  ".aws/config",
  ".config/gh/hosts.yml",
  ".config/gcloud/credentials.db",
  ".docker/config.json",
  ".kube/config",
  ".gnupg/secring.gpg",
]

const DIRECTORIES = new Set([".ssh", ".gnupg"])

const ETC = new Set(["/etc/shadow", "/etc/gshadow", "/etc/sudoers"])

const ENV_EXEMPT = /\.(?:example|sample|template|dist)$/i

export function isEnvFile(basename: string) {
  if (ENV_EXEMPT.test(basename)) return false
  return basename === ".env" || basename.startsWith(".env.")
}

export function isSensitivePath(target: string): boolean {
  const normalized = path.posix.normalize(target)
  const segments = normalized.split("/").filter(Boolean)
  const basename = segments.at(-1) ?? ""

  if (ETC.has(normalized) || normalized.startsWith("/etc/sudoers.d/")) return true
  // A public key is not a secret, but the private half sits beside it.
  if (BASENAMES.has(basename.endsWith(".pub") ? basename.slice(0, -4) : basename)) return true
  if (isEnvFile(basename)) return true
  if (segments.some((segment) => DIRECTORIES.has(segment))) return true
  if (SUFFIX_PATHS.some((suffix) => normalized === `/${suffix}` || normalized.endsWith(`/${suffix}`))) return true
  return false
}

export function assertNotSensitive(target: string, action: string, allow: boolean) {
  if (allow || !isSensitivePath(target)) return
  throw new Error(
    `${action} refuses ${target}: it holds credentials or authentication material. ` +
      "Set allowSensitivePaths to true in the plugin options if this is genuinely required.",
  )
}

// ripgrep walks directories on its own, so denying the starting path is not
// enough: the exclusions have to travel with the search itself.
export function sensitiveGlobs() {
  return [
    "!.ssh",
    "!.ssh/**",
    "!.gnupg",
    "!.gnupg/**",
    "!.env",
    "!.env.*",
    "!.netrc",
    "!.pgpass",
    "!.npmrc",
    "!.pypirc",
    "!.htpasswd",
    "!.git-credentials",
    "!authorized_keys*",
    "!id_rsa*",
    "!id_dsa*",
    "!id_ecdsa*",
    "!id_ed25519*",
    "!.aws/credentials",
    "!.config/gh/hosts.yml",
    "!.docker/config.json",
    "!.kube/config",
    "!etc/shadow",
    "!etc/gshadow",
    "!etc/sudoers",
    "!etc/sudoers.d/**",
  ]
}
