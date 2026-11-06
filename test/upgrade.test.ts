// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// Release snapshots, the patient upgrade and rollback, against a scratch data
// dir. Every service call is a fake (UpgradeDeps), and the fake sleep returns
// at once, so a 31-minute wait takes no time. A release's Node is a dummy
// executable, except in the boot-check tests, which run real daemons on this
// process's own Node, each in a scratch HOME, and kill every one.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { beaconsPaths } from "../src/paths.ts"
import type { Paths } from "../src/paths.ts"
import { prune, readReleaseState, snapshot, switchTo } from "../src/release.ts"
import { bootCheck, lockHeld, rollback, upgrade } from "../src/upgrade.ts"
import type { UpgradeDeps } from "../src/upgrade.ts"

const REPO = fileURLToPath(new URL("..", import.meta.url))
const NODE = "26.13.0"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (pred: () => boolean, ms = 3000) => {
  const t = Date.now() + ms
  while (!pred() && Date.now() < t) await sleep(10)
  return pred()
}

function scratch(): { dir: string; env: Record<"HOME" | "XDG_CONFIG_HOME" | "XDG_DATA_HOME", string>; p: Paths } {
  const dir = mkdtempSync(path.join(tmpdir(), "beacons-"))
  const env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, "config"), XDG_DATA_HOME: path.join(dir, "data") }
  return { dir, env, p: beaconsPaths(env) }
}

/**
 * A plugin copy at `version`: the files a snapshot takes, and some it leaves.
 * `node: null` ships no node-sha256.txt; `without` leaves out one required part.
 */
function plugin(version: string, o: { node?: string | null; without?: "src" | "package.json" } = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "beacons-plugin-"))
  mkdirSync(path.join(root, ".claude-plugin"))
  writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "beacons", version }))
  writeFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "{}")
  if (o.without !== "package.json") writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "beacons", version, type: "module" }))
  if (o.without !== "src") {
    mkdirSync(path.join(root, "src", "engine"), { recursive: true })
    writeFileSync(path.join(root, "src", "daemon.ts"), `export const version = ${JSON.stringify(version)}\n`)
    writeFileSync(path.join(root, "src", "engine", "server.js"), "export {}\n")
  }
  mkdirSync(path.join(root, "bin"))
  writeFileSync(path.join(root, "bin", "beacons"), "#!/bin/sh\n", { mode: 0o755 })
  if (o.node !== null) writeFileSync(path.join(root, "node-sha256.txt"), `v${o.node ?? NODE}\n0000  node-v${o.node ?? NODE}-darwin-arm64.tar.gz\n`)
  mkdirSync(path.join(root, "test"))
  writeFileSync(path.join(root, "test", "a.test.ts"), "")
  writeFileSync(path.join(root, "README.md"), "")
  return root
}

/** `<data>/node/<node>/bin/node`, a dummy executable. */
function installNode(p: Paths, node: string): void {
  mkdirSync(path.join(p.nodeDir, node, "bin"), { recursive: true })
  writeFileSync(path.join(p.nodeDir, node, "bin", "node"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
}

/** A release folder with its release.json, dated `at` (seconds since the epoch) when given. */
function release(p: Paths, version: string, node: string, at?: number): void {
  const dir = path.join(p.releasesDir, version)
  mkdirSync(path.join(dir, "src"), { recursive: true })
  const manifest = path.join(dir, "release.json")
  writeFileSync(manifest, JSON.stringify({ version, node }))
  if (at !== undefined) utimesSync(manifest, at, at)
}

type Calls = { bootCheck: string[]; restart: { now: boolean }[]; kickstart: number; health: number; sleeps: number[] }

/**
 * Fake service calls. `health` sees the calls so far, so it can answer as the
 * old daemon until the restart, then as nothing, then as the new build.
 */
function fakeDeps(o: {
  boots?: boolean | (() => Promise<boolean>)
  health?: (c: Calls) => { version: string } | null
  restart?: () => Promise<void>
}): { deps: UpgradeDeps; calls: Calls } {
  const calls: Calls = { bootCheck: [], restart: [], kickstart: 0, health: 0, sleeps: [] }
  const deps: UpgradeDeps = {
    async bootCheck(dir) {
      calls.bootCheck.push(dir)
      return typeof o.boots === "function" ? o.boots() : (o.boots ?? true)
    },
    async restart(r) {
      calls.restart.push(r)
      if (o.restart) await o.restart()
    },
    async health() {
      const h = o.health ? o.health(calls) : null
      calls.health++
      return h
    },
    async kickstart() {
      calls.kickstart++
    },
    async sleep(ms) {
      calls.sleeps.push(ms)
    },
  }
  return { deps, calls }
}

const noCalls = (): Calls => ({ bootCheck: [], restart: [], kickstart: 0, health: 0, sleeps: [] })

/** last-upgrade.json, with `at` checked as an ISO time and taken out. */
function lastUpgrade(p: Paths): Record<string, unknown> {
  const j = JSON.parse(readFileSync(p.lastUpgrade, "utf8")) as Record<string, unknown>
  assert.equal(typeof j.at, "string")
  assert.equal(new Date(j.at as string).toISOString(), j.at)
  delete j.at
  return j
}

const dirs = (d: string) =>
  readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

/** A release whose src/daemon.ts is `code`, on a Node that is this process's own. */
function codeRelease(p: Paths, version: string, code: string, node = NODE): string {
  const dir = path.join(p.releasesDir, version)
  mkdirSync(path.join(dir, "src"), { recursive: true })
  writeFileSync(path.join(dir, "release.json"), JSON.stringify({ version, node }))
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }))
  writeFileSync(path.join(dir, "src", "daemon.ts"), code)
  return dir
}

