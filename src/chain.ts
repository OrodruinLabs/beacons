// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The chain to an upstream proxy. When the configured upstream is a loopback
// address, beacons sends through whatever listens there, and checks every few
// seconds that a connection to it still opens. If it is down, the fallback
// decides: wait (block requests, so nothing leaves by a route the owner did
// not choose) or go direct to Anthropic until it answers again.
import { connect, type Socket } from "node:net"
import { ANTHROPIC } from "./config.ts"
import { loopbackUrl } from "./loopback.ts"

/** "unknown" only until the first probe has finished. */
export type ChainState = "up" | "down" | "unknown"

const PROBE_TIMEOUT_MS = 1000

/**
 * Whether the proxy at `url` answers: a TCP connection to its host and port
 * opens within `timeoutMs` (1 s). Loopback only: for any other host, or no URL
 * at all, it is false without a connection. `open` is the connect, for tests.
 */
export function proxyAnswers(url: string, o: { timeoutMs?: number; open?: (to: { host: string; port: number }) => Socket } = {}): Promise<boolean> {
  const u = loopbackUrl(url)
  if (!u) return Promise.resolve(false)
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80))
  const open = o.open ?? ((to) => connect(to))
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined
    let socket: Socket | undefined
    const done = (ok: boolean) => {
      clearTimeout(timer)
      socket?.destroy()
      resolve(ok)
    }
    try {
      socket = open({ host: u.hostname, port })
    } catch {
      // A port the socket refuses (0): nothing can answer there.
      return done(false)
    }
    timer = setTimeout(() => done(false), o.timeoutMs ?? PROBE_TIMEOUT_MS)
    socket.once("connect", () => done(true))
    // `on`, not `once`: an error after the answer must still find a listener.
    socket.on("error", () => done(false))
  })
}

export class Chain {
  readonly on: boolean
  #url: string
  #fallback: "wait" | "direct"
  #answers: (url: string) => Promise<boolean>
  #intervalMs: number
  #state: ChainState = "unknown"
  #timer: NodeJS.Timeout | null = null
  #inflight: Promise<ChainState> | null = null

  constructor(o: { upstreamUrl: string; fallback: "wait" | "direct"; answers?: (url: string) => Promise<boolean>; intervalMs?: number }) {
    this.#url = o.upstreamUrl
    this.#fallback = o.fallback
    this.#answers = o.answers ?? ((url) => proxyAnswers(url))
    this.#intervalMs = o.intervalMs ?? 5000
    this.on = loopbackUrl(o.upstreamUrl) !== null
  }

  state(): ChainState {
    return this.#state
  }

  /** Ask whether the proxy answers now. A probe already in flight is shared, never doubled. */
  probe(): Promise<ChainState> {
    if (!this.on) return Promise.resolve(this.#state)
    this.#inflight ??= this.#answers(this.#url)
      .catch(() => false)
      .then((up): ChainState => (this.#state = up ? "up" : "down"))
      .finally(() => {
        this.#inflight = null
      })
    return this.#inflight
  }

  /** A request just failed to connect: find out at once whether the chain is down. */
  noteConnectFailure(): void {
    if (this.on) void this.probe()
  }

  start(): void {
    if (!this.on || this.#timer) return
    void this.probe()
    this.#timer = setInterval(() => void this.probe(), this.#intervalMs)
    this.#timer.unref()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  upstreamFor(): { kind: "anthropic" | "chain" | "direct" | "block"; url: string } {
    if (!this.on) return { kind: "anthropic", url: ANTHROPIC }
    if (this.#state !== "down") return { kind: "chain", url: this.#url }
    return this.#fallback === "wait" ? { kind: "block", url: this.#url } : { kind: "direct", url: ANTHROPIC }
  }
}
