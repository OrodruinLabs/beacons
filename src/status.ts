// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// `beacons status`: what the daemon says about itself (its version, the
// upstream and the chain to an upstream proxy, each account's priority and use, the open
// sessions), and the profiles routes.json records. With the daemon down, it
// says so and lists the profiles.
//
// `beacons status --line`, the slow path: the same answer bin/beacons' sh fast
// path gives, worked out the same way. bin/beacons takes `status --line` before
// any Node runs, so this path runs only when the CLI is started directly.
import { readFileSync } from "node:fs"
import { DEFAULT_PORT, type RoutesFile } from "./config.ts"
import { get } from "./loopback.ts"
import type { Paths } from "./paths.ts"
import { tilde } from "./profiles.ts"
import type { SessionEntry } from "./sessions.ts"
import { statusLine, type LineInput } from "./status-line.ts"

export type AccountStatus = { name: string; priority: number | null; use5h: number | null; use7d: number | null; disabled: boolean }

/** GET /beacons/v1/status, as src/control.ts answers it. */
export type DaemonStatus = {
  version: string
  port: number
  upstream: string
  chain: LineInput["chain"] | null
  current: string | null
  accounts: AccountStatus[]
  sessions: SessionEntry[]
  inFlight: number
}

const STATUS_TIMEOUT_MS = 2000
const LINE_TIMEOUT_MS = 1000

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)

/** The daemon's status on `port`. Rejects when it does not answer 200 with a status inside the timeout (loopback.ts's `whyNoAnswer` says why). */
export async function fetchStatus(port: number, timeoutMs = STATUS_TIMEOUT_MS): Promise<DaemonStatus> {
  const res = await get(port, "/beacons/v1/status", timeoutMs)
  if (res.status !== 200) throw new Error(`it answered HTTP ${res.status}`)
  const j: unknown = JSON.parse(res.body)
  if (!isObj(j) || !Array.isArray(j.accounts) || !Array.isArray(j.sessions)) throw new Error("its status is not one beacons gives")
  return j as DaemonStatus
}

/** Rows of cells, each column padded to its widest cell, two spaces apart, indented. */
function table(rows: string[][]): string[] {
  const widths: number[] = []
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)))
  return rows.map((r) => ("  " + r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join("  ")).trimEnd())
}

const pct = (x: number | null) => (typeof x === "number" && Number.isFinite(x) ? `${Math.round(x * 100)}%` : "-")

/** Each recorded profile with its route; a profile `off` parked says so. */
export function profileLines(routes: RoutesFile, home: string): string[] {
  const rows: string[][] = []
  for (const [dir, r] of Object.entries(routes.profiles)) rows.push([tilde(home, dir), `${r.mode}:${r.account}`])
  for (const [dir, r] of Object.entries(routes.off ?? {})) {
    if (!Object.hasOwn(routes.profiles, dir)) rows.push([tilde(home, dir), `${r.mode}:${r.account}`, "off (`beacons on` routes it again)"])
  }
  if (rows.length === 0) return ["no profile is routed through beacons"]
  return ["profiles:", ...table(rows)]
}

function upstreamLine(s: DaemonStatus): string {
  const c = s.chain
  if (!c || !c.on) return `upstream: ${s.upstream}`
  const state = c.state === "unknown" ? "not checked yet" : c.state
  const fallback = c.fallback === "wait" ? "wait for it" : "go direct to Anthropic"
  return `upstream: the proxy at ${s.upstream}, which is ${state}; if it stops answering: ${fallback}`
}