function linkThisNode(p: Paths, node: string): void {
  const bin = path.join(p.nodeDir, node, "bin")
  if (existsSync(path.join(bin, "node"))) return
  mkdirSync(bin, { recursive: true })
  symlinkSync(process.execPath, path.join(bin, "node"))
}

// --- snapshot and prune ---------------------------------------------------

test("snapshot: copies the build, names its Node, and never overwrites one", () => {
  const { p } = scratch()
  const root = plugin("1.2.0")
  const r = snapshot(root, p)
  const dir = path.join(p.releasesDir, "1.2.0")
  assert.deepEqual(r, { version: "1.2.0", node: NODE, dir })
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "release.json"), "utf8")), { version: "1.2.0", node: NODE })
  assert.deepEqual(readdirSync(dir).sort(), [".claude-plugin", "bin", "node-sha256.txt", "package.json", "release.json", "src"])
  assert.deepEqual(readdirSync(path.join(dir, ".claude-plugin")), ["plugin.json"], "the release reports its own version")
  assert.deepEqual(readdirSync(path.join(dir, "src")).sort(), ["daemon.ts", "engine"])
  assert.ok(statSync(path.join(dir, "bin", "beacons")).mode & 0o100, "bin/ stays executable")
  assert.deepEqual(readdirSync(p.releasesDir), ["1.2.0"], "no temp folder is left")

  // A snapshot is immutable: the same version again is the folder as it is.
  writeFileSync(path.join(root, "src", "daemon.ts"), "changed\n")
  assert.deepEqual(snapshot(root, p), r)
  assert.equal(readFileSync(path.join(dir, "src", "daemon.ts"), "utf8"), 'export const version = "1.2.0"\n')

  // Without node-sha256.txt (a dev copy), the release runs on this Node; bin/ is optional.
  const dev = plugin("1.3.0", { node: null })
  const { p: q } = scratch()
  assert.equal(snapshot(dev, q).node, process.versions.node)

  // A copy that is not a whole plugin, or names no usable version, snapshots nothing.
  const { p: s } = scratch()
  const unnamed = plugin("1.4.0")
  writeFileSync(path.join(unnamed, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "beacons" }))
  assert.throws(() => snapshot(unnamed, s), /version/)
  assert.throws(() => snapshot(plugin("current"), s), /version/, "a version is semver, never a name like current")
  assert.throws(() => snapshot(plugin("1.4.0", { node: "latest" }), s), /node-sha256\.txt/)
  assert.throws(() => snapshot(plugin("1.4.0", { without: "src" }), s), /src/)
  assert.throws(() => snapshot(plugin("1.4.0", { without: "package.json" }), s), /package\.json/)
  assert.equal(existsSync(path.join(s.releasesDir, "1.4.0")), false)
  assert.deepEqual(existsSync(s.releasesDir) ? readdirSync(s.releasesDir) : [], [], "no temp folder is left")
})

