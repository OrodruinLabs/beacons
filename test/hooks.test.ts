// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The plugin's hooks. `sessionStartHook` runs against a scratch data dir with
// every service call a fake (HookDeps). The sh hooks run as `sh hooks/<name>`
// with a scratch HOME and XDG dirs and a fake release bootstrap that records
// what it was given.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import http from "node:http"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { writeRoutes } from "../src/config.ts"
import { beaconsPaths } from "../src/paths.ts"
import type { Paths } from "../src/paths.ts"
import { sessionStartHook, spawnUpgrade } from "../src/hook.ts"
import { daemonHealth } from "../src/loopback.ts"
import type { HookDeps } from "../src/hook.ts"

const REPO = fileURLToPath(new URL("..", import.meta.url))
const NOT_ANSWERING = "beacons is not answering; run `! beacons off` to go direct"
const RESTARTING = "beacons is restarting for an update"
const NUDGE = /installed but not set up/

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const until = async (pred: () => boolean, ms = 5000) => {
  const t = Date.now() + ms
  while (!pred() && Date.now() < t) await sleep(20)
  return pred()
}

type Env = Record<string, string>

function scratch(): { dir: string; env: Env; p: Paths } {
  const dir = mkdtempSync(path.join(tmpdir(), "beacons-"))
  const env: Env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, "config"), XDG_DATA_HOME: path.join(dir, "data"), PATH: process.env.PATH ?? "/usr/bin:/bin" }
  return { dir, env, p: beaconsPaths(env) }
}

/** A routed profile folder, recorded in routes.json as setup records it. */
function routed(s: { dir: string; p: Paths }, name = "profile"): string {
  const profile = path.join(s.dir, name)
  mkdirSync(profile, { recursive: true })
  writeRoutes(s.p, {
    version: 1,
    profiles: {
      [profile]: { mode: "pool", account: "a@b.com", wrote: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4774/pool/a%40b.com" }, replaced: null, replacedKind: null, statusLine: null, plugin: true },
    },
  })
  return profile
}

function plugin(version: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "beacons-plugin-"))
  mkdirSync(path.join(root, ".claude-plugin"))
  writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "beacons", version }))
  return root
}

function releaseState(p: Paths, s: { current: string | null; previous?: string | null; held?: string | null }): void {
  mkdirSync(p.releasesDir, { recursive: true })
  writeFileSync(p.releaseState, JSON.stringify({ current: s.current, previous: s.previous ?? null, held: s.held ?? null }))
}

/**
 * Recording fakes. `health` answers from `answers` in turn (the last one
 * repeats); "hang" never settles. `sleep` is instant unless `realSleep`.
 */
function fakes(o: { answers?: ("up" | "down" | "hang" | "throw")[]; afterStart?: ("up" | "down" | "hang")[]; lock?: boolean; startFails?: boolean; realSleep?: boolean; version?: string } = {}) {
  const calls = { health: 0, started: 0, spawned: [] as string[], sleeps: [] as number[] }
  let queue = [...(o.answers ?? ["up"])]
  const deps: HookDeps = {
    health() {
      calls.health++
      const a = queue.length > 1 ? queue.shift()! : queue[0]
      if (a === "hang") return new Promise(() => {})
      if (a === "throw") return Promise.reject(new Error("boom"))
      return Promise.resolve(a === "up" ? { version: o.version ?? "0.1.0" } : null)
    },
    async ensureStarted() {
      calls.started++
      if (o.startFails) throw new Error("no such service")
      if (o.afterStart) queue = [...o.afterStart]
    },
    spawnUpgrade(root) {
      calls.spawned.push(root)
    },
    async sleep(ms) {
      calls.sleeps.push(ms)
      if (o.realSleep) await sleep(ms)
    },
    lockHeld: () => o.lock ?? false,
  }
  return { deps, calls }
}

// --- sessionStartHook ------------------------------------------------------

test("hook: an unrouted profile says nothing and asks nothing", async () => {
  const s = scratch()
  routed(s, "other")
  releaseState(s.p, { current: "0.1.0" })
  const { deps, calls } = fakes({ answers: ["down"] })
  const r = await sessionStartHook({ pluginRoot: plugin("0.2.0"), profile: path.join(s.dir, "unrouted"), p: s.p, deps })
  assert.deepEqual(r, {})
  assert.deepEqual(calls, { health: 0, started: 0, spawned: [], sleeps: [] })
  // No routes.json at all: the same.
  const bare = scratch()
  assert.deepEqual(await sessionStartHook({ pluginRoot: plugin("0.2.0"), profile: path.join(bare.dir, "p"), p: bare.p, deps }), {})
})

