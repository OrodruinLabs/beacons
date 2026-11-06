// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The real launchd, opt in: `BEACONS_LIVE=1 npm run test:live`, on macOS.
// Skipped everywhere else, `npm test` included.
//
// It installs beacons' launchd unit for real, under the label
// com.orodruinlabs.beacons.test and on a spare port, from a scratch HOME and
// XDG dirs: the plist goes to <scratch>/Library/LaunchAgents, which
// `launchctl bootstrap` takes from any path, so the real LaunchAgents folder
// is never touched. The unit runs on the Node bin/beacons fetches and checks
// against node-sha256.txt (BEACONS_NODE_DIST points it at a local copy of the
// archives instead of nodejs.org). The test checks health, upgrades to a
// plugin copy one patch newer while a prober opens a new connection every
// 10 ms, prints how long connections were refused while launchd brought the
// new build up (and asserts it is under 5 s), and uninstalls. The unit is
// booted out in `finally`, whatever happened. It never uses the real label,
// port 4774, or any real config, and sends no request upstream: the
// daemon has no accounts.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import net from "node:net"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { realRun } from "../src/cli.ts"
import { ensurePrivateDirs } from "../src/config.ts"
import { beaconsPaths } from "../src/paths.ts"
import { daemonHealth } from "../src/loopback.ts"
import { snapshot, switchTo } from "../src/release.ts"
import { installService, kickstart, LABEL, uninstallService } from "../src/service.ts"
import { bootCheck, upgrade } from "../src/upgrade.ts"

const LIVE = process.env.BEACONS_LIVE === "1"
const TEST_LABEL = "com.orodruinlabs.beacons.test"
const REPO = fileURLToPath(new URL("..", import.meta.url))
const VERSION = (JSON.parse(readFileSync(path.join(REPO, ".claude-plugin", "plugin.json"), "utf8")) as { version: string }).version
const NODE = /^v?(\d+\.\d+\.\d+)/.exec(readFileSync(path.join(REPO, "node-sha256.txt"), "utf8"))![1]
const WINDOW_LIMIT_MS = 5000

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
async function until(pred: () => boolean | Promise<boolean>, ms: number, every = 100): Promise<boolean> {
  const t = Date.now() + ms
  for (;;) {
    if (await pred()) return true
    if (Date.now() >= t) return false
    await sleep(every)
  }
}

async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

/** One patch above `v`: 0.1.0 → 0.1.1. */
function bump(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)!
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

/** A plugin copy at `version`: the parts a release takes. */
function pluginCopy(dir: string, version: string): void {
  for (const part of ["bin", "src", "package.json", "node-sha256.txt"]) cpSync(path.join(REPO, part), path.join(dir, part), { recursive: true })
  const manifest = JSON.parse(readFileSync(path.join(REPO, ".claude-plugin", "plugin.json"), "utf8")) as Record<string, unknown>
  mkdirSync(path.join(dir, ".claude-plugin"))
  writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ ...manifest, version }, null, 2) + "\n")
}

/** Whether a new connection to `port` is accepted. Refused, or no answer within a second, is false. */
function connects(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port })
    const done = (ok: boolean) => {
      s.destroy()
      resolve(ok)
    }
    s.setTimeout(1000, () => done(false))
    s.once("connect", () => done(true))
    s.once("error", () => done(false))
  })
}

type Try = { at: number; ok: boolean }

/** A new connection every 10 ms until stopped; each one's time (monotonic ms) and whether it was accepted. */
function prober(port: number) {
  const tries: Try[] = []
  let stopped = false
  const loop = (async () => {
    while (!stopped) {
      const at = performance.now()
      tries.push({ at, ok: await connects(port) })
      await sleep(10)
    }
  })()
  return {
    stop: async (): Promise<Try[]> => {
      stopped = true
      await loop
      return tries
    },
  }
}

/**
 * From the first refused connection to the first one accepted after the last
 * refusal: the whole time the port turned new connections away, spread over
 * one stretch or several. Zero when none was refused.
 */
function refusedWindow(tries: Try[]): { ms: number; refused: number; stretches: number } {
  const first = tries.findIndex((t) => !t.ok)
  if (first < 0) return { ms: 0, refused: 0, stretches: 0 }
  let last = first
  let stretches = 0
  for (let i = first; i < tries.length; i++) {
    if (tries[i].ok) continue
    last = i
    if (i === 0 || tries[i - 1].ok) stretches++
  }
  const back = tries.findIndex((t, i) => i > last && t.ok)
  const end = back < 0 ? performance.now() : tries[back].at
  return { ms: Math.round(end - tries[first].at), refused: tries.filter((t) => !t.ok).length, stretches }
}

const skip = !LIVE ? "set BEACONS_LIVE=1 to run it" : process.platform !== "darwin" ? "launchd runs on macOS only" : false