test("prune: keeps five, never current, previous or held, and drops Node no release names", () => {
  const { p } = scratch()
  installNode(p, "24.0.0")
  installNode(p, "25.0.0")
  installNode(p, NODE)
  const nodes: Record<string, string> = { "0.1.0": "24.0.0", "0.3.0": "25.0.0" }
  for (let i = 1; i <= 8; i++) release(p, `0.${i}.0`, nodes[`0.${i}.0`] ?? NODE, 1_600_000_000 + i * 100)
  switchTo(p, "0.1.0")
  switchTo(p, "0.2.0", { hold: true })
  switchTo(p, "0.8.0")
  assert.deepEqual(readReleaseState(p), { current: "0.8.0", previous: "0.2.0", held: "0.1.0" })
  // Not releases: a snapshot's temp folder, and a folder with no release.json.
  mkdirSync(path.join(p.releasesDir, ".0.9.0.abc123"))
  mkdirSync(path.join(p.releasesDir, "notes"))

  prune(p)
  // 0.1.0 (held) and 0.2.0 (previous) are the oldest, so the next oldest go.
  assert.deepEqual(dirs(p.releasesDir), [".0.9.0.abc123", "0.1.0", "0.2.0", "0.6.0", "0.7.0", "0.8.0", "notes"])
  assert.deepEqual(dirs(p.nodeDir), ["24.0.0", NODE], "25.0.0 ran only 0.3.0")
  assert.equal(readlinkSync(p.currentRelease), path.join(p.releasesDir, "0.8.0"))
  assert.equal(readlinkSync(p.currentNode), path.join(p.nodeDir, NODE))

  prune(p, 1)
  assert.deepEqual(dirs(p.releasesDir), [".0.9.0.abc123", "0.1.0", "0.2.0", "0.8.0", "notes"], "never current, previous or held")
})

// --- upgrade --------------------------------------------------------------

test("upgrade: a failed boot check switches nothing", async () => {
  const { p } = scratch()
  installNode(p, NODE)
  release(p, "1.0.0", NODE)
  switchTo(p, "1.0.0")
  const { deps, calls } = fakeDeps({ boots: false, health: () => ({ version: "1.0.0" }) })

  const r = await upgrade({ pluginRoot: plugin("1.1.0"), now: false, p, deps })
  assert.equal(r.ok, false)
  assert.equal(r.from, "1.0.0")
  assert.equal(r.to, "1.1.0")
  assert.match(r.reason ?? "", /did not boot/)
  assert.deepEqual(calls.bootCheck, [path.join(p.releasesDir, "1.1.0")])
  // Nothing switched, but 1.1.0 is held: its snapshot is reused as it is, so a retry at every session start could only fail again.
  assert.deepEqual(readReleaseState(p), { current: "1.0.0", previous: null, held: "1.1.0" })
  const before = readFileSync(p.releaseState, "utf8")
  assert.equal(readlinkSync(p.currentRelease), path.join(p.releasesDir, "1.0.0"))
  assert.deepEqual(calls.restart, [])
  assert.equal(calls.kickstart, 0)
  assert.deepEqual(lastUpgrade(p), { ok: false, from: "1.0.0", to: "1.1.0", reason: r.reason, shown: false })
  assert.equal(existsSync(p.upgradeLock), false, "the lock is released")
  // The snapshot stays whole, so a retry reuses it.
  assert.deepEqual(JSON.parse(readFileSync(path.join(p.releasesDir, "1.1.0", "release.json"), "utf8")), { version: "1.1.0", node: NODE })

  // A boot check that rejects is one that failed, and its message says why.
  const thrown = fakeDeps({ boots: () => Promise.reject(new Error("exited 1 before listening: SyntaxError: x")), health: () => ({ version: "1.0.0" }) })
  const t = await upgrade({ pluginRoot: plugin("1.1.0"), now: false, p, deps: thrown.deps })
  assert.equal(t.ok, false)
  assert.match(t.reason ?? "", /did not boot \(exited 1 before listening: SyntaxError: x\)/)
  assert.equal(readFileSync(p.releaseState, "utf8"), before)
  assert.deepEqual(thrown.calls.restart, [])
})

test("upgrade: a new build that never answers is rolled back", async () => {
  const { p } = scratch()
  installNode(p, NODE)
  release(p, "1.0.0", NODE)
  switchTo(p, "1.0.0")
  // The old daemon answers until it is asked to leave; after that, nothing does.
  const { deps, calls } = fakeDeps({ health: (c) => (c.restart.length === 0 ? { version: "1.0.0" } : null) })

  const r = await upgrade({ pluginRoot: plugin("1.1.0"), now: false, p, deps, waitMs: 10_000 })
  assert.equal(r.ok, false)
  assert.equal(r.from, "1.0.0")
  assert.equal(r.to, "1.1.0")
  assert.match(r.reason ?? "", /did not answer within 10 s/)
  assert.match(r.reason ?? "", /switched back to 1\.0\.0/)
  assert.deepEqual(calls.restart, [{ now: false }])
  // At most once a second, for the whole wait.
  assert.deepEqual(calls.sleeps, Array(10).fill(1000))
  // Back on the old build, holding the new one, so the session hook does not retry it at every start.
  assert.deepEqual(readReleaseState(p), { current: "1.0.0", previous: "1.1.0", held: "1.1.0" })
  assert.equal(readlinkSync(p.currentRelease), path.join(p.releasesDir, "1.0.0"))
  assert.equal(calls.kickstart, 1, "the service manager starts the old build")
  assert.deepEqual(lastUpgrade(p), { ok: false, from: "1.0.0", to: "1.1.0", reason: r.reason, shown: false })
  assert.equal(existsSync(p.upgradeLock), false)
})