test("hook: a daemon that answers on the current build says nothing", async () => {
  const s = scratch()
  const profile = routed(s)
  releaseState(s.p, { current: "0.1.0" })
  const { deps, calls } = fakes()
  // The profile as routes.json names it: a trailing slash is the same folder.
  assert.deepEqual(await sessionStartHook({ pluginRoot: plugin("0.1.0"), profile: profile + "/", p: s.p, deps }), {})
  assert.equal(calls.health, 1)
  assert.equal(calls.started, 0)
  assert.deepEqual(calls.spawned, [])
})

test("hook: a hung daemon does not hold the session start", async () => {
  const s = scratch()
  const profile = routed(s)
  releaseState(s.p, { current: "0.1.0" })
  const { deps, calls } = fakes({ answers: ["hang"], realSleep: true })
  const t0 = Date.now()
  const r = await sessionStartHook({ pluginRoot: plugin("0.1.0"), profile, p: s.p, deps })
  const ms = Date.now() - t0
  assert.deepEqual(r, { systemMessage: NOT_ANSWERING })
  assert.ok(ms < 4000, `took ${ms} ms`)
  assert.equal(calls.started, 1)
  assert.ok(calls.health >= 2, `asked ${calls.health} times`)
  assert.ok(calls.sleeps.every((x) => x === 250))
})

test("hook: a stopped daemon is started and waited for", async () => {
  const s = scratch()
  const profile = routed(s)
  releaseState(s.p, { current: "0.1.0" })
  const { deps, calls } = fakes({ answers: ["down"], afterStart:["down", "down", "up"] })
  assert.deepEqual(await sessionStartHook({ pluginRoot: plugin("0.1.0"), profile, p: s.p, deps }), {})
  assert.equal(calls.started, 1)
  assert.equal(calls.health, 4)
  assert.deepEqual(calls.sleeps, [250, 250, 250])

  // A health call that throws counts as down; one that never comes back after 3 s of waiting is reported.
  const gone = fakes({ answers: ["throw"], afterStart:["down"] })
  assert.deepEqual(await sessionStartHook({ pluginRoot: plugin("0.1.0"), profile, p: s.p, deps: gone.deps }), { systemMessage: NOT_ANSWERING })
  assert.equal(gone.calls.started, 1)
  assert.equal(gone.calls.sleeps.reduce((a, b) => a + b, 0), 3000)
})

test("hook: a start that fails is not waited on", async () => {
  const s = scratch()
  const profile = routed(s)
  releaseState(s.p, { current: "0.1.0" })
  const { deps, calls } = fakes({ answers: ["down"], startFails: true })
  assert.deepEqual(await sessionStartHook({ pluginRoot: plugin("0.1.0"), profile, p: s.p, deps }), { systemMessage: NOT_ANSWERING })
  assert.equal(calls.started, 1)
  assert.equal(calls.health, 1)
  assert.deepEqual(calls.sleeps, [])
})

