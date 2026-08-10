import { gotScraping } from "got-scraping"
import { SocksProxyAgent } from "socks-proxy-agent"
import { CookieJar } from "tough-cookie"

export type PageResponse = {
  url: string
  statusCode: number
  body: string
}

export type FetchOptions = {
  referer?: string
  headers?: Record<string, string>
  form?: Record<string, string>
  signal?: AbortSignal
  timeout?: number
}

export type SearchClient = {
  get(url: string, options?: FetchOptions): Promise<PageResponse>
  post(url: string, options?: FetchOptions): Promise<PageResponse>
  close?(): Promise<void>
}

export type ClientSettings = {
  proxy?: string
  timeout: number
  maxBytes: number
  /** Hosts this client may contact, including after a redirect. */
  allowedHosts: readonly string[]
}

export function isSocksProxy(proxy: string): boolean {
  return /^socks(4a?|5h?)?:\/\//i.test(proxy)
}

export function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`))
}

/**
 * Engine responses are untrusted, and they drive later requests through form
 * actions, challenge prefixes and redirects. Confining every request to the
 * engine's own hosts keeps a hostile or tampered page from steering the client
 * at internal addresses.
 */
function assertAllowed(url: string, allowed: readonly string[]): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`refusing to request an invalid url: ${url}`)
  }
  if (parsed.protocol !== "https:") throw new Error(`refusing to request a non-https url: ${parsed.protocol}//`)
  if (!hostAllowed(parsed.hostname, allowed)) throw new Error(`refusing to request an unexpected host: ${parsed.hostname}`)
  return parsed
}

export function createClient(settings: ClientSettings): SearchClient {
  const cookieJar = new CookieJar()
  const sessionToken = {}
  const proxy = settings.proxy
  const allowed = settings.allowedHosts

  const base: Record<string, unknown> = {
    cookieJar,
    sessionToken,
    // A SOCKS tunnel can occasionally be reset before the origin replies.
    // Retry one transport failure, but never retry HTTP rate limits or other
    // status codes that deliberately ask clients to back off.
    retry: {
      limit: 1,
      methods: ["GET", "POST"],
      statusCodes: [],
      errorCodes: ["ETIMEDOUT", "ECONNRESET", "EADDRINUSE", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "ENETUNREACH", "EAI_AGAIN"],
    },
    throwHttpErrors: false,
    followRedirect: true,
    maxRedirects: 5,
    decompress: true,
    responseType: "text",
    // got-scraping disables certificate verification by default, which would
    // leave every query and result open to tampering on the proxy path.
    https: { rejectUnauthorized: true },
    hooks: {
      beforeRedirect: [
        (options: { url: URL }) => {
          assertAllowed(options.url.toString(), allowed)
        },
      ],
    },
  }

  if (proxy) {
    if (isSocksProxy(proxy)) {
      // got-scraping's own proxyUrl rejects socks schemes, and its HTTP/2
      // support bypasses custom agents, so the tunnel is installed manually.
      // Keep the agent scoped to one engine run. Reusing it across tool calls
      // can leave a long-lived OpenCode process stuck with a broken tunnel
      // after the SOCKS server resets a connection.
      const agent = new SocksProxyAgent(proxy)
      base.http2 = false
      base.agent = { http: agent, https: agent }
    } else {
      base.proxyUrl = proxy
    }
  }

  const request = async (method: "get" | "post", url: string, options: FetchOptions = {}): Promise<PageResponse> => {
    options.signal?.throwIfAborted()
    assertAllowed(url, allowed)

    const headers: Record<string, string> = { ...options.headers }
    if (options.referer) headers.referer = options.referer

    const pending = gotScraping[method](url, {
      ...base,
      headers,
      signal: options.signal,
      timeout: { request: options.timeout ?? settings.timeout },
      ...(options.form ? { form: options.form } : {}),
    } as never)

    // The body is buffered in memory, so the transfer is cancelled as soon as
    // it grows past the configured ceiling rather than after it has landed.
    let oversized = false
    pending.on("downloadProgress", (progress: { transferred: number }) => {
      if (!oversized && progress.transferred > settings.maxBytes) {
        oversized = true
        pending.cancel()
      }
    })

    let response
    try {
      response = await pending
    } catch (error) {
      if (oversized) throw new Error(`response from ${new URL(url).hostname} exceeded ${settings.maxBytes} bytes`)
      throw error
    }

    const finalUrl = response.url ?? url
    assertAllowed(finalUrl, allowed)
    const body = typeof response.body === "string" ? response.body : String(response.body ?? "")
    return {
      url: finalUrl,
      statusCode: response.statusCode,
      body: body.length > settings.maxBytes ? body.slice(0, settings.maxBytes) : body,
    }
  }

  return {
    get: (url, options) => request("get", url, options),
    post: (url, options) => request("post", url, options),
  }
}