test("upgrade: a crash-looping new build that the guard already reverted is not switched back onto", async () => {
  const { p } = scratch()
  installNode(p, NODE)
  release(p, "1.0.0", NODE)
  switchTo(p, "1.0.0")
  // After the restart the new build loops: nothing answers, then the daemon's guard switches back to
  // 1.0.0 holding 1.1.0 (previous is now the bad build), and the service manager starts 1.0.0 again.
  const guard = () => {
    if (readReleaseState(p).current === "1.1.0") switchTo(p, "1.0.0", { hold: true })
  }
  const { deps, calls } = fakeDeps({
    health: (c) => {
      if (c.restart.length === 0) return { version: "1.0.0" }
      if (c.health < 3) return null
      guard()
      return { version: "1.0.0" }
    },
  })

  const r = await upgrade({ pluginRoot: plugin("1.1.0"), now: false, p, deps, waitMs: 60_000 })
  assert.deepEqual(r, { ok: false, from: "1.0.0", to: "1.1.0", reason: "the new build did not stay up" })
  assert.deepEqual(readReleaseState(p), { current: "1.0.0", previous: "1.1.0", held: "1.1.0" })
  assert.equal(readlinkSync(p.currentRelease), path.join(p.releasesDir, "1.0.0"))
  assert.ok(calls.sleeps.length < 5, `it stops once the old build is back, not at waitMs (${calls.sleeps.length} sleeps)`)
  assert.equal(calls.kickstart, 0, "the old build is up: nothing to start")
  assert.deepEqual(lastUpgrade(p), { ok: false, from: "1.0.0", to: "1.1.0", reason: "the new build did not stay up", shown: false })
  assert.equal(existsSync(p.upgradeLock), false)

  // The guard reverted, but the old build is slow to answer: the wait runs out, and still nothing moves onto 1.1.0.
  const { p: q } = scratch()
  installNode(q, NODE)
  release(q, "1.0.0", NODE)
  switchTo(q, "1.0.0")
  const slow = fakeDeps({
    health: (c) => {
      if (c.restart.length === 0) return { version: "1.0.0" }
      if (readReleaseState(q).current === "1.1.0") switchTo(q, "1.0.0", { hold: true })
      return null
    },
  })
  const s = await upgrade({ pluginRoot: plugin("1.1.0"), now: false, p: q, deps: slow.deps, waitMs: 5000 })
  assert.equal(s.ok, false)
  assert.match(s.reason ?? "", /did not answer within 5 s; already back on 1\.0\.0/)
  assert.deepEqual(readReleaseState(q), { current: "1.0.0", previous: "1.1.0", held: "1.1.0" })
  assert.equal(readlinkSync(q.currentRelease), path.join(q.releasesDir, "1.0.0"))
  assert.equal(slow.calls.kickstart, 1, "nothing answers, so the service manager is asked to start it")
})

test("upgrade: a service that keeps reporting the old version is rolled back", async () => {
  const { p } = scratch()
  installNode(p, NODE)
  release(p, "1.0.0", NODE)
  switchTo(p, "1.0.0")
  const { deps, calls } = fakeDeps({ health: () => ({ version: "1.0.0" }) })

  const r = await upgrade({ pluginRoot: plugin("1.1.0"), now: true, p, deps, waitMs: 5000 })
  assert.equal(r.ok, false)
  assert.match(r.reason ?? "", /reports 1\.0\.0, not 1\.1\.0/)
  assert.deepEqual(calls.restart, [{ now: true }])
  assert.equal(calls.sleeps.length, 5)
  assert.deepEqual(readReleaseState(p), { current: "1.0.0", previous: "1.1.0", held: "1.1.0" })
  assert.equal(calls.kickstart, 1)
})

