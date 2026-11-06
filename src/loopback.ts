// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// This machine, as beacons names it, and the one way beacons talks to its own
// daemon on it:
//
//   LOOPBACK, loopbackUrl    the host names an upstream URL may use to count as
//                            loopback (the chain to an upstream proxy)
//   request, get, post       every control call to 127.0.0.1:<port> (health,
//                            status, reload, restart, setup's probe, the status
//                            line), each with its own timeout
//   daemonHealth             the health call, for the CLI, setup and the hook
//   whyNoAnswer              why one of those calls got nothing, in a few words
//
// node:http, never fetch: fetch refuses some ports gateway.json may name (6000,
// 10080 and others), and takes no part in the proxy and agent settings a
// loopback call has no use for.
import http from "node:http"

/**
 * The loopback host names, as a URL's `hostname` gives them. Exactly the ones
 * the engine's egress allowlist sends to: `[::1]` is loopback too, but the
 * engine refuses it, so a chain there would look up and refuse every request.
 */
export const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"])

/** `url` parsed, when its host is loopback; null for any other host, or for no URL at all. */
export function loopbackUrl(url: string): URL | null {
  try {
    const u = new URL(url)
    return LOOPBACK.has(u.hostname) ? u : null
  } catch {
    return null
  }
}

/** The health call's own limit when its caller gives none: setup's, the CLI's. The hook passes its own 1 s. */
const HEALTH_TIMEOUT_MS = 2000
/** A health answer is a few dozen bytes: past this it is not beacons. */
const HEALTH_MAX_BYTES = 64 * 1024

export type Reply = { status: number; body: string }

export type RequestOptions = {
  method?: "GET" | "POST"
  path: string
  /** The request body, for a POST. A POST without one sends an empty body. */
  body?: string
  headers?: Record<string, string>
  /** All of the call, from the connect to the last byte of the answer. */
  timeoutMs: number
  /** The most of the answer's body to take; past it, the call fails. No limit when unset. */
  maxBytes?: number
}

/**
 * One request to 127.0.0.1:<port>, with no agent, so no socket outlives it.
 * Resolves with the status and the whole body. Rejects with an error named
 * TimeoutError when `timeoutMs` runs out, with one that names the limit when
 * the body passes `maxBytes`, and otherwise with the socket's own error
 * (code ECONNREFUSED: nothing listens there).
 */
export function request(port: number, o: RequestOptions): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let settled = false
    let req: http.ClientRequest | undefined
    const finish = (err: Error | null, reply?: Reply) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req?.destroy()
      if (err) reject(err)
      else resolve(reply!)
    }
    const timer = setTimeout(() => finish(Object.assign(new Error(`no answer within ${o.timeoutMs / 1000} s`), { name: "TimeoutError" })), o.timeoutMs)
    const method = o.method ?? "GET"
    const body = method === "POST" ? Buffer.from(o.body ?? "", "utf8") : null
    const headers: Record<string, string> = { ...o.headers }
    if (body) headers["content-length"] = String(body.length)
    try {
      req = http.request({ host: "127.0.0.1", port, method, path: o.path, headers, agent: false }, (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on("data", (c: Buffer) => {
          size += c.length
          if (o.maxBytes !== undefined && size > o.maxBytes) return finish(new Error(`the answer was larger than ${o.maxBytes} bytes`))
          chunks.push(c)
        })
        res.on("end", () => finish(null, { status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }))
        res.on("error", (err) => finish(err))
      })
    } catch (err) {
      // A port out of range throws here, before any socket.
      return finish(err as Error)
    }
    req.on("error", (err) => finish(err))
    req.end(body ?? undefined)
  })
}

export const get = (port: number, path: string, timeoutMs: number, maxBytes?: number): Promise<Reply> =>
  request(port, { path, timeoutMs, maxBytes })

export const post = (port: number, path: string, timeoutMs: number, o: { body?: string; headers?: Record<string, string> } = {}): Promise<Reply> =>
  request(port, { method: "POST", path, timeoutMs, body: o.body, headers: o.headers })

/** beacons' health on `port`: its version, or null when it does not answer 200 with one within `timeoutMs`. */
export async function daemonHealth(port: number, timeoutMs = HEALTH_TIMEOUT_MS): Promise<{ version: string } | null> {
  try {
    const r = await get(port, "/beacons/v1/health", timeoutMs, HEALTH_MAX_BYTES)
    if (r.status !== 200) return null
    const j = JSON.parse(r.body) as { ok?: unknown; version?: unknown } | null
    return j?.ok === true && typeof j.version === "string" ? { version: j.version } : null
  } catch {
    return null
  }
}

/** Why a call through `request`, given `timeoutMs`, got no answer, in a few words. */
export function whyNoAnswer(err: unknown, timeoutMs: number): string {
  const e = err as { name?: string; code?: string; message?: string } | null
  if (e?.name === "TimeoutError") return `no answer within ${timeoutMs / 1000} s`
  if (e?.code === "ECONNREFUSED") return "nothing is listening there"
  return e?.message || String(err)
}
