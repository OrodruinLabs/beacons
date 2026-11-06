// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The front: the HTTP server every Claude Code request reaches. It decides, in
// this order, what a request is and who answers it:
//
//   browser      a web page's request (Origin, Sec-Fetch-Site, a foreign Host): 403
//   OPTIONS      a preflight: 204, and no CORS grant
//   control      /beacons/... and /_gateway/...: the control API
//   telemetry    /api/event_logging...: 200 {}, never forwarded
//   target       anything that is not origin-form ("/x", not "//x" or "http://..."): 400
//   chain        the upstream proxy down with fallback wait: 503, nothing forwarded
//   passthrough  the client's own credential (its OAuth refresh, uploads): forwarded as sent
//   engine       everything else: the engine picks the account and serves it
//
// No request body and no per-request row is ever logged or stored here.
import http from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Socket } from "node:net"
import type { Duplex } from "node:stream"
import { randomUUID } from "node:crypto"
import { browserRefusal } from "./browser.ts"
import type { Chain } from "./chain.ts"
import type { GatewayConfig } from "./config.ts"
import { handleControl } from "./control.ts"
import type { ControlDeps } from "./control.ts"
import type { Engine } from "./engine-glue.ts"
import { forwardPassthrough, isPassthrough, passthroughTarget } from "./passthrough.ts"
import { parseRoute } from "./route.ts"
import type { Route } from "./route.ts"
import type { SessionMap } from "./sessions.ts"

/** The gateway listens on loopback only; the Host check compares against it. */
const BIND_HOST = "127.0.0.1"
/** A model call's body is read whole before the engine sees it, so it has a ceiling. */
const MAX_BODY = 32 * 1024 * 1024
/** The session id shapes the control API answers for; anything else is not recorded. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/
/** Failures that say the upstream (the chain, when there is one) is not there. */
const CONNECT_FAILURE = /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b|socket hang up/
const NOT_ORIGIN_FORM = "beacons: the request target must be a path that starts with a single \"/\" and has no \"\\\""

export type Front = {
  server: http.Server
  /** Requests whose reply has not finished, control requests excluded. */
  inFlight(): number
  /** Stop accepting, wait for `inFlight() === 0` or `capMs`, then cut every socket still open. */
  drain(o: { capMs: number }): Promise<void>
  /**
   * Leave at the next quiet moment. From now every reply carries `connection:
   * close`, and the listener keeps taking requests until the instant
   * `inFlight() === 0` (at once if nothing is open), when it closes. Resolves
   * then; `drain` still closes what is idle.
   */
  leaving(): Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers })
  res.end(text)
}

/** Anthropic's own error envelope, so Claude Code shows the message as it would one of theirs. */
const apiError = (res: ServerResponse, status: number, type: string, message: string, headers: Record<string, string> = {}) =>
  sendJson(res, status, { type: "error", error: { type, message } }, headers)

const isEventLogging = (path: string) => path.startsWith("/api/event_logging")

/**
 * Origin-form only: one "/" and then not another. Absolute-form, authority-form,
 * `*` and `//host` are not, and neither is a path with a "\": the engine joins
 * the path to its upstream and a URL parser reads "\" as "/", so `/\host/...`
 * would leave as `//host/...`.
 */
const isOriginForm = (url: string) => url.startsWith("/") && !url.startsWith("//") && !url.split("?")[0].includes("\\")

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

/**
 * The whole body, or null once it passes `cap` (declared or sent). Past the
 * cap nothing more is kept; what is still arriving is let through and dropped.
 */
function readBody(req: IncomingMessage, cap: number): Promise<Buffer | null> {
  const declared = Number(header(req, "content-length"))
  if (Number.isFinite(declared) && declared > cap) {
    req.resume()
    return Promise.resolve(null)
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let n = 0
    const onData = (c: Buffer) => {
      n += c.length
      if (n <= cap) return void chunks.push(c)
      req.off("data", onData)
      chunks.length = 0
      req.resume()
      resolve(null)
    }
    req.on("data", onData)
    req.once("end", () => resolve(Buffer.concat(chunks)))
    req.once("error", reject)
    req.once("close", () => {
      if (!req.complete) reject(new Error("the client went away before its body ended"))
    })
  })
}

/**
 * A request Node could not parse never reaches the handler. The one a target
 * check would refuse (`@host/...`, `host:port`) answers like the handler does;
 * the rest keep Node's own statuses. A socket that has carried a reply may be
 * in the middle of one, so it is cut rather than written into.
 */
function onClientError(err: NodeJS.ErrnoException, socket: Duplex): void {
  if (err.code === "ECONNRESET" || !socket.writable || (socket as Socket).bytesWritten > 0) return void socket.destroy()
  const [status, reason]: [number, string] =
    err.code === "HPE_HEADER_OVERFLOW" ? [431, "Request Header Fields Too Large"]
    : err.code === "ERR_HTTP_REQUEST_TIMEOUT" ? [408, "Request Timeout"]
    : [400, "Bad Request"]
  const message = err.code === "HPE_INVALID_URL" ? NOT_ORIGIN_FORM : `beacons: the request could not be read (${err.code ?? "parse error"})`
  endRaw(socket, status, reason, message)
}

/** An Anthropic-style error written straight to a socket that has no response object, then the socket ended. */
function endRaw(socket: Duplex, status: number, reason: string, message: string): void {
  const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } })
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
  )
}

/** The gateway is no tunnel: a CONNECT gets the same 400 a bad target does, and nothing opens. */
function onConnect(_req: IncomingMessage, socket: Duplex): void {
  endRaw(socket, 400, "Bad Request", "beacons: CONNECT is not served; send the request itself, with a path starting with \"/\"")
}