/** The report for a daemon that answered. `profiles` are profileLines' lines, or why routes.json cannot be read. */
export function renderStatus(s: DaemonStatus, port: number, profiles: string[]): string {
  const lines = [`beacons ${s.version}, on 127.0.0.1:${s.port > 0 ? s.port : port}`, upstreamLine(s)]
  const accounts = s.accounts
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (x.a.priority ?? Infinity) - (y.a.priority ?? Infinity) || x.i - y.i)
    .map(({ a }) => [String(a.priority ?? "-"), a.name, `5h ${pct(a.use5h)}`, `7d ${pct(a.use7d)}`, [a.disabled ? "disabled" : "", a.name === s.current ? "serving" : ""].filter(Boolean).join(", ")])
  if (accounts.length === 0) lines.push("no account is signed in: run `beacons login`")
  else lines.push("accounts, first choice first:", ...table(accounts))
  if (s.sessions.length === 0) lines.push("no open sessions")
  else lines.push("open sessions:", ...table(s.sessions.map((x) => [String(x.id).slice(0, 8), x.account, x.mode])))
  lines.push(...profiles)
  return lines.join("\n")
}

/** The report for a daemon that did not answer. */
export function renderDown(port: number, why: string, profiles: string[]): string {
  return [`beacons is not answering on 127.0.0.1:${port} (${why}).`, ...profiles].join("\n")
}

// --- the status line, slow path -------------------------------------------

// bin/beacons' sed expressions, line by line: the last match on the first line that has one.
const SESSION_ID = /^[^\n]*"session_id"[ \t\v\f\r]*:[ \t\v\f\r]*"([A-Za-z0-9_-][A-Za-z0-9._-]{0,127})"[^\n]*$/
const PORT = /^[^\n]*"port"[ \t\v\f\r]*:[ \t\v\f\r]*([0-9][0-9]*)[^\n]*$/

function firstMatch(text: string, re: RegExp): string | null {
  for (const line of text.split("\n")) {
    const m = re.exec(line)
    if (m) return m[1]
  }
  return null
}

/** The port as the fast path reads it from gateway.json: the default when it names none in range. */
function linePort(file: string): number {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return DEFAULT_PORT
  }
  const n = Number(firstMatch(text, PORT) ?? NaN)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_PORT
}

/** One GET to the daemon, given `ms` in all: the body, or null for no answer or an HTTP error (curl -sf). */
async function getText(port: number, urlPath: string, ms: number): Promise<string | null> {
  try {
    const res = await get(port, urlPath, ms)
    return res.status >= 400 ? null : res.body
  } catch {
    return null
  }
}

/**
 * The status line for Claude Code's status-line JSON `input`, as bin/beacons'
 * fast path gives it: the session id the same sed would find (else "-", which
 * asks for the profile's route alone), the profile as it names it, one call
 * of at most a second, and, when that gets nothing, the profile's
 * settings.json saying whether it is routed here (down) or not (direct).
 */
export async function statusLineSlow(o: { input: string; env: NodeJS.ProcessEnv; p: Paths }): Promise<string> {
  const sid = firstMatch(o.input, SESSION_ID) ?? "-"
  const port = linePort(o.p.gatewayFile)
  // ${CLAUDE_CONFIG_DIR:-$HOME/.claude}, made absolute from $PWD, without trailing slashes.
  let profile = o.env.CLAUDE_CONFIG_DIR || `${o.p.home}/.claude`
  if (!profile.startsWith("/")) profile = `${o.env.PWD && o.env.PWD.startsWith("/") ? o.env.PWD : process.cwd()}/${profile}`
  while (profile !== "/" && profile.endsWith("/")) profile = profile.slice(0, -1)
  // Every byte percent-encoded, as `od` does it there.
  const query = Buffer.from(profile, "utf8").toString("hex").replace(/../g, "%$&")
  const body = await getText(port, `/beacons/v1/sessions/${sid}?profile=${query}&format=line`, LINE_TIMEOUT_MS)
  const line = body?.replace(/\n+$/, "") ?? ""
  if (line !== "") return line
  let routedHere = false
  try {
    routedHere = readFileSync(`${profile}/settings.json`, "utf8").includes(`127.0.0.1:${port}/`)
  } catch {
    // No settings.json: not routed.
  }
  return statusLine({ daemon: "down", routed: routedHere })
}
