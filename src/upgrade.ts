// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The patient upgrade. A plugin update brings new code; `upgrade` makes it the
// running build, one step after another:
//
//   1. take upgrade.lock: one upgrade at a time, and the session hook that
//      sees it waits for the service instead of starting a second one
//   2. snapshot the plugin copy into releases/<version>
//   3. boot that snapshot once, on its own Node, in a scratch HOME on a spare
//      port: a build that cannot start never becomes current, and is held,
//      since its snapshot is reused as it is and could only fail again
//   4. point current at it, and ask the running daemon to leave at its next
//      quiet moment (or now); a daemon that is down is kickstarted instead
//   5. wait for health to report the new version, up to 31 minutes (the
//      daemon's 30-minute cap on waiting for a quiet moment, and a boot); a
//      new build that crash-loops is switched back by the daemon's own guard,
//      and once the old build answers again the wait ends there
//   6. a build that never reports in is switched back from (to the version
//      upgraded from, by name, unless the guard is already back on it), held
//      so the session hook does not try it again at every start, and the
//      service manager is kickstarted onto the old one
//   7. record the outcome in last-upgrade.json (the session hook reports a
//      failure once), prune old releases, and let go of the lock
//
// `rollback` steps back one build by hand and holds the one it left.
import { spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { writeAtomic } from "./config.ts"
import { beaconsPaths } from "./paths.ts"
import type { Paths } from "./paths.ts"
import { hold, pluginVersion, prune, readRelease, readReleaseState, snapshot, switchTo } from "./release.ts"

export { prune, snapshot } from "./release.ts"

export type UpgradeDeps = {
  /**
   * Boot the release in `dir` once, away from the real data; true when it
   * answers health. False, or a rejection whose message says why, when not.
   */
  bootCheck(dir: string): Promise<boolean>
  /** Ask the running daemon to leave: at its next quiet moment, or `now`. */
  restart(o: { now: boolean }): Promise<void>
  /** The running daemon's health, or null when nothing answers. */
  health(): Promise<{ version: string } | null>
  /** Have the service manager start the service now. */
  kickstart(): Promise<void>
  sleep(ms: number): Promise<void>
}

export type UpgradeResult = { ok: boolean; from: string | null; to: string; reason?: string }

const WAIT_MS = 31 * 60_000
const POLL_MS = 1000
const BOOT_CHECK_MS = 10_000
/** A lock with no pid in it yet is one being written, for this long; after that it is debris. */
const LOCK_GRACE_MS = 10_000
/**
 * A lock not renewed for this long is stale even when its pid is alive: the
 * upgrade crashed and the pid went to another process. A running upgrade
 * renews its lock every minute (wall clock), so it never gets near this.
 */
const LOCK_MAX_AGE_MS = 60 * 60_000
const LOCK_RENEW_MS = 60_000
const LISTENING = /beacons: listening on 127\.0\.0\.1:(\d+)\n/
/** How much of the boot check's stderr is kept, and how much of its tail goes into a reason. */
const STDERR_KEEP_CHARS = 8192
const STDERR_TAIL_CHARS = 500
/** The boot check's accounts file: no account, so no grant is touched and no quota probed. */
const NO_ACCOUNTS = { accounts: [], switchThreshold: 0.98, holdSeconds: 0, quotaProbeSeconds: 0 }

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

const duration = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`)

// --- the lock -------------------------------------------------------------

/** `at` is the lock's `time` (its last renewal), or the file's mtime when that is missing. */
type LockSeen = { text: string; pid: number | null; mtimeMs: number; at: number }

function readLock(file: string): LockSeen | null {
  let text: string
  let mtimeMs: number
  try {
    text = readFileSync(file, "utf8")
    mtimeMs = statSync(file).mtimeMs
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
  let pid: number | null = null
  let at = mtimeMs
  try {
    const j = JSON.parse(text) as { pid?: unknown; time?: unknown } | null
    // Only a real pid: 0 or a negative one would signal a whole process group.
    if (typeof j?.pid === "number" && Number.isInteger(j.pid) && j.pid > 0) pid = j.pid
    const t = typeof j?.time === "string" ? Date.parse(j.time) : NaN
    if (Number.isFinite(t)) at = t
  } catch {
    // Not written yet, or debris.
  }
  return { text, pid, mtimeMs, at }
}

const lockText = () => JSON.stringify({ pid: process.pid, time: new Date(Date.now()).toISOString() }) + "\n"

/** EPERM is a live process of another user's: it holds the lock all the same. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

const holds = (l: LockSeen): boolean =>
  l.pid === null ? Date.now() - l.mtimeMs < LOCK_GRACE_MS : Date.now() - l.at <= LOCK_MAX_AGE_MS && alive(l.pid)

/**
 * True while a live upgrade (or rollback) holds `upgrade.lock`. A lock whose
 * process is gone, or that has not been renewed for an hour, is stale, not held.
 */
export function lockHeld(p: Paths): boolean {
  const l = readLock(p.upgradeLock)
  return l !== null && holds(l)
}

/** Create the lock with O_EXCL, holding this pid and the time. A stale one is taken over; a held one is left. */
function takeLock(p: Paths): boolean {
  mkdirSync(p.dataDir, { recursive: true, mode: 0o700 })
  for (let tries = 0; tries < 3; tries++) {
    let fd: number
    try {
      fd = openSync(p.upgradeLock, "wx", 0o600)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      const seen = readLock(p.upgradeLock)
      if (seen && holds(seen)) return false
      // Stale. Take it out only while it is still the lock judged stale, not one another upgrade just made.
      if (seen && readLock(p.upgradeLock)?.text === seen.text) {
        try {
          unlinkSync(p.upgradeLock)
        } catch {
          // Another upgrade took it out first.
        }
      }
      continue
    }
    try {
      writeSync(fd, lockText())
    } finally {
      closeSync(fd)
    }
    return true
  }
  return false
}

/** Renew this process's lock's time, so a long wait never looks abandoned. A lock that is no longer ours is left alone. */
function renewLock(p: Paths): void {
  try {
    if (readLock(p.upgradeLock)?.pid === process.pid) writeAtomic(p.upgradeLock, lockText(), 0o600)
  } catch {
    // The next renewal tries again.
  }
}

/** Remove the lock if it is this process's. */
function releaseLock(p: Paths): void {
  try {
    if (readLock(p.upgradeLock)?.pid === process.pid) unlinkSync(p.upgradeLock)
  } catch {
    // Already gone.
  }
}

// --- the service ----------------------------------------------------------

/** Health, where a call that throws or an answer without a version is nothing answering. */
async function health(deps: UpgradeDeps): Promise<{ version: string } | null> {
  try {
    const h = await deps.health()
    return h && typeof h.version === "string" ? h : null
  } catch {
    return null
  }
}

/** Ask the running daemon to leave; one that is down, or will not take the call, is kickstarted. */
async function restartService(deps: UpgradeDeps, now: boolean): Promise<void> {
  if ((await health(deps)) === null) return deps.kickstart()
  try {
    await deps.restart({ now })
  } catch {
    await deps.kickstart()
  }
}

/** The current release, or null when the state cannot be read. */
function currentOf(p: Paths): string | null {
  try {
    return readReleaseState(p).current
  } catch {
    return null
  }
}

type Waited = { ok: true } | { ok: false; reverted: true } | { ok: false; reverted: false; last: string | null }

/**
 * Poll health at most once a second until it reports `to`. The time waited
 * is what `sleep` was asked for or the clock, whichever is more: a slow health
 * call counts, and a fake sleep still ends the wait. The clock is monotonic
 * (`performance.now()`), which stops while the machine sleeps, as the daemon's
 * 30-minute timer and `sleep` do. The wall clock runs on, so a laptop that
 * slept an hour would wake to a timeout and switch a good build back.
 *
 * Each poll renews the lock once its time is a minute old by the wall clock,
 * so the first poll after a sleep renews it and no one takes it as stale.
 *
 * It stops early when the new build did not stay up: the daemon's crash-loop
 * guard has switched current back to `from` and that build answers again.
 * Health reporting `from` alone is no sign, since the old daemon answers with it
 * until its quiet moment; the switch in the state is.
 */
async function waitFor(deps: UpgradeDeps, p: Paths, from: string | null, to: string, waitMs: number): Promise<Waited> {
  const t0 = performance.now()
  let slept = 0
  let renewedAt = Date.now()
  for (;;) {
    const h = await health(deps)
    if (Date.now() - renewedAt >= LOCK_RENEW_MS) {
      renewLock(p)
      renewedAt = Date.now()
    }
    if (h?.version === to) return { ok: true }
    if (from !== null && h?.version === from && currentOf(p) === from) return { ok: false, reverted: true }
    if (Math.max(slept, performance.now() - t0) >= waitMs) return { ok: false, reverted: false, last: h?.version ?? null }
    await deps.sleep(POLL_MS)
    slept += POLL_MS
  }
}

// --- upgrade and rollback -------------------------------------------------

/** Steps 2 to 6, under the lock. */
async function attempt(o: { pluginRoot: string; now: boolean; p: Paths; deps: UpgradeDeps; waitMs: number }, to: string): Promise<UpgradeResult> {
  const { p, deps } = o
  let from: string | null
  try {
    from = readReleaseState(p).current
  } catch (err) {
    return { ok: false, from: null, to, reason: `the release state cannot be read: ${message(err)}` }
  }
  const fail = (reason: string): UpgradeResult => ({ ok: false, from, to, reason })

  let dir: string
  try {
    dir = snapshot(o.pluginRoot, p).dir
  } catch (err) {
    return fail(`release ${to} cannot be snapshotted: ${message(err)}`)
  }
  let booted = false
  let why = ""
  try {
    booted = await deps.bootCheck(dir)
  } catch (err) {
    // A check that rejects is one the build did not pass; its message says why.
    why = ` (${message(err)})`
  }
  if (!booted) {
    // Held, not switched: the snapshot is reused as it is, so trying again at every session start could only fail again.
    let held = ""
    if (to !== from) {
      try {
        hold(p, to)
        held = `; ${to} is held`
      } catch (err) {
        held = `; holding ${to} failed: ${message(err)}`
      }
    }
    return fail(`release ${to} did not boot${why}; nothing was switched${held}`)
  }
  try {
    switchTo(p, to)
  } catch (err) {
    return fail(`release ${to} cannot be switched to: ${message(err)}`)
  }

  let startNote = ""
  try {
    await restartService(deps, o.now)
  } catch (err) {
    startNote = `; starting the service failed: ${message(err)}`
  }
  const seen = await waitFor(deps, p, from, to, o.waitMs)
  if (seen.ok) return { ok: true, from, to }
  // The guard already switched back, holding `to`, and the old build answers: nothing to switch or start.
  if (seen.reverted) return fail("the new build did not stay up")

  let reason =
    (seen.last === null
      ? `release ${to} did not answer within ${duration(o.waitMs)}`
      : `the service reports ${seen.last}, not ${to}, after ${duration(o.waitMs)}`) + startNote
  // Back to `from` by name, never to whatever `previous` is now: after the guard's switch that is `to` itself.
  if (from === null) reason += "; there is no release to go back to"
  else if (from !== to && currentOf(p) === from) reason += `; already back on ${from}`
  else if (from !== to) {
    try {
      switchTo(p, from, { hold: true })
      reason += `; switched back to ${from}`
    } catch (err) {
      reason += `; switching back to ${from} failed: ${message(err)}`
    }
  }
  try {
    await deps.kickstart()
  } catch (err) {
    reason += `; kickstart failed: ${message(err)}`
  }
  return fail(reason)
}

/**
 * Upgrade to the plugin copy at `pluginRoot` (see the top of this file). A
 * plugin copy with no version throws; every other failure is a result with
 * `ok: false` and a reason, recorded in last-upgrade.json. While another
 * upgrade holds the lock, nothing is done and nothing recorded.
 */
export async function upgrade(o: { pluginRoot: string; now: boolean; p: Paths; deps: UpgradeDeps; waitMs?: number }): Promise<UpgradeResult> {
  const { p } = o
  const to = pluginVersion(o.pluginRoot)
  if (!takeLock(p)) {
    let from: string | null = null
    try {
      from = readReleaseState(p).current
    } catch {
      // Unknown; the running upgrade will say.
    }
    return { ok: false, from, to, reason: "another upgrade is running" }
  }
  try {
    const result = await attempt({ ...o, waitMs: o.waitMs ?? WAIT_MS }, to)
    try {
      writeAtomic(p.lastUpgrade, JSON.stringify({ ...result, at: new Date().toISOString(), shown: false }, null, 2) + "\n", 0o600)
    } catch {
      // The result still goes back to the caller.
    }
    try {
      prune(p)
    } catch {
      // Old releases stay until the next upgrade; nothing depends on their going.
    }
    return result
  } finally {
    releaseLock(p)
  }
}

/**
 * Step back one build: switch to the previous release, holding the one left
 * so the session hook does not upgrade straight back to it, and ask the
 * daemon to leave at its next quiet moment (kickstarting one that is down).
 * Throws, changing nothing, with no previous release, with a previous release
 * that is held (reverted), or while an upgrade holds the lock.
 */
export async function rollback(p: Paths, deps: UpgradeDeps): Promise<{ to: string }> {
  if (!takeLock(p)) throw new Error("an upgrade is running; roll back once it has finished")
  try {
    const { previous, held } = readReleaseState(p)
    if (!previous) throw new Error("there is no previous release to roll back to")
    // Held means reverted: by a rollback (a second one would undo the first), a failed upgrade, or the crash-loop guard.
    if (previous === held) throw new Error(`the previous release ${previous} was reverted (it is held); rollback does not go back onto it`)
    switchTo(p, previous, { hold: true })
    await restartService(deps, false)
    return { to: previous }
  } finally {
    releaseLock(p)
  }
}

// --- the default boot check -----------------------------------------------

/** `promise`, or nothing after `ms`. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([promise, new Promise<void>((r) => (timer = setTimeout(r, ms)))])
  clearTimeout(timer)
}

/** Null when health answers 200; otherwise what it did. */
function askHealth(port: number, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/beacons/v1/health", agent: false, timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(res.statusCode === 200 ? null : `health answered ${res.statusCode}`)
    })
    req.on("timeout", () => req.destroy())
    req.on("error", (err) => resolve(`health did not answer: ${err.message}`))
  })
}

/**
 * Anything shaped like a credential, cut down. The boot check's daemon has no
 * accounts, so it holds no token to print; this is the second line.
 */
const redact = (s: string): string =>
  s
    .replace(/\b(sk-ant-)[\w-]+/g, "$1…")
    .replace(/\b(Bearer\s+)\S+/gi, "$1…")
    .replace(/[A-Za-z0-9_+=-]{40,}/g, "…")

/**
 * The child's last stderr lines, about `STDERR_TAIL_CHARS` of them on one
 * line, without the stack frames and the Node version line around an error.
 */
function stderrTail(text: string): string {
  const lines = redact(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^at\s/.test(l) && !/^Node\.js v\d/.test(l) && !/^\^+$/.test(l))
  const out: string[] = []
  let size = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const add = lines[i].length + (out.length > 0 ? 3 : 0)
    if (size + add > STDERR_TAIL_CHARS) {
      if (out.length === 0) out.push("…" + lines[i].slice(-(STDERR_TAIL_CHARS - 1)))
      break
    }
    out.unshift(lines[i])
    size += add
  }
  return out.join(" | ")
}

/**
 * Boot the release in `dir` once: its own `src/daemon.ts` on the Node its
 * `release.json` names, exactly as the service would run it, but with a
 * scratch HOME and XDG dirs, port 0 and no accounts, so it touches neither the
 * real boot count, the releases, nor any grant. Resolves true when it prints
 * its port and answers health within `timeoutMs` (10 s). Otherwise it rejects
 * with why (no Node, an exit, no answer) and the tail of the child's stderr,
 * which `upgrade` puts in its reason. A build that cannot even load fails
 * here, the only place it can be caught before it is current. The child is
 * always killed, and the scratch dirs removed.
 */
export async function bootCheck(dir: string, p: Paths, o: { timeoutMs?: number } = {}): Promise<true> {
  const timeoutMs = o.timeoutMs ?? BOOT_CHECK_MS
  const { node } = readRelease(dir)
  const nodeBin = path.join(p.nodeDir, node, "bin", "node")
  if (!existsSync(nodeBin)) throw new Error(`Node ${node} is not installed (${nodeBin})`)
  const scratch = mkdtempSync(path.join(tmpdir(), "beacons-boot-"))
  try {
    const env = {
      HOME: scratch,
      XDG_CONFIG_HOME: path.join(scratch, "config"),
      XDG_DATA_HOME: path.join(scratch, "data"),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    }
    const sp = beaconsPaths(env)
    mkdirSync(sp.configDir, { recursive: true, mode: 0o700 })
    writeFileSync(sp.gatewayFile, JSON.stringify({ port: 0 }) + "\n", { mode: 0o600 })
    writeFileSync(sp.accountsFile, JSON.stringify(NO_ACCOUNTS) + "\n", { mode: 0o600 })

    const child = spawn(nodeBin, ["--experimental-strip-types", "--no-warnings", path.join(dir, "src", "daemon.ts")], {
      cwd: scratch,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-STDERR_KEEP_CHARS)))
    const closed = new Promise<void>((r) => {
      child.once("close", () => r())
      child.once("error", () => r())
    })
    let failure: string | null
    try {
      failure = await new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(`no answer within ${timeoutMs / 1000} s`), timeoutMs)
        const done = (why: string | null) => {
          clearTimeout(timer)
          resolve(why)
        }
        child.once("error", (err) => done(`${nodeBin} did not start: ${err.message}`))
        child.once("exit", (code, signal) => done(code !== null ? `exited ${code} before answering` : `stopped by ${signal} before answering`))
        let out: string | null = ""
        child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
          if (out === null) return
          out += chunk
          const m = LISTENING.exec(out)
          if (!m) return
          out = null
          void askHealth(Number(m[1]), timeoutMs).then(done)
        })
      })
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      // Closed: stderr is read to its end.
      await within(closed, 2000)
    }
    if (failure === null) return true
    const tail = stderrTail(stderr)
    throw new Error(tail ? `${failure}: ${tail}` : failure)
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      // Left in the OS temp dir.
    }
  }
}
