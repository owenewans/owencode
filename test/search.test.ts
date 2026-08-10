import { describe, expect, it } from "vitest"
import type { FetchOptions, PageResponse, SearchClient } from "../src/search/client.js"
import { ENGINES } from "../src/search/engines.js"
import { hostAllowed } from "../src/search/client.js"
import { normalizeUrl, redactProxy, renderReport, resolveSearchSettings, webSearch, type EngineName } from "../src/search/index.js"

type Route = (url: string, method: "get" | "post", options: FetchOptions) => PageResponse | string | undefined

function client(route: Route): SearchClient {
  const call = (method: "get" | "post") => async (url: string, options: FetchOptions = {}): Promise<PageResponse> => {
    const outcome = route(url, method, options)
    if (outcome === undefined) throw new Error(`unexpected ${method} ${url}`)
    if (typeof outcome === "string") return { url, statusCode: 200, body: outcome }
    return outcome
  }
  return { get: call("get"), post: call("post") }
}

const settings = resolveSearchSettings({ searchProxy: false })

const startpageChallenge = `<html><head>
<script id="anubis_challenge" type="application/json">{"rules":{"algorithm":"fast","difficulty":2},"challenge":{"id":"abc","randomData":"seed","difficulty":2}}</script>
<script id="anubis_base_prefix" type="application/json">""</script>
</head><body>Verifying your request...</body></html>`

const startpageHome = `<html><body><form action="/sp/search" method="post">
<input name="query" value=""><input name="sc" value="TOKEN123"><input name="t" value="device">
</form></body></html>`

const startpageResults = `<html><body>
<div class="result"><style>.css-a{color:red}</style>
  <a class="result-link" href="https://doc.rust-lang.org/book/ch04.html"><span>link</span></a>
  <h2>What is Ownership?</h2>
  <p>Ownership is a set of rules that govern memory.</p>
</div>
<div class="result">
  <a class="result-link" href="https://users.rust-lang.org/t/1"></a>
  <h2>Ownership and borrowing</h2>
  <p>Forum discussion about ownership.</p>
</div>
</body></html>`

describe("search settings", () => {
  it("defaults to the local socks listener", () => {
    expect(resolveSearchSettings(undefined, {})).toMatchObject({
      proxy: "socks5h://127.0.0.1:1080",
      engines: ["startpage", "duckduckgo", "brave", "marginalia"],
      timeout: 30_000,
      maxResults: 10,
    })
  })

  it("allows a direct connection and an explicit proxy", () => {
    expect(resolveSearchSettings({ searchProxy: false }, {}).proxy).toBeUndefined()
    expect(resolveSearchSettings({ searchProxy: "socks5://10.0.0.1:9050" }, {}).proxy).toBe("socks5://10.0.0.1:9050")
    expect(resolveSearchSettings({}, { OWENCODE_SEARCH_PROXY: "http://proxy:8080" }).proxy).toBe("http://proxy:8080")
  })

  it("rejects invalid configuration", () => {
    expect(() => resolveSearchSettings({ searchProxy: "ftp://host" }, {})).toThrow("socks or http proxy")
    expect(() => resolveSearchSettings({ searchEngines: [] }, {})).toThrow("non-empty array")
    expect(() => resolveSearchSettings({ searchEngines: ["google"] }, {})).toThrow("unknown search engine")
    expect(() => resolveSearchSettings({ searchMaxResults: 0 }, {})).toThrow("searchMaxResults")
    expect(() => resolveSearchSettings({ searchTimeout: 10 }, {})).toThrow("searchTimeout")
  })

  it("collapses duplicate engines", () => {
    expect(resolveSearchSettings({ searchEngines: ["brave", "brave", "duckduckgo"] }, {}).engines).toEqual([
      "brave",
      "duckduckgo",
    ])
  })

  it("never exposes proxy credentials", () => {
    expect(redactProxy("socks5h://user:secret@127.0.0.1:1080")).toBe("socks5h://***@127.0.0.1:1080")
    expect(redactProxy("socks5h://127.0.0.1:1080")).toBe("socks5h://127.0.0.1:1080")
    expect(redactProxy(undefined)).toBe("direct")
  })
})

describe("host confinement", () => {
  it("matches an engine host and its subdomains only", () => {
    expect(hostAllowed("www.startpage.com", ["startpage.com"])).toBe(true)
    expect(hostAllowed("startpage.com", ["startpage.com"])).toBe(true)
    expect(hostAllowed("evil-startpage.com", ["startpage.com"])).toBe(false)
    expect(hostAllowed("startpage.com.attacker.net", ["startpage.com"])).toBe(false)
    expect(hostAllowed("169.254.169.254", ["startpage.com"])).toBe(false)
  })
})

describe("url handling", () => {
  it("normalises hosts, trailing slashes and tracking parameters", () => {
    expect(normalizeUrl("https://WWW.Example.com/path/?utm_source=x&id=7#top")).toBe("example.com/path?id=7")
    expect(normalizeUrl("https://example.com/path")).toBe(normalizeUrl("http://www.example.com/path/"))
    expect(normalizeUrl("not a url")).toBe("not a url")
  })
})