test("live: the real launchd unit restarts onto an upgrade, refusing connections under 5 s", { skip, timeout: 600_000 }, async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "beacons-"))
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  }
  if (process.env.BEACONS_NODE_DIST) env.BEACONS_NODE_DIST = process.env.BEACONS_NODE_DIST
  const p = beaconsPaths(env)
  const plist = path.join(home, "Library", "LaunchAgents", `${TEST_LABEL}.plist`)
  const service = `gui/${process.getuid!()}/${TEST_LABEL}`
  const run = realRun(env, 60_000)
  const port = await freePort()
  // Never the real service: not its label, its port, or the real home.
  assert.notEqual(TEST_LABEL, LABEL)
  assert.ok(port !== 4774, `port ${port}`)
  assert.notEqual(p.home, homedir())
  const log = () => {
    try {
      return readFileSync(path.join(p.logsDir, "daemon.log"), "utf8").slice(-3000)
    } catch {
      return "(no daemon log)"
    }
  }

  let probe: ReturnType<typeof prober> | null = null
  try {
    // beacons' own Node, fetched and checked against node-sha256.txt by the bootstrap.
    const boot = spawnSync("sh", [path.join(REPO, "bin", "beacons"), "help"], { env, encoding: "utf8", timeout: 300_000 })
    assert.equal(boot.status, 0, boot.stderr)
    const node = path.join(p.nodeDir, NODE, "bin", "node")
    assert.equal(spawnSync(node, ["--version"], { encoding: "utf8" }).stdout.trim(), `v${NODE}`)

    // The release and the unit, as setup lays them out, on a spare port and with no accounts.
    mkdirSync(p.configDir, { recursive: true, mode: 0o700 })
    writeFileSync(p.gatewayFile, JSON.stringify({ port, upstreamUrl: "https://api.anthropic.com", chainFallback: "wait" }) + "\n", { mode: 0o600 })
    writeFileSync(p.accountsFile, JSON.stringify({ accounts: [], switchThreshold: 0.98, quotaProbeSeconds: 0 }) + "\n", { mode: 0o600 })
    ensurePrivateDirs(p)
    switchTo(p, snapshot(REPO, p).version)
    await installService(p, run, TEST_LABEL, "darwin")
    assert.ok(existsSync(plist))
    assert.ok(await until(async () => (await daemonHealth(port))?.version === VERSION, 30_000), `launchd did not bring ${VERSION} up:\n${log()}`)

    // The upgrade, as the CLI runs it, but on the test label.
    const next = bump(VERSION)
    const copy = mkdtempSync(path.join(tmpdir(), "beacons-plugin-"))
    pluginCopy(copy, next)
    probe = prober(port)
    const r = await upgrade({
      pluginRoot: copy,
      now: false,
      p,
      waitMs: 60_000,
      deps: {
        bootCheck: (dir) => bootCheck(dir, p),
        restart: async ({ now }) => {
          const res = await fetch(`http://127.0.0.1:${port}/beacons/v1/restart`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ now }),
            signal: AbortSignal.timeout(2000),
          })
          await res.body?.cancel().catch(() => {})
          if (res.status !== 202) throw new Error(`the daemon answered HTTP ${res.status} to a restart`)
        },
        health: () => daemonHealth(port),
        kickstart: () => kickstart(p, run, TEST_LABEL, "darwin"),
        sleep,
      },
    })
    // A moment more, so the prober sees the port settled.
    await sleep(500)
    const tries = await probe.stop()
    probe = null
    assert.equal(r.ok, true, `${r.reason}\n${log()}`)
    assert.equal((await daemonHealth(port))?.version, next)
    const w = refusedWindow(tries)
    const report = `refused-connection window: ${w.ms} ms (${w.refused} of ${tries.length} connections refused, in ${w.stretches} stretch${w.stretches === 1 ? "" : "es"})`
    console.log(`live: ${report}`)
    t.diagnostic(report)
    assert.ok(tries.some((x) => x.ok), "the prober reached the daemon")
    assert.ok(w.ms < WINDOW_LIMIT_MS, report)

    // Uninstall: the unit is booted out and its plist removed; nothing answers after.
    await uninstallService(p, run, TEST_LABEL, "darwin")
    assert.equal(existsSync(plist), false)
    assert.ok(await until(async () => (await daemonHealth(port)) === null, 10_000), "the daemon stopped answering")
    // launchd forgets the job once its process has exited, a moment after bootout returns.
    assert.ok(await until(async () => (await run("launchctl", ["print", service])).code !== 0, 10_000), "launchd no longer knows the test label")
  } finally {
    await probe?.stop()
    // Whatever happened above: the test label is gone from launchd. "No such process" is fine.
    await run("launchctl", ["bootout", service])
  }
})
