// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The daemon: what launchd or systemd runs, the current release on the current
// Node. It moves an oversized daemon.log aside, then counts its own starts. A
// start that ends in a clean exit 0, or that its environment stops (a taken
// port, a gateway.json or accounts.json it cannot load: exit 1), takes itself
// back out of the count; an environment stop that follows another waits
// before it exits, longer each time, up to a minute. Three left inside a minute is a
// crash loop: with a previous release that is not held, it switches to that
// one, holds the one it left, and exits 1, so the service manager starts the
// build that worked. Then it boots the engine, listens on loopback and serves
// until it is asked to leave:
//
//   POST /beacons/v1/restart        at the next quiet moment: every reply says
//                                   `connection: close`, and the listener closes
//                                   the instant no reply is open (at 30 minutes,
//                                   a 3 s drain instead); then the quota state
//                                   is written and it exits 0
//   POST .../restart {"now": true}  the 3 s drain at once
//   SIGTERM, SIGINT                 the same; a second signal exits at once
//
// Our lines go to stderr. stdout carries the listening line, and the engine's
// own state-change lines (ruling R17). Nothing is logged per request.
import { closeSync, openSync, readFileSync, readSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs"
import { createServer, type AddressInfo } from "node:net"
import path from "node:path"
import type { Server } from "node:http"
import { clearEnvironmentFailures, forgetBoot, noteEnvironmentFailure, recordBoot } from "./bootcount.ts"
import { Chain } from "./chain.ts"
import { ensurePrivateDirs, loadGatewayConfig, readRoutes } from "./config.ts"
import type { GatewayConfig } from "./config.ts"
import type { ControlDeps } from "./control.ts"
import { bootEngine } from "./engine-glue.ts"
import { resolveUpstreamProxy } from "./engine/upstream-proxy.js"
import { createFront } from "./front.ts"
import { beaconsPaths } from "./paths.ts"
import type { Paths } from "./paths.ts"
import { readReleaseState, switchTo } from "./release.ts"
import { SessionMap } from "./sessions.ts"

const HOST = "127.0.0.1"
const DRAIN_CAP_MS = 3000
const QUIET_WAIT_MS = 30 * 60_000
const PRUNE_EVERY_MS = 10 * 60_000
const DEV_VERSION = "0.0.0-dev"
/** daemon.log past this is moved aside at the next start, so it never grows without end. */
const LOG_CAP_BYTES = 5 * 1024 * 1024

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** One line to stderr, written before this returns: the process may exit next. */
function say(line: string): void {
  try {
    writeSync(2, `beacons: ${line}\n`)
  } catch {
    // Nowhere to say it.
  }
}

/** This release's version, from the plugin manifest beside `src/`. */
function releaseVersion(): string {
  try {
    const j = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8")) as { version?: unknown } | null
    return typeof j?.version === "string" && j.version !== "" ? j.version : DEV_VERSION
  } catch {
    return DEV_VERSION
  }
}

/** A profile's route from routes.json, read when asked. Only the file's own keys: "constructor" is no profile. */
function routeFor(p: Paths, profile: string): { mode: "pool" | "pin"; account: string } | null {
  const profiles = readRoutes(p).profiles
  if (!Object.hasOwn(profiles, profile)) return null
  const r = profiles[profile]
  return r && (r.mode === "pool" || r.mode === "pin") && typeof r.account === "string" ? { mode: r.mode, account: r.account } : null
}

/**
 * Why accounts.json would stop the engine's boot, or null when it would not: a
 * file that cannot be read, is not JSON, or is not an object, or a proxy
 * setting the engine refuses (on that it exits by itself). A missing file is
 * fine: the boot makes an empty one. Each is a fault in the file, not the build.
 */
function accountsFault(file: string): string | null {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    return `${file} cannot be read: ${message(err)}`
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return `${file} is not valid JSON`
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return `${file} must be a JSON object`
  try {
    resolveUpstreamProxy(doc)
  } catch (err) {
    return `${file}: ${message(err)}`
  }
  return null
}

/**
 * Keep daemon.log under LOG_CAP_BYTES: past it, its newest LOG_CAP_BYTES go to
 * daemon.log.1 (replacing the one before) and daemon.log is emptied in place.
 * In place, not renamed: launchd opened it for this process's output already,
 * appending, so this run's lines go on landing in daemon.log. Never stops the
 * start: on systemd there is no such file (the journal keeps the log).
 */
function capLog(file: string): void {
  try {
    const size = statSync(file).size
    if (size <= LOG_CAP_BYTES) return
    const tail = Buffer.alloc(LOG_CAP_BYTES)
    const fd = openSync(file, "r")
    try {
      readSync(fd, tail, 0, LOG_CAP_BYTES, size - LOG_CAP_BYTES)
    } finally {
      closeSync(fd)
    }
    writeFileSync(`${file}.1`, tail, { mode: 0o600 })
    truncateSync(file, 0)
  } catch {
    // No log yet, or none to cap.
  }
}

/** Whether something already listens on 127.0.0.1:<port>. Port 0 never is; any other error is left to the real listen. */
function portTaken(port: number): Promise<boolean> {
  if (port === 0) return Promise.resolve(false)
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once("error", (err: NodeJS.ErrnoException) => resolve(err.code === "EADDRINUSE"))
    probe.listen(port, HOST, () => probe.close(() => resolve(false)))
  })
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, HOST, () => {
      server.off("error", reject)
      resolve()
    })
  })
}