describe("startpage engine", () => {
  it("solves the challenge, replays the form token and parses results", async () => {
    const seen: string[] = []
    const posted: Record<string, string>[] = []
    const engine = ENGINES.startpage
    const results = await engine.search("rust ownership", {
      limit: 10,
      client: client((url, method, options) => {
        seen.push(`${method} ${url.split("?")[0]}`)
        if (method === "get" && url === "https://www.startpage.com/") return startpageChallenge
        if (url.includes("pass-challenge")) {
          const parameters = new URL(url).searchParams
          expect(parameters.get("id")).toBe("abc")
          expect(Number(parameters.get("nonce"))).toBeGreaterThanOrEqual(0)
          return startpageHome
        }
        if (method === "post" && url === "https://www.startpage.com/sp/search") {
          posted.push(options.form ?? {})
          return startpageResults
        }
        return undefined
      }),
    })

    expect(posted[0]).toMatchObject({ query: "rust ownership", sc: "TOKEN123", t: "device" })
    expect(seen).toContain("get https://www.startpage.com/.within.website/x/cmd/anubis/api/pass-challenge")
    expect(results).toEqual([
      {
        engine: "startpage",
        title: "What is Ownership?",
        url: "https://doc.rust-lang.org/book/ch04.html",
        snippet: "Ownership is a set of rules that govern memory.",
      },
      {
        engine: "startpage",
        title: "Ownership and borrowing",
        url: "https://users.rust-lang.org/t/1",
        snippet: "Forum discussion about ownership.",
      },
    ])
  })

  it("reports failure when the challenge is served again", async () => {
    await expect(
      ENGINES.startpage.search("query", {
        limit: 5,
        client: client(() => startpageChallenge),
      }),
    ).rejects.toThrow("challenge response was rejected")
  })
})

describe("duckduckgo engine", () => {
  it("decodes redirect links and pairs snippets with titles", async () => {
    const results = await ENGINES.duckduckgo.search("rust", {
      limit: 10,
      client: client(() => `<html><body><table>
        <tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=abc">Example A</a></td></tr>
        <tr><td class="result-snippet">Snippet A</td></tr>
        <tr><td><a class="result-link" href="https://example.com/b">Example B</a></td></tr>
        <tr><td class="result-snippet">Snippet B</td></tr>
      </table></body></html>`),
    })

    expect(results).toEqual([
      { engine: "duckduckgo", title: "Example A", url: "https://example.com/a", snippet: "Snippet A" },
      { engine: "duckduckgo", title: "Example B", url: "https://example.com/b", snippet: "Snippet B" },
    ])
  })

  it("treats the anomaly interstitial as unavailable", async () => {
    await expect(
      ENGINES.duckduckgo.search("rust", {
        limit: 5,
        client: client(() => ({ url: "https://lite.duckduckgo.com/lite/", statusCode: 202, body: "<html>anomaly.js</html>" })),
      }),
    ).rejects.toThrow("anti-bot challenge")
  })
})

describe("brave engine", () => {
  it("parses web snippets only", async () => {
    const results = await ENGINES.brave.search("rust", {
      limit: 10,
      client: client(() => `<html><body>
        <div class="snippet" data-type="web">
          <a href="https://example.org/x"><div class="title">Title X</div></a>
          <div class="snippet-description">Description X</div>
        </div>
        <div class="snippet" data-type="news">
          <a href="https://news.example/y"><div class="title">News Y</div></a>
        </div>
      </body></html>`),
    })

    expect(results).toEqual([
      { engine: "brave", title: "Title X", url: "https://example.org/x", snippet: "Description X" },
    ])
  })

  it("surfaces rate limiting", async () => {
    await expect(
      ENGINES.brave.search("rust", {
        limit: 5,
        client: client(() => ({ url: "https://search.brave.com/search", statusCode: 429, body: "" })),
      }),
    ).rejects.toThrow("HTTP 429")
  })
})

describe("marginalia engine", () => {
  it("parses the old text-oriented interface", async () => {
    const results = await ENGINES.marginalia.search("hi", {
      limit: 10,
      client: client(() => `<html><body>
        <section class="card search-result">
          <div class="url"><a href="https://example.com/hi">https://example.com/hi</a></div>
          <h2><a class="title" href="https://example.com/hi">Hello there</a></h2>
          <p class="description">A result from the old Marginalia interface.</p>
        </section>
      </body></html>`),
    })

    expect(results).toEqual([
      {
        engine: "marginalia",
        title: "Hello there",
        url: "https://example.com/hi",
        snippet: "A result from the old Marginalia interface.",
      },
    ])
  })

  it("removes soft hyphens and skips document metadata", async () => {
    const results = await ENGINES.marginalia.search("plan9", {
      limit: 10,
      client: client(() => `<html><body><main>
        <div class="bg-white p-4">
          <h2><a href="https://plan9.example/os">Plan9\u00ad Operating\u00ad System</a></h2>
          <p>536 words [ ] - Last update: 2026-04-22</p>
          <p>Plan 9 was developed at Bell Labs as a distributed operating system.</p>
        </div>
      </main></body></html>`),
    })

    expect(results).toEqual([
      {
        engine: "marginalia",
        title: "Plan9 Operating System",
        url: "https://plan9.example/os",
        snippet: "Plan 9 was developed at Bell Labs as a distributed operating system.",
      },
    ])
  })

  it("detects the rate limit page", async () => {
    await expect(
      ENGINES.marginalia.search("hello", {
        limit: 5,
        client: client(() => "<html><body><h1>Wait A Moment</h1>aggressive bot activity</body></html>"),
      }),
    ).rejects.toThrow("rate limiting")
  })
})

