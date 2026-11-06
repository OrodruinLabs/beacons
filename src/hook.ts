// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The SessionStart hook, for a profile routed through beacons:
//
//   1. ask the daemon's health (1 s). When it does not answer and an upgrade
//      holds upgrade.lock, wait up to 3 s for it and say the service is
//      restarting for an update; never start a second one. Otherwise have
//      the service manager start the service and wait up to 3 s; still down,
//      say how to go direct. Start, never restart: a daemon that is alive but
//      slow to answer keeps running, and so do the streams it is serving.
//   2. when this plugin copy is newer than the current release, and not the
//      version a rollback or a failed upgrade held, start `beacons upgrade`
//      from the plugin copy, detached, and say nothing about it.
//   3. report a failed upgrade from last-upgrade.json, once.
//
// The hook runs inside hooks.json's 5 s timeout, so the whole of it stays
// under 4 s even when the daemon accepts the connection and never answers:
// every health call has its own timeout, and every wait a deadline. An
// unrouted profile is none of beacons' business, and gets nothing.
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { readRoutes, writeAtomic } from "./config.ts"
import { daemonHealth } from "./loopback.ts"
import type { Paths } from "./paths.ts"
import { pluginVersion, readReleaseState } from "./release.ts"
import { ensureStarted, LABEL } from "./service.ts"
import type { Run } from "./service.ts"
import { lockHeld } from "./upgrade.ts"

export type HookDeps = {
  /** The running daemon's health, or null when nothing answers. */
  health(): Promise<{ version: string } | null>
  /** Have the service manager start the service if it is not running; a running one is left alone. */
  ensureStarted(): Promise<void>
  /** Start `beacons upgrade` from the plugin copy at `pluginRoot`, detached; returns at once. */
  spawnUpgrade(pluginRoot: string): void
  sleep(ms: number): Promise<void>
  /** True while an upgrade holds upgrade.lock. */
  lockHeld(): boolean
}

export const NOT_ANSWERING = "beacons is not answering; run `! beacons off` to go direct"
export const RESTARTING = "beacons is restarting for an update"

const HEALTH_MS = 1000
const WAIT_MS = 3000
const POLL_MS = 250
/** Everything that waits ends by here, leaving room under 4 s for the file reads after it. */
const BUDGET_MS = 3700

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** What `promise` resolves to, or `fallback` when it rejects or takes longer than `ms`. */
async function within<T>(promise: () => Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(promise),
      new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), Math.max(0, ms)))),
    ])
  } catch {
    return fallback
  } finally {
    clearTimeout(timer)
  }
}

/** One health call, given at most `ms`: true when the daemon answered. A call that throws is down. */
async function answers(deps: HookDeps, ms: number): Promise<boolean> {
  const h = await within(() => deps.health(), Math.min(HEALTH_MS, ms), null)
  return h !== null && typeof h === "object"
}

/** Poll health every 250 ms until it answers, for up to 3 s (by count) and never past `until` (by the clock). */
async function waitForHealth(deps: HookDeps, until: number): Promise<boolean> {
  for (let tries = 0; tries < WAIT_MS / POLL_MS; tries++) {
    if (until - Date.now() <= POLL_MS) break
    await deps.sleep(POLL_MS)
    if (await answers(deps, until - Date.now())) return true
  }
  return false
}

const locked = (deps: HookDeps): boolean => {
  try {
    return deps.lockHeld()
  } catch {
    // A lock that cannot be read is not one an upgrade is holding.
    return false
  }
}

/** major.minor.patch, an optional prerelease, and optional build metadata (which never counts). */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.+-]*)?$/
const DIGITS = /^\d+$/

/** Two digit strings by value, at any length. */
function compareDigits(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, "")
  const y = b.replace(/^0+(?=\d)/, "")
  if (x.length !== y.length) return x.length < y.length ? -1 : 1
  return x < y ? -1 : x > y ? 1 : 0
}

/**
 * Prerelease identifiers, by semver §11: a release sorts above any of its
 * prereleases; identifiers compare left to right, numeric ones by value and
 * below any alphanumeric one, the others in ASCII order; and with all else
 * equal, more identifiers sort higher.
 */
function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1
  const x = a.split(".")
  const y = b.split(".")
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const xn = DIGITS.test(x[i])
    const yn = DIGITS.test(y[i])
    const c = xn && yn ? compareDigits(x[i], y[i]) : xn !== yn ? (xn ? -1 : 1) : x[i] < y[i] ? -1 : x[i] > y[i] ? 1 : 0
    if (c !== 0) return c
  }
  return Math.sign(x.length - y.length)
}

