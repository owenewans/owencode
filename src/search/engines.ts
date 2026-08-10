import * as cheerio from "cheerio"
import { isAnubisChallenge, parseAnubisChallenge, passChallengeUrl, solveAnubis } from "./anubis.js"
import type { PageResponse, SearchClient } from "./client.js"

export const ENGINE_NAMES = ["startpage", "duckduckgo", "brave", "marginalia"] as const

export type EngineName = (typeof ENGINE_NAMES)[number]

export type SearchResult = {
  title: string
  url: string
  snippet: string
  engine: EngineName
}

export type EngineContext = {
  client: SearchClient
  limit: number
  signal?: AbortSignal
}

export type Engine = {
  name: EngineName
  label: string
  /** Hosts the engine is allowed to contact while running a search. */
  hosts: readonly string[]
  search(query: string, context: EngineContext): Promise<SearchResult[]>
}

/** Raised when an engine is reachable but refuses to serve results right now. */
export class EngineUnavailableError extends Error {
  constructor(engine: EngineName, reason: string) {
    super(`${engine} is currently unavailable: ${reason}`)
    this.name = "EngineUnavailableError"
  }
}

const TITLE_LIMIT = 300
const SNIPPET_LIMIT = 500

/**
 * Search pages carry soft hyphens and zero-width characters that survive text
 * extraction and corrupt both display and URL comparison.
 */
