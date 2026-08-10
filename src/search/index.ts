import { createClient, isSocksProxy, type SearchClient } from "./client.js"
import { createCycleClient } from "./cycle-client.js"
import { ENGINE_NAMES, ENGINES, EngineUnavailableError, type EngineName, type SearchResult } from "./engines.js"

export { ENGINE_NAMES, ENGINES, EngineUnavailableError } from "./engines.js"
export type { EngineName, SearchResult } from "./engines.js"
export type { SearchClient } from "./client.js"

export type SearchSettings = {
  proxy?: string
  engines: EngineName[]
  timeout: number
  maxResults: number
  maxBytes: number
}

export type SearchMode = "auto" | "all"

export type SearchFailure = {
  engine: EngineName
  reason: string
}

export type SearchReport = {
  query: string
  results: SearchResult[]
  used: EngineName[]
  fallbacks: EngineName[]
  failures: SearchFailure[]
  proxy?: string
}

/**
 * Search traffic defaults to the local SOCKS listener because several of these
 * engines are unreachable on a direct connection from many networks.
 */
const DEFAULT_PROXY = "socks5h://127.0.0.1:1080"
const DEFAULT_TIMEOUT = 30_000
const DEFAULT_MAX_RESULTS = 10
const MAX_RESULTS_CEILING = 25
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

function parseProxy(value: unknown): string | undefined {
  if (value === false || value === "none" || value === "direct" || value === "") return undefined
  const proxy = value ?? DEFAULT_PROXY
  if (typeof proxy !== "string") throw new Error("owencode: searchProxy must be a string or false")
  if (!isSocksProxy(proxy) && !/^https?:\/\//i.test(proxy)) {
    throw new Error("owencode: searchProxy must be a socks or http proxy URL")
  }
  try {
    new URL(proxy)
  } catch {
    throw new Error("owencode: searchProxy must be a valid URL")
  }
  return proxy
}

function parseEngines(value: unknown): EngineName[] {
  if (value === undefined) return [...ENGINE_NAMES]
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("owencode: searchEngines must be a non-empty array")
  }
  const engines = value.map((entry) => {
    if (typeof entry !== "string" || !ENGINE_NAMES.includes(entry as EngineName)) {
      throw new Error(`owencode: unknown search engine ${String(entry)}`)
    }
    return entry as EngineName
  })
  // Duplicates would otherwise fan out into repeated concurrent requests.
  return [...new Set(engines)]
}

function parseInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || Number(resolved) < minimum || Number(resolved) > maximum) {
    throw new Error(`owencode: ${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return Number(resolved)
}

export function resolveSearchSettings(
  input: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SearchSettings {
  const configured = env.OWENCODE_SEARCH_PROXY ?? input?.searchProxy
  return {
    proxy: parseProxy(configured),
    engines: parseEngines(input?.searchEngines),
    timeout: parseInteger(input?.searchTimeout, DEFAULT_TIMEOUT, 1_000, 120_000, "searchTimeout"),
    maxResults: parseInteger(input?.searchMaxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_CEILING, "searchMaxResults"),
    maxBytes: parseInteger(input?.searchMaxBytes, DEFAULT_MAX_BYTES, 64 * 1024, 32 * 1024 * 1024, "searchMaxBytes"),
  }
}

/**
 * Engines disagree about trailing slashes, host casing and tracking parameters,
 * so identity is compared on a normalised form while the original URL is kept.
 */
const TRACKING_PARAMETERS = /^(utm_|fbclid$|gclid$|mc_[ce]id$|ref_?src$|igshid$)/i

export function normalizeUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return value
  }
  url.hash = ""
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "")
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETERS.test(key)) url.searchParams.delete(key)
  }
  const path = url.pathname.replace(/\/+$/, "")
  const port = url.port ? `:${url.port}` : ""
  return `${url.hostname}${port}${path}${url.search}`
}

type Ranked = {
  result: SearchResult
  engines: Set<EngineName>
  bestRank: number
}

function merge(batches: SearchResult[][], limit: number): SearchResult[] {
  const ranked = new Map<string, Ranked>()
  for (const batch of batches) {
    batch.forEach((result, index) => {
      const key = normalizeUrl(result.url)
      const existing = ranked.get(key)
      if (existing) {
        existing.engines.add(result.engine)
        existing.bestRank = Math.min(existing.bestRank, index)
        // Prefer the longer summary; engines truncate differently.
        if (result.snippet.length > existing.result.snippet.length) existing.result.snippet = result.snippet
        return
      }
      ranked.set(key, { result: { ...result }, engines: new Set([result.engine]), bestRank: index })
    })
  }

  return [...ranked.values()]
    .sort((left, right) => right.engines.size - left.engines.size || left.bestRank - right.bestRank)
    .slice(0, limit)
    .map((entry) => entry.result)
}

function describe(error: unknown): string {
  if (error instanceof EngineUnavailableError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

export async function webSearch(options: {
  query: string
  settings: SearchSettings
  mode?: SearchMode
  engines?: EngineName[]
  limit?: number
  signal?: AbortSignal
  /** Overrides the HTTP client, primarily so engine parsing can be tested offline. */
  client?: (engine: EngineName) => SearchClient
  /** Overrides the two transport stages for fallback orchestration tests. */
  primaryClient?: (engine: EngineName) => SearchClient
  fallbackClient?: (engine: EngineName) => Promise<SearchClient>
}): Promise<SearchReport> {
  const query = options.query.trim()
  if (!query) throw new Error("search query must not be empty")

  const settings = options.settings
  // A tool call may narrow the configured maximum but never widen it.
  const limit = Math.min(options.limit ?? settings.maxResults, settings.maxResults, MAX_RESULTS_CEILING)
  const selected = options.engines?.length ? options.engines : settings.engines
  const mode: SearchMode = options.mode ?? "auto"

  const failures: SearchFailure[] = []
  const used: EngineName[] = []
  const fallbacks: EngineName[] = []
  const batches: SearchResult[][] = []

  const run = async (name: EngineName) => {
    const engine = ENGINES[name]
    if (options.client) {
      const client = options.client(name)
      try {
        return { results: await engine.search(query, { client, limit, signal: options.signal }), fallback: false }
      } finally {
        await client.close?.()
      }
    }

    const clientSettings = {
      proxy: settings.proxy,
      timeout: settings.timeout,
      maxBytes: settings.maxBytes,
      allowedHosts: engine.hosts,
    }
    const primary = options.primaryClient ? options.primaryClient(name) : createClient(clientSettings)
    let primaryError: unknown
    try {
      const results = await engine.search(query, { client: primary, limit, signal: options.signal })
      if (results.length > 0) return { results, fallback: false }
      primaryError = new Error("returned no results")
    } catch (error) {
      if (options.signal?.aborted) throw error
      primaryError = error
    } finally {
      await primary.close?.()
    }

    const fallback = options.fallbackClient ? await options.fallbackClient(name) : await createCycleClient(clientSettings)
    try {
      const results = await engine.search(query, { client: fallback, limit, signal: options.signal })
      if (results.length > 0) return { results, fallback: true }
      throw new Error("returned no results")
    } catch (error) {
      if (options.signal?.aborted) throw error
      throw new Error(`got-scraping: ${describe(primaryError)}; cycletls: ${describe(error)}`)
    } finally {
      await fallback.close?.()
    }
  }

  if (mode === "all") {
    const settled = await Promise.all(
      selected.map(async (name) => ({ name, outcome: await run(name).then((result) => result, (error) => ({ error })) })),
    )
    // A cancelled search must surface the abort rather than the results that
    // happened to arrive before it.
    options.signal?.throwIfAborted()
    for (const { name, outcome } of settled) {
      if ("error" in outcome) {
        failures.push({ engine: name, reason: describe(outcome.error) })
        continue
      }
      if (outcome.results.length === 0) {
        failures.push({ engine: name, reason: "returned no results" })
        continue
      }
      used.push(name)
      if (outcome.fallback) fallbacks.push(name)
      batches.push(outcome.results)
    }
  } else {
    for (const name of selected) {
      options.signal?.throwIfAborted()
      try {
        const outcome = await run(name)
        if (outcome.results.length === 0) {
          failures.push({ engine: name, reason: "returned no results" })
          continue
        }
        used.push(name)
        if (outcome.fallback) fallbacks.push(name)
        batches.push(outcome.results)
        break
      } catch (error) {
        if (options.signal?.aborted) throw error
        failures.push({ engine: name, reason: describe(error) })
      }
    }
  }

  if (batches.length === 0) {
    const detail = failures.map((failure) => `${failure.engine}: ${failure.reason}`).join("; ")
    throw new Error(`no search engine returned results${detail ? ` (${detail})` : ""}`)
  }

  return { query, results: merge(batches, limit), used, fallbacks, failures, proxy: settings.proxy }
}

/** Strips any credentials so a proxy URL can be shown in approvals and logs. */
export function redactProxy(proxy: string | undefined): string {
  if (!proxy) return "direct"
  try {
    const url = new URL(proxy)
    if (url.username || url.password) {
      url.username = ""
      url.password = ""
      return `${url.protocol}//***@${url.host}`
    }
    return `${url.protocol}//${url.host}`
  } catch {
    return "configured"
  }
}

export function renderReport(report: SearchReport): string {
  const lines = report.results.map((result, index) => {
    const parts = [`${index + 1}. ${result.title}`, `   ${result.url}`]
    if (result.snippet) parts.push(`   ${result.snippet}`)
    return parts.join("\n")
  })
  if (report.failures.length > 0) {
    lines.push("", `unavailable: ${report.failures.map((f) => `${f.engine} (${f.reason})`).join(", ")}`)
  }
  if (report.fallbacks.length > 0) {
    lines.push("", `cycletls fallback: ${report.fallbacks.join(", ")}`)
  }
  return lines.join("\n\n")
}