/** Whether `a` is a newer version than `b` by semver precedence. A version that is not semver is never newer. */
function newer(a: string, b: string): boolean {
  const x = SEMVER.exec(a)
  const y = SEMVER.exec(b)
  if (!x || !y) return false
  for (let i = 1; i <= 3; i++) {
    const c = compareDigits(x[i], y[i])
    if (c !== 0) return c > 0
  }
  return comparePrerelease(x[4], y[4]) > 0
}

/** Start an upgrade when the plugin copy is newer than the current release and not held. Says nothing. */
function upgradeIfNewer(o: { pluginRoot: string; p: Paths; deps: HookDeps }): void {
  let version: string
  let state: { current: string | null; held: string | null }
  try {
    version = pluginVersion(o.pluginRoot)
    state = readReleaseState(o.p)
  } catch {
    return
  }
  // No release yet is setup's to make; a held version failed or was rolled back from.
  if (state.current === null || version === state.held || !newer(version, state.current)) return
  // One upgrade at a time: one already running will get there.
  if (locked(o.deps)) return
  try {
    o.deps.spawnUpgrade(o.pluginRoot)
  } catch {
    // The next session start tries again.
  }
}

/** A failed upgrade not yet shown, as one line; marks it shown. Null when there is none. */
function failedUpgrade(p: Paths): string | null {
  let rec: Record<string, unknown>
  try {
    const j: unknown = JSON.parse(readFileSync(p.lastUpgrade, "utf8"))
    if (j === null || typeof j !== "object" || Array.isArray(j)) return null
    rec = j as Record<string, unknown>
  } catch {
    return null
  }
  if (rec.ok !== false || rec.shown === true) return null
  try {
    writeAtomic(p.lastUpgrade, JSON.stringify({ ...rec, shown: true }, null, 2) + "\n", 0o600)
  } catch {
    // Not marked: shown again at the next start, rather than never.
  }
  const to = typeof rec.to === "string" && rec.to !== "" ? ` to ${rec.to}` : ""
  const reason = typeof rec.reason === "string" && rec.reason !== "" ? rec.reason : "no reason was recorded"
  return `beacons could not upgrade${to}: ${reason}`
}

/**
 * The SessionStart hook for `profile` (see the top of this file). Resolves to
 * `{ systemMessage }` when there is something to tell the user, one line each,
 * and to `{}` otherwise. Never throws, and never takes 4 s.
 */
export async function sessionStartHook(o: { pluginRoot: string; profile: string; p: Paths; deps: HookDeps }): Promise<{ systemMessage?: string }> {
  const started = Date.now()
  const deadline = started + BUDGET_MS
  const { p, deps } = o
  let profiles: Record<string, unknown>
  try {
    profiles = readRoutes(p).profiles
  } catch (err) {
    return { systemMessage: `beacons cannot read its routes: ${message(err)}` }
  }
  // routes.json names a profile as path.resolve does; only the file's own keys ("constructor" is no profile).
  if (!Object.hasOwn(profiles, path.resolve(o.profile))) return {}

  const say: string[] = []
  if (!(await answers(deps, HEALTH_MS))) {
    if (locked(deps)) {
      await waitForHealth(deps, Math.min(Date.now() + WAIT_MS, deadline))
      say.push(RESTARTING)
    } else {
      // A start that fails (or hangs) leaves nothing to wait for.
      const started = await within(
        async () => {
          await deps.ensureStarted()
          return true
        },
        deadline - Date.now(),
        false,
      )
      const back = started && (await waitForHealth(deps, Math.min(Date.now() + WAIT_MS, deadline)))
      if (!back) say.push(NOT_ANSWERING)
    }
  }
  upgradeIfNewer(o)
  const failed = failedUpgrade(p)
  if (failed) say.push(failed)
  return say.length > 0 ? { systemMessage: say.join("\n") } : {}
}

// --- the real deps --------------------------------------------------------

/**
 * `nohup sh <pluginRoot>/bin/beacons upgrade >/dev/null 2>&1 &`: the upgrade
 * runs from the plugin copy (its code, its Node), in its own session, and
 * outlives this hook. Nothing waits for it; last-upgrade.json says how it went.
 */
export function spawnUpgrade(pluginRoot: string): void {
  const child = spawn("nohup", ["sh", path.join(pluginRoot, "bin", "beacons"), "upgrade"], { detached: true, stdio: "ignore" })
  child.on("error", () => {
    // No nohup: the next session start tries again.
  })
  child.unref()
}

/** The hook's real deps: the daemon on `port`, the service manager through `run`. `platform` is for tests. */
export function hookDeps(p: Paths, o: { port: number; run: Run; platform?: NodeJS.Platform }): HookDeps {
  return {
    health: () => daemonHealth(o.port, HEALTH_MS),
    ensureStarted: () => ensureStarted(p, o.run, LABEL, o.platform ?? process.platform),
    spawnUpgrade,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    lockHeld: () => lockHeld(p),
  }
}
