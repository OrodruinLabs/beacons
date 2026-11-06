// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The forward leg for paths that carry the client's own credential (its OAuth
// refresh, a file upload). No account of ours serves them, so the request goes
// upstream as the client sent it, with only the hop-by-hop headers dropped.
// Pooled HTTP/1.1, streamed both ways. The body and credential headers are
// never logged or stored here.
import http from "node:http"
import https from "node:https"
import type { IncomingMessage, ServerResponse } from "node:http"
import { assertAllowedHost } from "./engine/upstream-fetch.js"

const PASSTHROUGH_PATHS = ["/v1/oauth/token", "/v1/code/", "/api/oauth/files/", "/api/oauth/file_upload"]

export const isPassthrough = (path: string): boolean => PASSTHROUGH_PATHS.some((p) => path.startsWith(p))

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
])

const agents = {
  http: new http.Agent({ keepAlive: true, maxSockets: 256 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 256 }),
}

/**
 * The upstream URL's own path (trailing slash trimmed) plus `url`, joined as
 * strings. Never `new URL(url, base)`: a `url` starting with `//` would be read
 * as a host and send the client's credential elsewhere.
 */
export function passthroughTarget(upstreamUrl: string, url: string): URL {
  return new URL(`${upstreamUrl.replace(/\/+$/, "")}${url}`)
}

function apiError(res: ServerResponse, message: string): void {
  res.writeHead(502, { "content-type": "application/json" })
  res.end(JSON.stringify({ type: "error", error: { type: "api_error", message } }))
}

/** The client left before its reply ended: the upstream request goes with it. Not a connect failure. */
const CLIENT_LEFT = "the client went away"

/**
 * Pipe one request upstream and the response back. Never throws. With no
 * `body`, the request body is streamed from `req` as it arrives, never held
 * whole; with one, that buffer is sent instead.
 */
export function forwardPassthrough(o: {
  req: IncomingMessage
  res: ServerResponse
  body?: Buffer
  target: URL
}): Promise<{ status: number | null; error: string | null }> {
  const { req, res, body, target } = o
  try {
    assertAllowedHost(target.href)
  } catch {
    const error = `egress to ${target.hostname} refused`
    // An unread body is drained and dropped, so the refusal still reaches the client.
    if (!body) req.resume()
    if (!res.headersSent) apiError(res, error)
    else res.end()
    return Promise.resolve({ status: 502, error })
  }
  const isTls = target.protocol === "https:"
  const mod = isTls ? https : http

  return new Promise((resolve) => {
    let settled = false
    const done = (status: number | null, error: string | null) => {
      if (settled) return
      settled = true
      resolve({ status, error })
    }

    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase()
      if (lk.startsWith(":") || HOP_BY_HOP.has(lk) || lk === "content-length") continue
      if (typeof v === "string") headers[k] = v
      else if (Array.isArray(v)) headers[k] = v.join(", ")
    }
    headers["host"] = target.host
    // A streamed body keeps the length the client declared. A chunked one stays
    // chunked: Node chunks a POST by itself, but sends a GET, HEAD or DELETE body
    // unframed unless told.
    const length = body ? String(body.length) : req.headers["content-length"]
    if (length !== undefined) headers["content-length"] = length
    else if (req.headers["transfer-encoding"] !== undefined) headers["transfer-encoding"] = "chunked"

    const up = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isTls ? 443 : 80),
        path: target.pathname + target.search,
        method: req.method,
        headers,
        agent: isTls ? agents.https : agents.http,
      },
      (upRes) => {
        const status = upRes.statusCode ?? 502
        const out: Record<string, string | string[]> = {}
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (HOP_BY_HOP.has(k.toLowerCase())) continue
          if (v !== undefined) out[k] = v
        }
        if (!res.headersSent) res.writeHead(status, out)
        upRes.on("data", (chunk: Buffer) => {
          if (!res.write(chunk)) {
            upRes.pause()
            res.once("drain", () => upRes.resume())
          }
        })
        upRes.on("end", () => {
          res.end()
          done(status, null)
        })
        // A reply that stops short is cut for the client too: ending it would
        // pass a truncated body off as the whole one.
        const cut = (why: string) => {
          res.destroy()
          done(status, `upstream stream: ${why}`)
        }
        upRes.on("error", (err: Error) => cut(err.message))
        upRes.on("close", () => {
          if (!upRes.complete) cut("closed before the reply ended")
        })
      },
    )

    up.setTimeout(120_000, () => up.destroy(new Error("upstream timeout")))

    up.on("error", (err: Error) => {
      if (!body) {
        // The upload stops here; what the client still sends is drained and dropped.
        req.unpipe(up)
        req.resume()
      }
      if (!res.headersSent) apiError(res, err.message)
      else res.destroy()
      done(null, err.message)
    })

    // The client hanging up, mid-upload or mid-stream, is normal, not an error.
    const clientLeft = () => {
      if (!settled) up.destroy(new Error(CLIENT_LEFT))
    }
    res.on("close", clientLeft)

    if (body) return void up.end(body)
    // pipe() pauses the client while the upstream socket is full, and ends the
    // upstream request when the client's body ends.
    req.pipe(up)
    req.on("error", clientLeft)
    req.on("close", () => {
      if (!req.complete) clientLeft()
    })
  })
}