test("upgrade: success moves current and previous and prunes to five", async () => {
  const { p } = scratch()
  installNode(p, "25.0.0")
  installNode(p, NODE)
  for (let i = 1; i <= 6; i++) release(p, `0.${i}.0`, i <= 2 ? "25.0.0" : NODE, 1_600_000_000 + i * 100)
  for (let i = 1; i <= 6; i++) switchTo(p, `0.${i}.0`)
  assert.deepEqual(readReleaseState(p), { current: "0.6.0", previous: "0.5.0", held: null })
  // The old daemon drains a while, the service manager restarts, then the new build answers.
  const { deps, calls } = fakeDeps({
    health: (c) => (c.restart.length === 0 || c.health < 4 ? { version: "0.6.0" } : c.health < 6 ? null : { version: "0.7.0" }),
  })

  const r = await upgrade({ pluginRoot: plugin("0.7.0"), now: true, p, deps })
  assert.deepEqual(r, { ok: true, from: "0.6.0", to: "0.7.0" })
  assert.deepEqual(calls.bootCheck, [path.join(p.releasesDir, "0.7.0")])
  assert.deepEqual(calls.restart, [{ now: true }])
  assert.equal(calls.kickstart, 0)
  assert.ok(calls.sleeps.every((ms) => ms === 1000))
  assert.deepEqual(readReleaseState(p), { current: "0.7.0", previous: "0.6.0", held: null })
  assert.equal(readlinkSync(p.currentRelease), path.join(p.releasesDir, "0.7.0"))
  assert.equal(readlinkSync(p.currentNode), path.join(p.nodeDir, NODE))
  assert.deepEqual(lastUpgrade(p), { ok: true, from: "0.6.0", to: "0.7.0", shown: false })
  // Pruned to five: the two oldest go, and with them the Node only they ran on.
  assert.deepEqual(dirs(p.releasesDir), ["0.3.0", "0.4.0", "0.5.0", "0.6.0", "0.7.0"])
  assert.deepEqual(dirs(p.nodeDir), [NODE])
  assert.equal(existsSync(p.upgradeLock), false)
})

test("upgrade: a laptop that sleeps through the wait does not fail a good upgrade", async (t) => {
  const { p } = scratch()
  installNode(p, NODE)
  release(p, "1.0.0", NODE)
  switchTo(p, "1.0.0")
  // The wall clock runs on through a sleep; the daemon's 30-minute timer and `sleep` stop with the machine.
  const wall = Date.now.bind(Date)
  let slept = 0
  t.mock.method(Date, "now", () => wall() + slept)
  let heldAfterWake: boolean | null = null
  const { deps, calls } = fakeDeps({
    health: (c) => {
      if (c.restart.length === 0) return { version: "1.0.0" }
      if (c.health === 2) slept = 3 * 60 * 60_000 // the lid closes for three hours
      if (c.health === 5) heldAfterWake = lockHeld(p)
      // On waking, the old daemon is still waiting for its quiet moment; then the new build answers.
      return c.health < 8 ? { version: "1.0.0" } : { version: "1.1.0" }
    },
  })

  const r = await upgrade({ pluginRoot: plugin("1.1.0"), now: false, p, deps })
  assert.deepEqual(r, { ok: true, from: "1.0.0", to: "1.1.0" })
  assert.deepEqual(readReleaseState(p), { current: "1.1.0", previous: "1.0.0", held: null })
  assert.equal(calls.kickstart, 0)
  // Three hours of wall time would make the lock look abandoned; the upgrade renews it once it wakes.
  assert.equal(heldAfterWake, true, "the lock is still this upgrade's after the sleep")
  assert.equal(existsSync(p.upgradeLock), false)
})

test("upgrade: a service that is down is kickstarted, and so is one that refuses the restart", async () => {
  const { p } = scratch()
  installNode(p, NODE)
  release(p, "1.0.0", NODE)
  switchTo(p, "1.0.0")
  // Down: nothing answers until the kickstart.
  const down = fakeDeps({ health: (c) => (c.kickstart === 0 ? null : { version: "1.1.0" }) })
  assert.deepEqual(await upgrade({ pluginRoot: plugin("1.1.0"), now: false, p, deps: down.deps }), { ok: true, from: "1.0.0", to: "1.1.0" })
  assert.deepEqual(down.calls.restart, [], "nothing to ask")
  assert.equal(down.calls.kickstart, 1)

  // Up, but the restart call fails.
  const refused = fakeDeps({
    health: (c) => (c.kickstart === 0 ? { version: "1.1.0" } : { version: "1.2.0" }),
    restart: () => Promise.reject(new Error("connection reset")),
  })
  assert.deepEqual(await upgrade({ pluginRoot: plugin("1.2.0"), now: false, p, deps: refused.deps }), { ok: true, from: "1.1.0", to: "1.2.0" })
  assert.deepEqual(refused.calls.restart, [{ now: false }])
  assert.equal(refused.calls.kickstart, 1)
  assert.deepEqual(readReleaseState(p), { current: "1.2.0", previous: "1.1.0", held: null })
})