describe("orchestration", () => {
  const braveHtml = `<html><body><div class="snippet" data-type="web">
    <a href="https://example.com/shared/"><div class="title">Shared result</div></a>
    <div class="snippet-description">From Brave</div></div></body></html>`
  const ddgHtml = `<html><body><table>
    <tr><td><a class="result-link" href="https://www.example.com/shared">Shared result</a></td></tr>
    <tr><td class="result-snippet">A noticeably longer summary from DuckDuckGo.</td></tr>
    <tr><td><a class="result-link" href="https://example.com/unique">Unique result</a></td></tr>
    <tr><td class="result-snippet">Only DuckDuckGo has this.</td></tr>
  </table></body></html>`

  const routed = (engine: EngineName) =>
    client((url) => {
      if (engine === "brave") return braveHtml
      if (engine === "duckduckgo") return ddgHtml
      if (engine === "marginalia") return "<html><body><h1>Wait A Moment</h1>aggressive bot activity</body></html>"
      return url.includes("sp/search") ? "<html><body></body></html>" : startpageHome
    })

  it("falls back to the next engine and records why the earlier one failed", async () => {
    const report = await webSearch({
      query: "shared",
      settings,
      engines: ["marginalia", "brave"],
      client: routed,
    })

    expect(report.used).toEqual(["brave"])
    expect(report.failures).toEqual([{ engine: "marginalia", reason: expect.stringContaining("rate limiting") }])
    expect(report.results).toHaveLength(1)
  })

  it("restarts the same engine through the fallback transport", async () => {
    let primaryClosed = false
    let fallbackClosed = false
    const report = await webSearch({
      query: "shared",
      settings,
      engines: ["brave"],
      primaryClient: () => ({
        ...client(() => {
          throw new Error("socket reset")
        }),
        async close() {
          primaryClosed = true
        },
      }),
      fallbackClient: async () => ({
        ...client(() => braveHtml),
        async close() {
          fallbackClosed = true
        },
      }),
    })

    expect(report.used).toEqual(["brave"])
    expect(report.fallbacks).toEqual(["brave"])
    expect(report.results).toHaveLength(1)
    expect(primaryClosed).toBe(true)
    expect(fallbackClosed).toBe(true)
    expect(renderReport(report)).toContain("cycletls fallback: brave")
  })

  it("merges every engine and ranks agreement first in all mode", async () => {
    const report = await webSearch({
      query: "shared",
      settings,
      mode: "all",
      engines: ["brave", "duckduckgo", "marginalia"],
      client: routed,
    })

    expect(report.used.sort()).toEqual(["brave", "duckduckgo"])
    expect(report.results[0]).toMatchObject({ title: "Shared result", url: "https://example.com/shared/" })
    // The longer of the two competing summaries survives the merge.
    expect(report.results[0]!.snippet).toBe("A noticeably longer summary from DuckDuckGo.")
    expect(report.results.map((result) => result.url)).toContain("https://example.com/unique")
  })

  it("honours the result limit", async () => {
    const report = await webSearch({ query: "shared", settings, engines: ["duckduckgo"], limit: 1, client: routed })
    expect(report.results).toHaveLength(1)
  })

  it("does not let a tool call widen the configured maximum", async () => {
    const capped = resolveSearchSettings({ searchProxy: false, searchMaxResults: 1 })
    const report = await webSearch({ query: "shared", settings: capped, engines: ["duckduckgo"], limit: 25, client: routed })
    expect(report.results).toHaveLength(1)
  })

  it("propagates cancellation in all mode even when an engine answered", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      webSearch({ query: "shared", settings, mode: "all", engines: ["brave"], client: routed, signal: controller.signal }),
    ).rejects.toThrow()
  })

  it("fails with a combined explanation when nothing answers", async () => {
    await expect(
      webSearch({ query: "shared", settings, engines: ["marginalia"], client: routed }),
    ).rejects.toThrow(/no search engine returned results.*marginalia/s)
  })

  it("rejects an empty query", async () => {
    await expect(webSearch({ query: "   ", settings })).rejects.toThrow("must not be empty")
  })

  it("renders results and unavailable engines", async () => {
    const report = await webSearch({ query: "shared", settings, engines: ["marginalia", "duckduckgo"], client: routed })
    const rendered = renderReport(report)

    expect(rendered).toContain("1. Shared result")
    expect(rendered).toContain("https://www.example.com/shared")
    expect(rendered).toContain("unavailable: marginalia")
  })
})