test("hook: an upgrade in progress waits instead of starting the service", async () => {
  const s = scratch()
  const profile = routed(s)
  releaseState(s.p, { current: "0.1.0" })
  // Back within the wait.
  const back = fakes({ answers: ["down", "down", "up"], lock: true, version: "0.2.0" })
  assert.deepEqual(await sessionStartHook({ pluginRoot: plugin("0.2.0"), profile, p: s.p, deps: back.deps }), { systemMessage: RESTARTING })
  assert.equal(back.calls.started, 0)
  assert.equal(back.calls.health, 3)
  // Not back after 3 s: still the update, never the not-answering advice, and no second upgrade.
  const slow = fakes({ answers: ["down"], lock: true })
  assert.deepEqual(await sessionStartHook({ pluginRoot: plugin("0.2.0"), profile, p: s.p, deps: slow.deps }), { systemMessage: RESTARTING })
  assert.equal(slow.calls.started, 0)
  assert.equal(slow.calls.sleeps.reduce((a, b) => a + b, 0), 3000)
  assert.deepEqual(slow.calls.spawned, [])
  // Hung while the lock is held: inside the time limit too.
  const hung = fakes({ answers: ["hang"], lock: true, realSleep: true })
  const t0 = Date.now()
  assert.deepEqual(await sessionStartHook({ pluginRoot: plugin("0.1.0"), profile, p: s.p, deps: hung.deps }), { systemMessage: RESTARTING })
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`)
  assert.equal(hung.calls.started, 0)
})

test("hook: a newer plugin starts a detached upgrade, a held version does not", async () => {
  const s = scratch()
  const profile = routed(s)
  const cases: [plugin: string, state: { current: string | null; held?: string | null }, spawns: boolean][] = [
    ["0.2.0", { current: "0.1.0" }, true],
    ["0.10.0", { current: "0.9.0" }, true], // numeric, not string, order
    ["1.0.0", { current: "0.99.99" }, true],
    ["0.1.1", { current: "0.1.0", held: "0.1.0" }, true], // the held one is an older build
    ["0.2.0", { current: "0.1.0", held: "0.2.0" }, false],
    ["0.1.0", { current: "0.1.0" }, false],
    ["0.1.0", { current: "0.2.0" }, false], // older: never a downgrade
    ["0.2.0", { current: null }, false], // no release yet: setup makes the first
    // Semver precedence: a prerelease sorts below its release; build metadata is ignored.
    ["1.0.0-rc.1", { current: "1.0.0" }, false],
    ["1.0.0", { current: "1.0.0-rc.1" }, true],
    ["1.0.0-rc.2", { current: "1.0.0-rc.1" }, true],
    ["1.0.0-rc.1", { current: "1.0.0-rc.2" }, false],
    ["1.0.0-rc.10", { current: "1.0.0-rc.9" }, true], // numeric identifiers by number
    ["1.0.0-beta", { current: "1.0.0-alpha" }, true], // others in ASCII order
    ["1.0.0-alpha.1", { current: "1.0.0-alpha" }, true], // more identifiers, all else equal
    ["1.0.0-alpha.beta", { current: "1.0.0-alpha.1" }, true], // numeric below alphanumeric
    ["1.0.0-rc.1", { current: "0.9.0" }, true],
    ["1.0.0+a", { current: "1.0.0+b" }, false],
    ["1.0.0+b", { current: "1.0.0+a" }, false],
    ["1.0.0-rc.1+b", { current: "1.0.0-rc.1+a" }, false],
    ["1.0.1+a", { current: "1.0.0+b" }, true],
  ]
  for (const [version, state, spawns] of cases) {
    releaseState(s.p, state)
    const root = plugin(version)
    const { deps, calls } = fakes()
    assert.deepEqual(await sessionStartHook({ pluginRoot: root, profile, p: s.p, deps }), {}, `${version} over ${JSON.stringify(state)}`)
    assert.deepEqual(calls.spawned, spawns ? [root] : [], `${version} over ${JSON.stringify(state)}`)
  }
  // A plugin copy with no version, or a state file that cannot be read: nothing started, nothing said.
  releaseState(s.p, { current: "0.1.0" })
  const none = fakes()
  assert.deepEqual(await sessionStartHook({ pluginRoot: mkdtempSync(path.join(tmpdir(), "beacons-plugin-")), profile, p: s.p, deps: none.deps }), {})
  writeFileSync(s.p.releaseState, "{")
  assert.deepEqual(await sessionStartHook({ pluginRoot: plugin("0.2.0"), profile, p: s.p, deps: none.deps }), {})
  assert.deepEqual(none.calls.spawned, [])
})

test("hook: a failed upgrade is reported once", async () => {
  const s = scratch()
  const profile = routed(s)
  releaseState(s.p, { current: "0.1.0", held: "0.2.0" })
  const rec = { ok: false, from: "0.1.0", to: "0.2.0", reason: "release 0.2.0 did not boot: exited 1 before answering; nothing was switched; 0.2.0 is held", at: "2026-11-05T10:00:00.000Z", shown: false }
  writeFileSync(s.p.lastUpgrade, JSON.stringify(rec))
  const { deps } = fakes()
  const r = await sessionStartHook({ pluginRoot: plugin("0.2.0"), profile, p: s.p, deps })
  assert.equal(r.systemMessage, `beacons could not upgrade to 0.2.0: ${rec.reason}`)
  assert.deepEqual(JSON.parse(readFileSync(s.p.lastUpgrade, "utf8")), { ...rec, shown: true })
  assert.deepEqual(await sessionStartHook({ pluginRoot: plugin("0.2.0"), profile, p: s.p, deps }), {})
  // A success is never reported.
  writeFileSync(s.p.lastUpgrade, JSON.stringify({ ok: true, from: "0.1.0", to: "0.2.0", at: rec.at, shown: false }))
  assert.deepEqual(await sessionStartHook({ pluginRoot: plugin("0.2.0"), profile, p: s.p, deps }), {})
})

test("hook: several things to say come one per line", async () => {
  const s = scratch()
  const profile = routed(s)
  releaseState(s.p, { current: "0.1.0" })
  writeFileSync(s.p.lastUpgrade, JSON.stringify({ ok: false, from: "0.0.9", to: "0.1.0", reason: "the new build did not stay up", shown: false }))
  const { deps } = fakes({ answers: ["down"], lock: true })
  const r = await sessionStartHook({ pluginRoot: plugin("0.1.0"), profile, p: s.p, deps })
  assert.equal(r.systemMessage, `${RESTARTING}\nbeacons could not upgrade to 0.1.0: the new build did not stay up`)
})

test("hook: daemonHealth times out on a daemon that never answers", async () => {
  const sockets: net.Socket[] = []
  const hung = net.createServer((sock) => {
    sockets.push(sock)
    sock.resume()
  })
  await new Promise<void>((r) => hung.listen(0, "127.0.0.1", r))
  const ok = http.createServer((req, res) => {
    res.writeHead(req.url === "/beacons/v1/health" ? 200 : 404, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true, version: "0.3.0" }))
  })
  await new Promise<void>((r) => ok.listen(0, "127.0.0.1", r))
  try {
    const t0 = Date.now()
    assert.equal(await daemonHealth((hung.address() as net.AddressInfo).port, 300), null)
    assert.ok(Date.now() - t0 < 1000)
    assert.deepEqual(await daemonHealth((ok.address() as net.AddressInfo).port), { version: "0.3.0" })
  } finally {
    for (const sock of sockets) sock.destroy()
    await new Promise<void>((r) => hung.close(() => r()))
    await new Promise<void>((r) => ok.close(() => r()))
  }
})

test("hook: spawnUpgrade runs the plugin copy's own bootstrap, detached", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "beacons-plugin-"))
  const marker = path.join(root, "ran")
  mkdirSync(path.join(root, "bin"))
  // Slow on purpose: spawnUpgrade must not wait for it.
  writeFileSync(path.join(root, "bin", "beacons"), `#!/bin/sh\nsleep 1\nprintf '%s\\n' "$*" > '${marker}.tmp' && mv '${marker}.tmp' '${marker}'\n`)
  const t0 = Date.now()
  spawnUpgrade(root)
  assert.ok(Date.now() - t0 < 500)
  assert.equal(existsSync(marker), false)
  assert.ok(await until(() => existsSync(marker)), "the upgrade never ran")
  assert.equal(readFileSync(marker, "utf8"), "upgrade\n")
})

