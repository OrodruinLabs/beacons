// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT

import type { IncomingMessage, ServerResponse } from "node:http"
import { posix } from "node:path"
import type { Engine } from "./engine-glue.ts"
import type { SessionMap } from "./sessions.ts"
import { statusLine } from "./status-line.ts"
import type { LineInput } from "./status-line.ts"

export type ControlDeps = {
  version: string
  engine: Engine
  sessions: SessionMap
  port(): number
  upstreamUrl: string
  routeFor(profile: string): { mode: "pool" | "pin"; account: string } | null
  chain(): LineInput["chain"]
  inFlight(): number
  reload(): Promise<{ added: number; removed: number }>
  leave(o: { now: boolean }): void
}

const PREFIX = "/beacons/v1/"
const MAX_BODY = 64 * 1024
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === "string" ? body : JSON.stringify(body)
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
    "content-length": Buffer.byteLength(text),
    ...headers,
  })
  res.end(text)
}

/** Up to 64 KiB of body; null when it is larger (the caller answers 413). */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let n = 0
    let over = false
    req.on("data", (c: Buffer) => {
      n += c.length
      if (n > MAX_BODY) over = true
      else chunks.push(c)
    })
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

/** Answers `/beacons/` and `/_gateway/` paths. True when it did; false means the path is not a control path and the front forwards it. */
export function handleControl(req: IncomingMessage, res: ServerResponse, path: string, d: ControlDeps): boolean {
  if (!path.startsWith("/beacons/") && !path.startsWith("/_gateway/")) return false
  void route(req, res, path, d).catch((err: Error) => {
    if (!res.headersSent) send(res, 500, { error: err.message })
    else res.destroy()
  })
  return true
}

async function route(req: IncomingMessage, res: ServerResponse, path: string, d: ControlDeps): Promise<void> {
  const method = req.method ?? "GET"
  const wrong = (allow: string) => send(res, 405, { error: "method not allowed" }, { allow })
  if (!path.startsWith(PREFIX)) return void send(res, 404, { error: "not found" })
  const rest = path.slice(PREFIX.length)

  if (rest === "health") {
    if (method !== "GET") return wrong("GET")
    return send(res, 200, { ok: true, version: d.version })
  }

  if (rest === "status") {
    if (method !== "GET") return wrong("GET")
    const st = d.engine.status()
    const num = (v: unknown) => (typeof v === "number" ? v : null)
    return send(res, 200, {
      version: d.version,
      port: d.port(),
      upstream: d.upstreamUrl,
      chain: d.chain() ?? null,
      current: st.currentAccount ?? null,
      accounts: st.accounts.map((a) => ({
        name: a.name,
        priority: a.priority,
        use5h: num(a.quota.unified5h),
        use7d: num(a.quota.unified7d),
        disabled: a.disabled,
      })),
      sessions: d.sessions.list(),
      inFlight: d.inFlight(),
    })
  }

  if (rest === "reload") {
    if (method !== "POST") return wrong("POST")
    await readBody(req)
    try {
      return send(res, 200, await d.reload())
    } catch (err) {
      return send(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  if (rest === "restart") {
    if (method !== "POST") return wrong("POST")
    const raw = await readBody(req)
    if (raw === null) return send(res, 413, { error: "body too large" })
    let now = false
    if (raw.length > 0) {
      try {
        const j = JSON.parse(raw.toString("utf8")) as { now?: unknown }
        now = j !== null && typeof j === "object" && j.now === true
      } catch {
        return send(res, 400, { error: "invalid JSON" })
      }
    }
    // Leave once the 202 is done: "close" follows "finish", and still comes when the client hangs up
    // before the 202 flushes, so the restart is never dropped. A failure there never takes the daemon down.
    res.once("close", () => {
      try {
        d.leave({ now })
      } catch (err) {
        process.stderr.write(`beacons: leaving failed: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    })
    send(res, 202, { ok: true, now })
    return
  }

  if (rest.startsWith("sessions/")) {
    if (method !== "GET") return wrong("GET")
    let id: string
    try {
      id = decodeURIComponent(rest.slice("sessions/".length))
    } catch {
      return send(res, 400, { error: "bad session id" })
    }
    if (!SESSION_ID.test(id)) return send(res, 400, { error: "bad session id" })
    const q = new URL(req.url ?? "/", "http://x").searchParams
    const profile = q.get("profile") ?? ""
    let entry = d.sessions.get(id)
    let r: ReturnType<ControlDeps["routeFor"]> = null
    if (profile) {
      try {
        // routes.json keys are path.resolve'd; the status line sends CLAUDE_CONFIG_DIR as the user set it.
        r = d.routeFor(posix.resolve(profile))
        // No route of its own (off took it out): its requests leave beacons now, whatever the session map remembers.
        if (r === null) entry = null
      } catch (err) {
        // routes.json cannot be read: a session the map holds still answers from it.
        if (!entry) throw err
      }
    }
    const line = statusLine(
      entry
        ? { daemon: "up", routed: true, mode: entry.mode, first: entry.first, account: entry.account, chain: d.chain() }
        : r
          ? { daemon: "up", routed: true, mode: r.mode, first: r.account, account: null, chain: d.chain() }
          : { daemon: "up", routed: false },
    )
    if (q.get("format") === "line") return send(res, 200, line)
    return send(res, 200, { session: entry, line })
  }

  send(res, 404, { error: "not found" })
}
