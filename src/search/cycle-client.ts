import initCycleTLS, { type CycleTLSClient, type CycleTLSResponse } from "cycletls"
import { CookieJar } from "tough-cookie"
import { hostAllowed, type ClientSettings, type FetchOptions, type PageResponse, type SearchClient } from "./client.js"

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
const CHROME_JA4R = "t13d1516h2_002f,0035,009c,009d,1301,1302,1303,c013,c014,c02b,c02c,c02f,c030,cca8,cca9_0000,0005,000a,000b,000d,0012,0017,001b,0023,002b,002d,0033,44cd,fe0d,ff01_0403,0804,0401,0503,0805,0501,0806,0601"
const CHROME_HTTP2 = "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p"
const REDIRECTS = new Set([301, 302, 303, 307, 308])
let sharedCycle: Promise<CycleTLSClient> | undefined

function assertAllowed(url: string, allowed: readonly string[]): URL {
  const parsed = new URL(url)
  if (parsed.protocol !== "https:") throw new Error(`refusing to request a non-https url: ${parsed.protocol}//`)
  if (!hostAllowed(parsed.hostname, allowed)) throw new Error(`refusing to request an unexpected host: ${parsed.hostname}`)
  return parsed
}

function rawHeader(response: CycleTLSResponse, name: string): unknown {
  const key = Object.keys(response.headers).find((item) => item.toLowerCase() === name.toLowerCase())
  return key ? response.headers[key] : undefined
}

function header(response: CycleTLSResponse, name: string): string | undefined {
  const value = rawHeader(response, name)
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === "string")
  return undefined
}

async function storeCookies(jar: CookieJar, response: CycleTLSResponse, url: string): Promise<void> {
  const value = rawHeader(response, "set-cookie")
  const cookies = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
  await Promise.all(cookies.map((cookie) => jar.setCookie(cookie, url).catch(() => undefined)))
}

function redirectMethod(status: number, method: "get" | "post"): "get" | "post" {
  return status === 303 || ((status === 301 || status === 302) && method === "post") ? "get" : method
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

/**
 * CycleTLS runs a Go/uTLS transport out of process. Startpage is the only engine
 * that needs it: the Node TLS stack is occasionally reset inside a long-lived
 * OpenCode process, while the same requests work in a short-lived process.
 */
export async function createCycleClient(settings: ClientSettings): Promise<SearchClient> {
  // CycleTLS owns a Go worker shared through localhost:9119. Keep one worker
  // for the OpenCode process: exiting and immediately reinitialising the same
  // port races its shutdown and leaves subsequent searches disconnected.
  sharedCycle ??= initCycleTLS({ timeout: settings.timeout, autoExit: true })
  const cycle = await sharedCycle
  const jar = new CookieJar()

  const request = async (initialMethod: "get" | "post", initialUrl: string, options: FetchOptions = {}): Promise<PageResponse> => {
    let method = initialMethod
    let url = initialUrl
    let body = options.form ? new URLSearchParams(options.form).toString() : ""

    for (let redirects = 0; redirects <= 5; redirects++) {
      options.signal?.throwIfAborted()
      assertAllowed(url, settings.allowedHosts)
      const headers: Record<string, string> = {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Ch-Ua": '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Linux"',
        "Sec-GPC": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": options.referer ? "same-origin" : "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        ...options.headers,
      }
      if (options.referer) headers.Referer = options.referer
      const cookies = await jar.getCookieString(url)
      if (cookies) headers.Cookie = cookies

      const response = await withAbort(
        cycle(url, {
          body: method === "post" ? body : "",
          headers,
          proxy: settings.proxy,
          timeout: Math.max(1, Math.ceil((options.timeout ?? settings.timeout) / 1_000)),
          responseType: "text",
          disableRedirect: true,
          insecureSkipVerify: false,
          userAgent: USER_AGENT,
          ja4r: CHROME_JA4R,
          http2Fingerprint: CHROME_HTTP2,
          headerOrder: ["sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests", "user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest", "accept-language", "accept-encoding", "referer", "content-type", "origin", "cookie"],
        }, method),
        options.signal,
      )
      const finalUrl = response.finalUrl || url
      assertAllowed(finalUrl, settings.allowedHosts)
      await storeCookies(jar, response, finalUrl)

      if (REDIRECTS.has(response.status)) {
        const location = header(response, "location")
        if (typeof location !== "string") throw new Error(`redirect from ${new URL(url).hostname} has no location`)
        if (redirects === 5) throw new Error("search request exceeded 5 redirects")
        url = new URL(location, finalUrl).toString()
        assertAllowed(url, settings.allowedHosts)
        method = redirectMethod(response.status, method)
        if (method === "get") body = ""
        continue
      }

      const responseBody = await response.text()
      if (Buffer.byteLength(responseBody) > settings.maxBytes) {
        throw new Error(`response from ${new URL(url).hostname} exceeded ${settings.maxBytes} bytes`)
      }
      return { url: finalUrl, statusCode: response.status, body: responseBody }
    }

    throw new Error("unreachable redirect state")
  }

  return {
    get: (url, options) => request("get", url, options),
    post: (url, options) => request("post", url, options),
  }
}