test("upgrade: a second upgrade while one holds the lock exits without work", async () => {
  const { p } = scratch()
  installNode(p, NODE)
  release(p, "1.0.0", NODE)
  switchTo(p, "1.0.0")
  let letBoot: (ok: boolean) => void = () => {}
  const first = fakeDeps({
    boots: () => new Promise<boolean>((r) => (letBoot = r)),
    health: (c) => (c.restart.length === 0 ? { version: "1.0.0" } : { version: "1.1.0" }),
  })
  const a = upgrade({ pluginRoot: plugin("1.1.0"), now: false, p, deps: first.deps })
  assert.ok(await until(() => first.calls.bootCheck.length === 1), "the first upgrade is at its boot check")
  const lock = JSON.parse(readFileSync(p.upgradeLock, "utf8")) as { pid: number; time: string }
  assert.equal(lock.pid, process.pid)
  assert.equal(new Date(lock.time).toISOString(), lock.time)
  assert.equal(lockHeld(p), true)

  const second = fakeDeps({ health: () => ({ version: "1.0.0" }) })
  const b = await upgrade({ pluginRoot: plugin("1.2.0"), now: true, p, deps: second.deps })
  assert.deepEqual(b, { ok: false, from: "1.0.0", to: "1.2.0", reason: "another upgrade is running" })
  assert.deepEqual(second.calls, noCalls(), "no service call")
  assert.equal(existsSync(path.join(p.releasesDir, "1.2.0")), false, "no snapshot")
  assert.equal(existsSync(p.lastUpgrade), false, "nothing recorded")
  assert.equal(readFileSync(p.upgradeLock, "utf8"), JSON.stringify(lock) + "\n", "the first upgrade still holds the lock")

  letBoot(true)
  assert.deepEqual(await a, { ok: true, from: "1.0.0", to: "1.1.0" })
  assert.equal(existsSync(p.upgradeLock), false)
  assert.equal(lockHeld(p), false)

  // A live process of someone else's holds it too.
  writeFileSync(p.upgradeLock, JSON.stringify({ pid: process.ppid, time: new Date().toISOString() }))
  const third = fakeDeps({ health: () => ({ version: "1.1.0" }) })
  assert.equal((await upgrade({ pluginRoot: plugin("1.2.0"), now: false, p, deps: third.deps })).reason, "another upgrade is running")
  assert.deepEqual(third.calls, noCalls())
  assert.equal((JSON.parse(readFileSync(p.upgradeLock, "utf8")) as { pid: number }).pid, process.ppid, "left as it was")

  // A lock whose holder is gone is stale: the next upgrade takes it over.
  const dead = spawnSync(process.execPath, ["-e", ""]).pid
  writeFileSync(p.upgradeLock, JSON.stringify({ pid: dead, time: new Date().toISOString() }))
  assert.equal(lockHeld(p), false)
  const fourth = fakeDeps({ health: (c) => (c.restart.length === 0 ? { version: "1.1.0" } : { version: "1.2.0" }) })
  assert.deepEqual(await upgrade({ pluginRoot: plugin("1.2.0"), now: false, p, deps: fourth.deps }), { ok: true, from: "1.1.0", to: "1.2.0" })
  assert.equal(existsSync(p.upgradeLock), false)
})

test("upgrade: a lock older than an hour is stale even when its pid is alive", async () => {
  const { p } = scratch()
  installNode(p, NODE)
  release(p, "1.0.0", NODE)
  switchTo(p, "1.0.0")
  const lockAged = (ms: number) => writeFileSync(p.upgradeLock, JSON.stringify({ pid: process.ppid, time: new Date(Date.now() - ms).toISOString() }))

  // 59 minutes: a live upgrade (one renews its lock every minute it runs).
  lockAged(59 * 60_000)
  assert.equal(lockHeld(p), true)
  const early = fakeDeps({ health: () => ({ version: "1.0.0" }) })
  assert.equal((await upgrade({ pluginRoot: plugin("1.1.0"), now: false, p, deps: early.deps })).reason, "another upgrade is running")

  // 61 minutes: the pid is alive, but it is some other process now (a crash, then pid reuse).
  lockAged(61 * 60_000)
  assert.equal(lockHeld(p), false)
  const late = fakeDeps({ health: (c) => (c.restart.length === 0 ? { version: "1.0.0" } : { version: "1.1.0" }) })
  assert.deepEqual(await upgrade({ pluginRoot: plugin("1.1.0"), now: false, p, deps: late.deps }), { ok: true, from: "1.0.0", to: "1.1.0" })
  assert.equal(existsSync(p.upgradeLock), false)
})

// --- rollback -------------------------------------------------------------

