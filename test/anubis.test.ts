import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { isAnubisChallenge, parseAnubisChallenge, passChallengeUrl, solveAnubis } from "../src/search/anubis.js"

const challengePage = `<!doctype html><html><head>
<script id="anubis_version" type="application/json">"v1.25.0"</script>
<script id="anubis_challenge" type="application/json">{"rules":{"algorithm":"fast","difficulty":3},"challenge":{"id":"019fec35-65d9-775e-9d7a-12ec45b618e9","randomData":"6b0bdbf1d912e0a2","difficulty":3,"metadata":{"User-Agent":"Mozilla/5.0","X-Real-Ip":"203.0.113.5"}}}</script>
<script id="anubis_base_prefix" type="application/json">""</script>
</head><body>Verifying your request...</body></html>`

function leadingZeroNibbles(hash: string): number {
  return /^0*/.exec(hash)![0].length
}

describe("anubis", () => {
  it("detects and parses a challenge page", () => {
    expect(isAnubisChallenge(challengePage)).toBe(true)
    expect(parseAnubisChallenge(challengePage)).toEqual({
      id: "019fec35-65d9-775e-9d7a-12ec45b618e9",
      randomData: "6b0bdbf1d912e0a2",
      difficulty: 3,
      algorithm: "fast",
      basePrefix: "",
    })
  })

  it("ignores ordinary pages and malformed payloads", () => {
    expect(isAnubisChallenge("<html><body>results</body></html>")).toBe(false)
    expect(parseAnubisChallenge("<html><body>results</body></html>")).toBeUndefined()
    expect(parseAnubisChallenge('<script id="anubis_challenge">not json</script>')).toBeUndefined()
    expect(parseAnubisChallenge('<script id="anubis_challenge">{"challenge":{}}</script>')).toBeUndefined()
  })

  it("produces a digest matching the requested difficulty", async () => {
    const challenge = { randomData: "6b0bdbf1d912e0a2", difficulty: 3 }
    const solution = await solveAnubis(challenge)
    const digest = createHash("sha256").update(challenge.randomData + String(solution.nonce), "utf8").digest("hex")

    expect(solution.hash).toBe(digest)
    expect(leadingZeroNibbles(solution.hash)).toBeGreaterThanOrEqual(challenge.difficulty)
    expect(solution.nonce).toBeGreaterThanOrEqual(0)
  })

  it("handles odd and even difficulties consistently", async () => {
    for (const difficulty of [1, 2, 3, 4]) {
      const solution = await solveAnubis({ randomData: "seed", difficulty })
      expect(leadingZeroNibbles(solution.hash)).toBeGreaterThanOrEqual(difficulty)
    }
  })

  it("refuses difficulties beyond the supported ceiling", async () => {
    await expect(solveAnubis({ randomData: "seed", difficulty: 32 })).rejects.toThrow("exceeds the supported maximum")
  })

  it("stops when the work cannot converge within the iteration budget", async () => {
    await expect(solveAnubis({ randomData: "seed", difficulty: 6 }, { maxIterations: 64 })).rejects.toThrow("did not converge")
  })

  it("stops when the wall-clock budget expires", async () => {
    await expect(solveAnubis({ randomData: "seed", difficulty: 6 }, { deadline: 1 })).rejects.toThrow("budget")
  })

  it("rejects oversized challenge data", async () => {
    const oversized = "a".repeat(600)
    expect(parseAnubisChallenge(`<script id="anubis_challenge">{"rules":{"difficulty":2},"challenge":{"id":"x","randomData":"${oversized}"}}</script>`)).toBeUndefined()
    await expect(solveAnubis({ randomData: oversized, difficulty: 2 })).rejects.toThrow("larger than expected")
  })

  it("honours an aborted signal", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(solveAnubis({ randomData: "seed", difficulty: 6 }, { signal: controller.signal })).rejects.toThrow()
  })

  it("builds a pass-challenge url with every required parameter", () => {
    const challenge = parseAnubisChallenge(challengePage)!
    const url = new URL(
      passChallengeUrl("https://www.startpage.com", challenge, { hash: "000abc", nonce: 42, elapsed: 105 }, "https://www.startpage.com/sp/search?query=hi"),
    )

    expect(url.pathname).toBe("/.within.website/x/cmd/anubis/api/pass-challenge")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      id: challenge.id,
      response: "000abc",
      nonce: "42",
      redir: "https://www.startpage.com/sp/search?query=hi",
      elapsedTime: "105",
    })
  })

  it("respects a non-empty base prefix", () => {
    const url = passChallengeUrl(
      "https://example.com",
      { id: "a", randomData: "b", difficulty: 1, algorithm: "fast", basePrefix: "/gateway" },
      { hash: "0f", nonce: 1, elapsed: 1 },
      "https://example.com/",
    )
    expect(new URL(url).pathname).toBe("/gateway/.within.website/x/cmd/anubis/api/pass-challenge")
  })
})