/**
 * On a crash loop, switch back to the previous release and exit 1. The version
 * left is held, so the session hook does not upgrade straight back to it (a
 * newer one is still taken). A previous release that is itself held already
 * crash-looped: going back to it would only flip between the two, so it stays.
 * With no previous release to go to, or one that cannot be switched to, say so
 * and boot anyway.
 */
function escapeCrashLoop(p: Paths): void {
  let state: ReturnType<typeof readReleaseState>
  try {
    state = readReleaseState(p)
  } catch (err) {
    return say(`three starts inside a minute, and the release state cannot be read (${message(err)}); starting anyway`)
  }
  const { current, previous, held } = state
  if (!previous) return say("three starts inside a minute, and no previous release to go back to; starting anyway")
  if (previous === held) return say(`crash loop on ${current ?? "this build"}; previous ${previous} is held, not switching`)
  try {
    switchTo(p, previous, { hold: true })
  } catch (err) {
    return say(`three starts inside a minute, and release ${previous} cannot be switched to (${message(err)}); starting anyway`)
  }
  say(`three starts inside a minute: switched back to release ${previous}, which the service manager starts next`)
  process.exit(1)
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const p = beaconsPaths(env)
  ensurePrivateDirs(p)
  capLog(path.join(p.logsDir, "daemon.log"))
  const started = Date.now()
  if (recordBoot(p.bootCount, started).crashLoop) escapeCrashLoop(p)

  /** This start says nothing about the build: take it back out of the count. Never stops the exit. */
  function forgetThisStart(): void {
    try {
      forgetBoot(p.bootCount, started)
    } catch (err) {
      say(`could not update the boot count: ${message(err)}`)
    }
  }
  /** A clean exit 0: a signal, or a leave that finished. */
  function exitClean(): never {
    forgetThisStart()
    process.exit(0)
  }
  /**
   * The environment stopped this start (a taken port, a gateway.json or
   * accounts.json it cannot load), not the build. When the start before
   * stopped this way too, wait first (bootcount.ts says how long), so a service
   * manager that starts beacons again at once does not spin a Node and a log
   * line a second. Never once the engine is up: nothing of it may run on while
   * this waits. A signal while it waits exits at once.
   */
  async function exitForEnvironment(line: string, o: { engineUp?: boolean } = {}): Promise<never> {
    forgetThisStart()
    let wait = 0
    try {
      wait = noteEnvironmentFailure(p.envFailures, Date.now())
    } catch (err) {
      say(`could not record the failure: ${message(err)}`)
    }
    if (wait > 0 && !o.engineUp) {
      say(`${line} (the start before stopped too: waiting ${wait / 1000} s before exiting)`)
      await new Promise((resolve) => setTimeout(resolve, wait))
    } else {
      say(line)
    }
    process.exit(1)
  }

  // Until it serves there is nothing to finish: a signal exits at once.
  let leaving: "no" | "patient" | "draining" = "no"
  let leave: (now: boolean) => void = () => exitClean()
  const onSignal = () => (leaving === "draining" ? exitClean() : leave(true))
  process.on("SIGTERM", onSignal)
  process.on("SIGINT", onSignal)

  const log = (line: string) => void process.stderr.write(`beacons: ${line}\n`)
  let cfg: GatewayConfig
  try {
    cfg = loadGatewayConfig(p)
  } catch (err) {
    return exitForEnvironment(message(err))
  }
  const sessions = new SessionMap()
  const chain = new Chain({ upstreamUrl: cfg.upstreamUrl, fallback: cfg.chainFallback })
  const fault = accountsFault(p.accountsFile)
  if (fault !== null) return exitForEnvironment(fault)
  // Before the engine boots: its quota prober asks every account at once, which must not happen beside whatever holds the port.
  if (await portTaken(cfg.port)) return exitForEnvironment(`port ${cfg.port} is in use`)
  const engine = await bootEngine({ accountsFile: p.accountsFile, log })

  let port = 0
  const control: ControlDeps = {
    version: releaseVersion(),
    engine,
    sessions,
    port: () => port,
    upstreamUrl: cfg.upstreamUrl,
    routeFor: (profile) => routeFor(p, profile),
    chain: () => ({ on: chain.on, state: chain.state(), fallback: cfg.chainFallback }),
    inFlight: () => front.inFlight(),
    reload: () => engine.reload(),
    leave: ({ now }) => leave(now),
  }
  const front = createFront({ cfg, engine, sessions, chain, control, log })

  chain.start()
  try {
    await listen(front.server, cfg.port)
  } catch (err) {
    // Exit writing nothing but the boot count: the engine has served nothing, and what holds the port may be another beacons.
    const e = err as NodeJS.ErrnoException
    if (e.code === "EADDRINUSE") return exitForEnvironment(`port ${cfg.port} is in use`, { engineUp: true })
    say(`cannot listen on ${HOST}:${cfg.port}: ${e.message}`)
    process.exit(1)
  }
  front.server.on("error", (err: Error) => log(`listener: ${err.message}`))
  port = (front.server.address() as AddressInfo).port
  try {
    clearEnvironmentFailures(p.envFailures)
  } catch (err) {
    say(`could not clear the record of earlier failures: ${message(err)}`)
  }
  const prune = setInterval(() => sessions.prune(Date.now()), PRUNE_EVERY_MS)
  prune.unref()

  let hurry = () => {}
  /**
   * Patient: wait for the front's quiet moment (or 30 minutes). Now: skip the
   * wait. Either way a 3 s drain, then the quota state is written (`stop`
   * lands queued token writes first) and the process exits 0. A leave asked
   * while one is under way only ever hurries it.
   */
  const goodbye = async (now: boolean): Promise<void> => {
    if (leaving === "draining") return
    if (leaving === "patient") {
      if (now) {
        leaving = "draining"
        hurry()
      }
      return
    }
    leaving = now ? "draining" : "patient"
    if (!now) {
      await new Promise<void>((resolve) => {
        const go = () => {
          clearTimeout(cap)
          resolve()
        }
        const cap = setTimeout(go, QUIET_WAIT_MS)
        hurry = go
        void front.leaving().then(go)
      })
      leaving = "draining"
    }
    await front.drain({ capMs: DRAIN_CAP_MS })
    clearInterval(prune)
    chain.stop()
    await engine.stop()
    exitClean()
  }
  leave = (now) =>
    void goodbye(now).catch((err: unknown) => {
      say(`leaving failed: ${message(err)}`)
      process.exit(1)
    })

  process.stdout.write(`beacons: listening on ${HOST}:${port}\n`)
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    say(message(err))
    process.exit(1)
  })
}