// --- hooks/session-start ---------------------------------------------------

const sh = (script: string, env: Env, input = "") => spawnSync("sh", [path.join(REPO, "hooks", script)], { env, input, encoding: "utf8", timeout: 20_000 })

test("session-start: with no release it nudges setup", () => {
  const s = scratch()
  const r = sh("session-start", s.env, JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart", source: "startup" }))
  assert.equal(r.status, 0, r.stderr)
  assert.match(JSON.parse(r.stdout).systemMessage, NUDGE)
  // A release folder without its release.json is not set up either.
  mkdirSync(path.join(s.p.releasesDir, "0.1.0", "bin"), { recursive: true })
  symlinkSync(path.join(s.p.releasesDir, "0.1.0"), s.p.currentRelease)
  assert.match(JSON.parse(sh("session-start", s.env).stdout).systemMessage, NUDGE)
})

test("session-start: with a release it hands the hook to that release's bootstrap", () => {
  const s = scratch()
  const dir = path.join(s.p.releasesDir, "0.1.0")
  mkdirSync(path.join(dir, "bin"), { recursive: true })
  writeFileSync(path.join(dir, "release.json"), JSON.stringify({ version: "0.1.0", node: "26.13.0" }))
  writeFileSync(path.join(dir, "bin", "beacons"), `#!/bin/sh\nprintf 'args=%s\\n' "$*"\nprintf 'root=%s\\n' "\${CLAUDE_PLUGIN_ROOT:-}"\nprintf 'stdin=%s\\n' "$(cat)"\n`)
  symlinkSync(dir, s.p.currentRelease)
  const input = JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart", source: "startup" })
  const r = sh("session-start", { ...s.env, CLAUDE_PLUGIN_ROOT: "/plugins/cache/beacons/0.2.0" }, input)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.stdout.split("\n"), ["args=hook session-start", "root=/plugins/cache/beacons/0.2.0", `stdin=${input}`, ""])
})

test("session-start: a relative XDG_DATA_HOME is ignored, as src/paths.ts ignores it", () => {
  const s = scratch()
  // The release where paths.ts looks once the relative value is ignored: under ~/.local/share.
  const p = beaconsPaths({ HOME: s.dir, XDG_DATA_HOME: "data" })
  assert.equal(p.dataDir, path.join(s.dir, ".local", "share", "beacons"))
  const dir = path.join(p.releasesDir, "0.1.0")
  mkdirSync(path.join(dir, "bin"), { recursive: true })
  writeFileSync(path.join(dir, "release.json"), JSON.stringify({ version: "0.1.0", node: "26.13.0" }))
  writeFileSync(path.join(dir, "bin", "beacons"), `#!/bin/sh\nprintf 'args=%s\\n' "$*"\n`)
  symlinkSync(dir, p.currentRelease)
  const r = sh("session-start", { ...s.env, XDG_DATA_HOME: "data" }, "{}")
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, "args=hook session-start\n")
})