test("rollback: steps back one build and holds that version", async () => {
  const { p } = scratch()
  installNode(p, NODE)
  release(p, "1.0.0", NODE)
  release(p, "1.1.0", NODE)
  switchTo(p, "1.0.0")
  switchTo(p, "1.1.0")
  const { deps, calls } = fakeDeps({ health: () => ({ version: "1.1.0" }) })

  assert.deepEqual(await rollback(p, deps), { to: "1.0.0" })
  assert.deepEqual(readReleaseState(p), { current: "1.0.0", previous: "1.1.0", held: "1.1.0" })
  assert.equal(readlinkSync(p.currentRelease), path.join(p.releasesDir, "1.0.0"))
  assert.deepEqual(calls.restart, [{ now: false }], "a patient restart, like an upgrade's")
  assert.equal(calls.kickstart, 0)
  assert.equal(existsSync(p.upgradeLock), false)

  // With the service down, it is kickstarted instead.
  const { p: d } = scratch()
  installNode(d, NODE)
  release(d, "1.0.0", NODE)
  release(d, "1.1.0", NODE)
  switchTo(d, "1.0.0")
  switchTo(d, "1.1.0")
  const down = fakeDeps({ health: () => null })
  assert.deepEqual(await rollback(d, down.deps), { to: "1.0.0" })
  assert.deepEqual(readReleaseState(d), { current: "1.0.0", previous: "1.1.0", held: "1.1.0" })
  assert.deepEqual(down.calls.restart, [])
  assert.equal(down.calls.kickstart, 1)

  // While an upgrade runs, it waits its turn.
  writeFileSync(p.upgradeLock, JSON.stringify({ pid: process.ppid, time: new Date().toISOString() }))
  const before = readFileSync(p.releaseState, "utf8")
  await assert.rejects(rollback(p, deps), /upgrade is running/)
  assert.equal(readFileSync(p.releaseState, "utf8"), before)

  // With no previous release, it says so and changes nothing.
  const { p: q } = scratch()
  installNode(q, NODE)
  release(q, "1.0.0", NODE)
  switchTo(q, "1.0.0")
  const only = readFileSync(q.releaseState, "utf8")
  const none = fakeDeps({ health: () => ({ version: "1.0.0" }) })
  await assert.rejects(rollback(q, none.deps), /no previous release/)
  assert.equal(readFileSync(q.releaseState, "utf8"), only)
  assert.deepEqual(none.calls, noCalls())
  assert.equal(existsSync(q.upgradeLock), false)
})

test("rollback: never moves onto a build that was reverted", async () => {
  const { p } = scratch()
  installNode(p, NODE)
  release(p, "1.0.0", NODE)
  release(p, "1.1.0", NODE)
  switchTo(p, "1.0.0")
  switchTo(p, "1.1.0")
  const { deps, calls } = fakeDeps({ health: () => ({ version: "1.0.0" }) })
  assert.deepEqual(await rollback(p, deps), { to: "1.0.0" })
  // Previous is now the build just left, and it is held: a second rollback would only undo the first.
  const before = readFileSync(p.releaseState, "utf8")
  calls.restart.length = 0
  await assert.rejects(rollback(p, deps), /previous release 1\.1\.0 was reverted/)
  assert.equal(readFileSync(p.releaseState, "utf8"), before)
  assert.equal(readlinkSync(p.currentRelease), path.join(p.releasesDir, "1.0.0"))
  assert.deepEqual(calls.restart, [])
  assert.equal(existsSync(p.upgradeLock), false)

  // The same after the daemon's crash-loop guard reverted 1.1.0.
  const { p: g } = scratch()
  installNode(g, NODE)
  release(g, "1.0.0", NODE)
  release(g, "1.1.0", NODE)
  switchTo(g, "1.1.0")
  switchTo(g, "1.0.0", { hold: true })
  await assert.rejects(rollback(g, deps), /previous release 1\.1\.0 was reverted/)
  assert.deepEqual(readReleaseState(g), { current: "1.0.0", previous: "1.1.0", held: "1.1.0" })
})

// --- snapshot links -------------------------------------------------------

