import { createHash } from "node:crypto"

export type AnubisChallenge = {
  id: string
  randomData: string
  difficulty: number
  algorithm: string
  basePrefix: string
}

export type AnubisSolution = {
  hash: string
  nonce: number
  elapsed: number
}

/**
 * Anubis raises the cost of automated access with a SHA-256 proof of work. The
 * browser bundle spreads the search across web workers, but the underlying rule
 * is small enough to reimplement directly: hash `randomData + nonce` until the
 * digest starts with `difficulty` zero nibbles.
 */
const MAX_DIFFICULTY = 6
const MAX_RANDOM_DATA = 512
const DEFAULT_MAX_ITERATIONS = 1 << 26
const DEFAULT_DEADLINE = 20_000
const YIELD_INTERVAL = 8192

function readJsonScript(html: string, id: string): unknown {
  const pattern = new RegExp(`<script[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)</script>`, "i")
  const raw = pattern.exec(html)?.[1]?.trim()
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

export function isAnubisChallenge(html: string): boolean {
  return html.includes("anubis_challenge") || html.includes("/.within.website/x/cmd/anubis/")
}

export function parseAnubisChallenge(html: string): AnubisChallenge | undefined {
  if (!isAnubisChallenge(html)) return undefined
  const payload = readJsonScript(html, "anubis_challenge")
  if (typeof payload !== "object" || payload === null) return undefined

  const record = payload as Record<string, unknown>
  const challenge = (typeof record.challenge === "object" && record.challenge !== null
    ? record.challenge
    : record) as Record<string, unknown>
  const rules = (typeof record.rules === "object" && record.rules !== null ? record.rules : {}) as Record<string, unknown>

  const id = challenge.id
  const randomData = challenge.randomData ?? challenge.random_data
  const difficulty = rules.difficulty ?? challenge.difficulty
  if (typeof id !== "string" || typeof randomData !== "string" || typeof difficulty !== "number") return undefined
  if (!Number.isInteger(difficulty) || difficulty < 1) return undefined
  // A hostile page could otherwise inflate the per-hash cost without raising
  // the advertised difficulty.
  if (id.length > MAX_RANDOM_DATA || randomData.length === 0 || randomData.length > MAX_RANDOM_DATA) return undefined

  const prefix = readJsonScript(html, "anubis_base_prefix")
  return {
    id,
    randomData,
    difficulty,
    algorithm: typeof rules.algorithm === "string" ? rules.algorithm : "fast",
    basePrefix: typeof prefix === "string" ? prefix : "",
  }
}

/**
 * The work is CPU bound, so the loop yields periodically to keep the event loop
 * responsive and to observe aborts. Both a wall-clock deadline and an iteration
 * cap apply, so a raised difficulty costs a bounded amount of time rather than
 * pinning a core indefinitely.
 */
export async function solveAnubis(
  challenge: Pick<AnubisChallenge, "randomData" | "difficulty">,
  options: { signal?: AbortSignal; maxIterations?: number; deadline?: number } = {},
): Promise<AnubisSolution> {
  if (challenge.difficulty > MAX_DIFFICULTY) {
    throw new Error(`anubis difficulty ${challenge.difficulty} exceeds the supported maximum of ${MAX_DIFFICULTY}`)
  }
  if (challenge.randomData.length > MAX_RANDOM_DATA) {
    throw new Error("anubis challenge data is larger than expected")
  }

  const wholeBytes = Math.floor(challenge.difficulty / 2)
  const halfByte = challenge.difficulty % 2 !== 0
  const limit = options.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const deadline = options.deadline ?? DEFAULT_DEADLINE
  const started = Date.now()

  for (let nonce = 0; nonce < limit; nonce++) {
    if ((nonce & (YIELD_INTERVAL - 1)) === 0) {
      options.signal?.throwIfAborted()
      if (Date.now() - started > deadline) {
        throw new Error(`anubis proof of work exceeded its ${deadline}ms budget`)
      }
      if (nonce > 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }

    const digest = createHash("sha256").update(challenge.randomData + String(nonce), "utf8").digest()
    let matched = true
    for (let index = 0; index < wholeBytes; index++) {
      if (digest[index] !== 0) {
        matched = false
        break
      }
    }
    if (matched && halfByte && digest[wholeBytes]! >> 4 !== 0) matched = false
    if (matched) return { hash: digest.toString("hex"), nonce, elapsed: Date.now() - started }
  }

  throw new Error(`anubis proof of work did not converge within ${limit} attempts`)
}

export function passChallengeUrl(
  origin: string,
  challenge: AnubisChallenge,
  solution: AnubisSolution,
  redirect: string,
): string {
  const url = new URL(`${challenge.basePrefix}/.within.website/x/cmd/anubis/api/pass-challenge`, origin)
  url.searchParams.set("id", challenge.id)
  url.searchParams.set("response", solution.hash)
  url.searchParams.set("nonce", String(solution.nonce))
  url.searchParams.set("redir", redirect)
  url.searchParams.set("elapsedTime", String(solution.elapsed))
  return url.toString()
}