function clean(value: string, limit: number): string {
  const normalized = value
    .replace(/[\u00ad\u200b-\u200f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return normalized.length > limit ? `${normalized.slice(0, limit - 1).trimEnd()}…` : normalized
}

function document(body: string) {
  const $ = cheerio.load(body)
  // Startpage inlines emotion CSS inside each result; without this the styles
  // end up inside titles and snippets.
  $("style, script, noscript").remove()
  return $
}

function absoluteUrl(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined
  const trimmed = href.replace(/[\u00ad\u200b]/g, "").trim()
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("javascript:")) return undefined
  let resolved: URL
  try {
    resolved = new URL(trimmed, base)
  } catch {
    return undefined
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return undefined

  // DuckDuckGo wraps outbound links in a redirector that hides the real target.
  if (resolved.hostname.endsWith("duckduckgo.com") && resolved.pathname === "/l/") {
    const target = resolved.searchParams.get("uddg")
    if (target) return absoluteUrl(target, base)
  }
  return resolved.toString()
}

function collect(
  engine: EngineName,
  limit: number,
  entries: Array<{ title: string; url: string | undefined; snippet: string }>,
): SearchResult[] {
  const results: SearchResult[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (results.length >= limit) break
    if (!entry.url) continue
    const title = clean(entry.title, TITLE_LIMIT)
    if (!title) continue
    if (seen.has(entry.url)) continue
    seen.add(entry.url)
    results.push({ engine, title, url: entry.url, snippet: clean(entry.snippet, SNIPPET_LIMIT) })
  }
  return results
}

/**
 * Startpage fronts its search with Anubis. Solving the published proof of work
 * is the documented way through the interstitial; the challenge is bound to the
 * requesting User-Agent and address, so the same client must carry it.
 */
async function clearAnubis(
  engine: EngineName,
  response: PageResponse,
  context: EngineContext,
  origin: string,
  referer: string,
): Promise<PageResponse> {
  if (!isAnubisChallenge(response.body)) return response
  const challenge = parseAnubisChallenge(response.body)
  if (!challenge) throw new EngineUnavailableError(engine, "an unrecognised anti-bot challenge was served")
  if (challenge.algorithm !== "fast" && challenge.algorithm !== "slow") {
    throw new EngineUnavailableError(engine, `unsupported challenge algorithm ${challenge.algorithm}`)
  }

  const solution = await solveAnubis(challenge, { signal: context.signal })
  const passed = await context.client.get(passChallengeUrl(origin, challenge, solution, response.url), {
    referer,
    signal: context.signal,
  })
  if (isAnubisChallenge(passed.body)) {
    throw new EngineUnavailableError(engine, "the challenge response was rejected")
  }
  return passed
}

const startpage: Engine = {
  name: "startpage",
  label: "Startpage",
  hosts: ["startpage.com"],
  async search(query, context) {
    const origin = "https://www.startpage.com"
    let home = await context.client.get(`${origin}/`, { referer: `${origin}/`, signal: context.signal })
    home = await clearAnubis("startpage", home, context, origin, `${origin}/`)

    // The search form carries a per-session token; posting without it is
    // rejected, so the form is replayed rather than reconstructed.
    const $home = document(home.body)
    const form = $home("form").filter((_, element) => ($home(element).attr("action") ?? "").includes("search")).first()
    if (form.length === 0) throw new EngineUnavailableError("startpage", "the search form could not be located")

    const fields: Record<string, string> = {}
    form.find("input").each((_, element) => {
      const name = $home(element).attr("name")
      if (name) fields[name] = $home(element).attr("value") ?? ""
    })
    fields.query = query
    delete fields.q

    const action = new URL(form.attr("action") ?? "/sp/search", origin).toString()
    let response = await context.client.post(action, {
      form: fields,
      referer: `${origin}/`,
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      signal: context.signal,
    })
    response = await clearAnubis("startpage", response, context, origin, `${origin}/`)
    if (response.statusCode >= 400) {
      throw new EngineUnavailableError("startpage", `search returned HTTP ${response.statusCode}`)
    }

    const $ = document(response.body)
    const entries = $(".result")
      .toArray()
      .map((element) => {
        const node = $(element)
        const link = node.find("a.result-link").first()
        return {
          title: node.find("h2").first().text() || link.text(),
          url: absoluteUrl(link.attr("href"), origin),
          snippet: node.find("p").first().text(),
        }
      })
    return collect("startpage", context.limit, entries)
  },
}

const duckduckgo: Engine = {
  name: "duckduckgo",
  label: "DuckDuckGo Lite",
  hosts: ["duckduckgo.com"],
  async search(query, context) {
    const endpoint = "https://lite.duckduckgo.com/lite/"
    const response = await context.client.post(endpoint, {
      form: { q: query },
      referer: "https://lite.duckduckgo.com/",
      headers: { origin: "https://lite.duckduckgo.com", "content-type": "application/x-www-form-urlencoded" },
      signal: context.signal,
    })

    if (response.statusCode === 202 || /anomaly\.js|bots use duckduckgo/i.test(response.body)) {
      throw new EngineUnavailableError("duckduckgo", "an anti-bot challenge was served")
    }
    if (response.statusCode >= 400) {
      throw new EngineUnavailableError("duckduckgo", `search returned HTTP ${response.statusCode}`)
    }

    const $ = document(response.body)
    const entries = $("a.result-link")
      .toArray()
      .map((element) => {
        const link = $(element)
        const row = link.closest("tr")
        return {
          title: link.text(),
          url: absoluteUrl(link.attr("href"), endpoint),
          snippet: row.nextAll("tr").find("td.result-snippet").first().text(),
        }
      })
    return collect("duckduckgo", context.limit, entries)
  },
}

const brave: Engine = {
  name: "brave",
  label: "Brave Search",
  hosts: ["search.brave.com"],
  async search(query, context) {
    const endpoint = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`
    const response = await context.client.get(endpoint, {
      referer: "https://search.brave.com/",
      headers: { cookie: "safesearch=off" },
      signal: context.signal,
    })

    if (response.statusCode === 403 || response.statusCode === 429) {
      throw new EngineUnavailableError("brave", `search returned HTTP ${response.statusCode}`)
    }
    if (response.statusCode >= 400) {
      throw new EngineUnavailableError("brave", `search returned HTTP ${response.statusCode}`)
    }

    const $ = document(response.body)
    const entries = $('.snippet[data-type="web"]')
      .toArray()
      .map((element) => {
        const node = $(element)
        const link = node.find("a[href]").first()
        const description = node.find(".snippet-description").first()
        return {
          title: node.find(".title").first().text() || link.text(),
          url: absoluteUrl(link.attr("href"), endpoint),
          snippet: (description.length > 0 ? description : node.find(".content").first()).text(),
        }
      })
    return collect("brave", context.limit, entries)
  },
}

const marginalia: Engine = {
  name: "marginalia",
  label: "Marginalia Search",
  hosts: ["old-search.marginalia.nu", "marginalia-search.com"],
  async search(query, context) {
    const parameters = new URLSearchParams({
      query,
      js: "default",
      adtech: "default",
      searchTitle: "default",
      profile: "corpo",
      recent: "default",
      sst: "",
    })
    const endpoint = `https://old-search.marginalia.nu/search?${parameters}`
    let response = await context.client.get(endpoint, {
      referer: "https://old-search.marginalia.nu/",
      signal: context.signal,
    })

    // The old interface is explicitly offered to text-based clients and has a
    // small, stable result layout. Keep the current interface as a fallback in
    // case the legacy hostname is unavailable.
    if (response.statusCode >= 400) {
      const fallback = new URLSearchParams({ query, profile: "corpo" })
      response = await context.client.get(`https://marginalia-search.com/search?${fallback}`, {
        referer: "https://marginalia-search.com/",
        signal: context.signal,
      })
    }

    if (/Wait A Moment|aggressive bot activity/i.test(response.body)) {
      throw new EngineUnavailableError("marginalia", "the index is rate limiting requests")
    }
    if (response.statusCode >= 400) {
      throw new EngineUnavailableError("marginalia", `search returned HTTP ${response.statusCode}`)
    }

    const $ = document(response.body)
    const oldEntries = $("section.card.search-result")
      .toArray()
      .map((element) => {
        const card = $(element)
        const link = card.find("h2 > a.title, h2 > a").first()
        return {
          title: link.text(),
          url: absoluteUrl(link.attr("href"), endpoint),
          snippet: card.find("p.description").first().text(),
        }
      })
    const currentEntries = $("main h2 > a")
      .toArray()
      .map((element) => {
        const link = $(element)
        const card = link.closest("div[class*='bg-white']")
        const paragraphs = card
          .find("p")
          .toArray()
          .map((paragraph) => clean($(paragraph).text(), SNIPPET_LIMIT))
          // The first paragraph of a card is document metadata, not a summary.
          .filter((text) => text.length > 0 && !/^\d[\d,]*\s+words\b/i.test(text))
        const snippet = paragraphs.sort((left, right) => right.length - left.length)[0] ?? ""
        return { title: link.text(), url: absoluteUrl(link.attr("href"), endpoint), snippet }
      })
    return collect("marginalia", context.limit, oldEntries.length > 0 ? oldEntries : currentEntries)
  },
}

export const ENGINES: Record<EngineName, Engine> = { startpage, duckduckgo, brave, marginalia }