test("snapshot: refuses a plugin copy with symlinks, naming the link", () => {
  const cases: [string, (root: string, outside: string) => void][] = [
    ["src/engine/extra.js", (root, outside) => {
      // Relative, and out of the plugin copy: a copy would carry it dangling, or as an absolute link back.
      writeFileSync(path.join(outside, "extra.js"), "")
      symlinkSync(path.relative(path.join(root, "src", "engine"), path.join(outside, "extra.js")), path.join(root, "src", "engine", "extra.js"))
    }],
    ["bin/beacons", (root, outside) => {
      renameSync(path.join(root, "bin", "beacons"), path.join(outside, "beacons"))
      symlinkSync(path.join(outside, "beacons"), path.join(root, "bin", "beacons"))
    }],
    ["src", (root, outside) => {
      renameSync(path.join(root, "src"), path.join(outside, "src"))
      symlinkSync(path.join(outside, "src"), path.join(root, "src"))
    }],
    ["bin", (root, outside) => {
      renameSync(path.join(root, "bin"), path.join(outside, "bin"))
      symlinkSync(path.join(outside, "bin"), path.join(root, "bin"))
    }],
    [".claude-plugin/plugin.json", (root, outside) => {
      renameSync(path.join(root, ".claude-plugin", "plugin.json"), path.join(outside, "plugin.json"))
      symlinkSync(path.join(outside, "plugin.json"), path.join(root, ".claude-plugin", "plugin.json"))
    }],
    [".claude-plugin", (root, outside) => {
      renameSync(path.join(root, ".claude-plugin"), path.join(outside, ".claude-plugin"))
      symlinkSync(path.join(outside, ".claude-plugin"), path.join(root, ".claude-plugin"))
    }],
  ]
  for (const [link, make] of cases) {
    const { dir, p } = scratch()
    const root = plugin("3.0.0")
    make(root, dir)
    assert.throws(
      () => snapshot(root, p),
      (err: Error) => err.message.includes(path.join(root, link)) && /symbolic link/.test(err.message),
      link,
    )
    assert.deepEqual(existsSync(p.releasesDir) ? readdirSync(p.releasesDir) : [], [], `${link}: nothing is left in releases/`)
  }
})

// --- the default boot check -----------------------------------------------

test("bootCheck: a snapshot of this repo boots on its own Node, away from the real data", async () => {
  const { env, p } = scratch()
  const rel = snapshot(REPO, p)
  linkThisNode(p, rel.node)
  // This process's own HOME and XDG dirs are the scratch ones, as the service's are the real
  // ones: a check that passed them on would leave a boot count and an accounts file here.
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME }
  Object.assign(process.env, env)
  try {
    assert.equal(await bootCheck(rel.dir, p), true)
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  assert.equal(existsSync(p.configDir), false, "no accounts or gateway file here")
  assert.deepEqual(readdirSync(p.dataDir).sort(), ["node", "releases"], "no boot count, no logs")
  assert.deepEqual(readdirSync(p.releasesDir), [rel.version])
})

test("bootCheck: a build that fails at load, or never listens, is refused with why, and its process is killed", async () => {
  const { dir, p } = scratch()
  linkThisNode(p, NODE)
  // The reason carries the child's last stderr lines, without the stack frames.
  const broken = codeRelease(p, "1.0.0", 'throw new Error("broken at load")\n')
  await assert.rejects(bootCheck(broken, p), (err: Error) => {
    assert.match(err.message, /^exited 1 before answering: .*Error: broken at load/s)
    assert.doesNotMatch(err.message, /\n|^\s*at /m)
    return true
  })

  // Only the tail, about 500 characters, and never a token.
  const token = "sk-ant-ort01-" + "a1B2c3D4".repeat(10)
  // exitCode, not process.exit(): exit can drop stderr writes still pending on a pipe, and the test reads the last ones.
  const noisy = codeRelease(
    p,
    "1.0.1",
    `for (let i = 0; i < 200; i++) process.stderr.write("line " + i + " of noise\\n")\n` +
      `process.stderr.write("beacons: refresh failed for ${token}: Bearer ${token}\\n")\nprocess.exitCode = 3\n`,
  )
  await assert.rejects(bootCheck(noisy, p), (err: Error) => {
    assert.match(err.message, /^exited 3 before answering: /)
    assert.ok(err.message.length < 600, `${err.message.length} characters`)
    assert.match(err.message, /line 199 of noise/)
    assert.doesNotMatch(err.message, /line 0 of noise/)
    assert.ok(!err.message.includes("a1B2c3D4"), err.message)
    assert.match(err.message, /refresh failed for sk-ant-…/)
    return true
  })

  const pidFile = path.join(dir, "pid")
  const silent = codeRelease(
    p,
    "1.1.0",
    `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetInterval(() => {}, 1000)\n`,
  )
  const t0 = Date.now()
  await assert.rejects(bootCheck(silent, p, { timeoutMs: 1500 }), { message: "no answer within 1.5 s" })
  assert.ok(Date.now() - t0 < 5000, "the check gives up at its limit")
  const pid = Number(readFileSync(pidFile, "utf8"))
  assert.ok(pid > 0)
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the child is gone")

  // A release whose Node is not installed, or with no release.json, did not boot either.
  await assert.rejects(bootCheck(codeRelease(p, "1.2.0", "", "99.0.0"), p), /Node 99\.0\.0 .*not installed/)
  await assert.rejects(bootCheck(path.join(p.releasesDir, "nothing"), p), /release\.json/)
})