export function createFront(d: {
  /** The daemon's config. The front reads nothing from it today: the chain names the upstream per request. */
  cfg: GatewayConfig
  engine: Engine
  sessions: SessionMap
  /** What the front asks of the chain; a `Chain` is one. */
  chain: Pick<Chain, "upstreamFor" | "noteConnectFailure">
  control: ControlDeps
  log?: (l: string) => void
}): Front {
  const log = d.log ?? ((line: string) => process.stderr.write(`beacons: ${line}\n`))
  let inFlight = 0
  /** Leaving (patiently or draining): every reply from now carries `connection: close`. */
  let draining = false
  /** Called, in the same tick, when `inFlight` falls to 0. */
  const idleWaiters = new Set<() => void>()
  const sockets = new Set<Socket>()

  /** One account the engine knows by that name, not a placeholder like "(none available)". */
  const isAccount = (name: string) => d.engine.status().accounts.some((a) => a.name === name)
  const isConnectFailure = (error: string | null) => error !== null && CONNECT_FAILURE.test(error)

  async function forward(req: IncomingMessage, res: ServerResponse, route: Route, upstream: string): Promise<void> {
    if (isPassthrough(route.url.split("?")[0])) {
      // Unread: the body streams upstream as it arrives, so an upload is never held whole.
      const r = await forwardPassthrough({ req, res, target: passthroughTarget(upstream, route.url) })
      if (r.status === null && isConnectFailure(r.error)) d.chain.noteConnectFailure()
      return
    }
    const body = await readBody(req, MAX_BODY)
    if (body === null) {
      return apiError(res, 413, "request_too_large", `beacons: the request body is over ${MAX_BODY / 1024 / 1024} MiB`, { connection: "close" })
    }
    const sid = header(req, "x-claude-code-session-id")
    const sessionId = sid && SESSION_ID.test(sid) ? sid : null
    const served = await d.engine.serve({
      req,
      res,
      url: route.url,
      body,
      reqId: randomUUID(),
      sessionId,
      pin: { account: route.account, mode: route.mode },
      upstream,
    })
    if (sessionId && served.account && isAccount(served.account)) {
      d.sessions.record(sessionId, { account: served.account, mode: route.mode, first: route.account })
    }
    // No reply head and the upstream would not take the connection: the chain may be down.
    if (served.status === null && isConnectFailure(served.error)) d.chain.noteConnectFailure()
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/"
    const path = url.split("?")[0]
    if (draining) res.setHeader("connection", "close")

    // Refused before the body is read, the route parsed, or an account touched.
    const refusal = browserRefusal(req.headers, BIND_HOST)
    if (refusal) {
      req.resume()
      return apiError(res, 403, "permission_error", refusal)
    }
    // Answered here with no CORS grant: upstream would answer with an account's token and allow any origin.
    if (req.method === "OPTIONS") {
      req.resume()
      res.writeHead(204)
      res.end()
      return
    }
    if (handleControl(req, res, path, d.control)) return

    inFlight += 1
    res.once("close", () => {
      inFlight -= 1
      if (inFlight === 0) for (const w of [...idleWaiters]) w()
    })

    if (isEventLogging(path)) {
      req.resume()
      return sendJson(res, 200, {})
    }
    if (!isOriginForm(url)) {
      req.resume()
      return apiError(res, 400, "invalid_request_error", NOT_ORIGIN_FORM)
    }
    const route = parseRoute(url)
    // `/pool/a//host/...` strips to `//host/...`: never a path to join to an upstream.
    if (!isOriginForm(route.url)) {
      req.resume()
      return apiError(res, 400, "invalid_request_error", NOT_ORIGIN_FORM)
    }
    // A routed profile's telemetry carries the route prefix; it is absorbed all the same.
    if (isEventLogging(route.url.split("?")[0])) {
      req.resume()
      return sendJson(res, 200, {})
    }

    const up = d.chain.upstreamFor()
    if (up.kind === "block") {
      req.resume()
      return apiError(res, 503, "api_error", `the upstream proxy at ${originOf(up.url)} is not answering; beacons is waiting for it (chain fallback: wait)`)
    }

    forward(req, res, route, up.url).catch((err: Error) => {
      // A client that left mid-body has nobody to answer.
      if (req.destroyed && !req.complete) return
      log(`request failed: ${err.message}`)
      if (!res.headersSent) apiError(res, 500, "api_error", `beacons: ${err.message}`)
      else res.destroy()
    })
  }

  const server = http.createServer(handle)
  server.on("connection", (s: Socket) => {
    sockets.add(s)
    s.once("close", () => sockets.delete(s))
  })
  server.on("clientError", onClientError)
  server.on("connect", onConnect)

  return {
    server,
    inFlight: () => inFlight,
    drain: async ({ capMs }) => {
      draining = true
      server.close()
      server.closeIdleConnections()
      if (inFlight > 0) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(cap)
            idleWaiters.delete(done)
            resolve()
          }
          const cap = setTimeout(done, capMs)
          idleWaiters.add(done)
        })
      }
      for (const s of sockets) s.destroy()
    },
    leaving: () => {
      draining = true
      return new Promise<void>((resolve) => {
        // Synchronous with the last reply's close, so no connection is accepted in between.
        const quiet = () => {
          idleWaiters.delete(quiet)
          server.close()
          resolve()
        }
        if (inFlight === 0) quiet()
        else idleWaiters.add(quiet)
      })
    },
  }
}
