// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// uninstall against a scratch HOME. The Run is a fake: no test runs the real claude, launchctl or systemctl.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { beaconsPaths } from "../src/paths.ts"
import type { Paths } from "../src/paths.ts"
import { writeRoutes, type RoutesFile } from "../src/config.ts"
import { uninstall } from "../src/uninstall.ts"
import type { Run } from "../src/service.ts"
import type { SessionEntry } from "../src/sessions.ts"

const URL_A = "http://127.0.0.1:4774/pool/work"

function scratch(): { p: Paths; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), "beacons-"))
  const p = beaconsPaths({ HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data") })
  mkdirSync(p.configDir, { recursive: true })
  mkdirSync(path.join(p.dataDir, "releases"), { recursive: true })
  writeFileSync(p.accountsFile, "{}")
  return { p, root }
}

function profile(root: string, name: string, env: Record<string, string>, extra: Record<string, unknown> = {}): string {
  const dir = path.join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ env, ...extra }))
  return dir
}

function record(over: Record<string, unknown> = {}) {
  const routes = { version: 1 as const, profiles: { x: { mode: "pool", account: "work", wrote: { ANTHROPIC_BASE_URL: URL_A }, replaced: null, replacedKind: null, statusLine: null, plugin: true, ...over } } }
  return routes.profiles.x as RoutesFile["profiles"][string]
}

function add(p: Paths, routes: RoutesFile, dir: string, over: Record<string, unknown> = {}) {
  routes.profiles[dir] = record(over)
  writeRoutes(p, routes)
}

function fakes(events: string[] = [], over: Partial<Parameters<typeof uninstall>[0]["deps"]> = {}, sessions: SessionEntry[] = []) {
  const calls: [string, string[]][] = []
  const run: Run = async (cmd, args) => {
    calls.push([cmd, args])
    events.push(`run:${cmd} ${args.join(" ")}`)
    return { code: 0, stdout: "", stderr: "" }
  }
  const deps = {
    run,
    openSessions: async () => { events.push("sessions"); return sessions },
    proxyUp: async () => true,
    health: async () => null,
    platform: "darwin" as NodeJS.Platform,
    healthBudgetMs: 50,
    ...over,
  }
  return { deps, calls }
}

const settings = (dir: string) => JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"))

test("uninstall: without purge accounts.json survives, with purge it goes", async () => {
  const { p, root } = scratch()
  const dir = profile(root, "prof", { ANTHROPIC_BASE_URL: URL_A })
  add(p, { version: 1, profiles: {} }, dir)
  const { deps } = fakes()
  const r = await uninstall({ purge: false, p, deps })
  assert.ok(existsSync(p.accountsFile))
  assert.ok(!existsSync(p.dataDir))
  assert.equal(settings(dir).env, undefined)
  assert.deepEqual(r.sessionsToRestart, [])
  const q = scratch()
  await uninstall({ purge: true, p: q.p, deps: fakes().deps })
  assert.ok(!existsSync(q.p.configDir))
  assert.ok(!existsSync(q.p.dataDir))
})

test("uninstall: a value changed after setup is left in place and reported", async () => {
  const { p, root } = scratch()
  const dir = profile(root, "prof", { ANTHROPIC_BASE_URL: "http://example.invalid/x" })
  add(p, { version: 1, profiles: {} }, dir)
  const r = await uninstall({ purge: false, p, deps: fakes().deps })
  assert.equal(settings(dir).env.ANTHROPIC_BASE_URL, "http://example.invalid/x")
  assert.ok(r.notes.some((n) => n.includes("changed after setup")))
})

test("uninstall: a vanished profile is skipped with a note", async () => {
  const { p, root } = scratch()
  const dir = path.join(root, "gone")
  add(p, { version: 1, profiles: {} }, dir)
  const { deps, calls } = fakes()
  const r = await uninstall({ purge: false, p, deps })
  assert.ok(r.notes.some((n) => n.includes("no longer exists")))
  assert.ok(!calls.some(([, a]) => a.includes("plugin")))
})

test("uninstall: sessions are listed before the service stops, and the plugin goes after it", async () => {
  const { p, root } = scratch()
  const dir = profile(root, "prof", { ANTHROPIC_BASE_URL: URL_A })
  add(p, { version: 1, profiles: {} }, dir)
  const events: string[] = []
  const s: SessionEntry[] = [{ id: "abc12345", account: "work", mode: "pool", first: null, lastSeen: 1 }]
  const { deps } = fakes(events, {}, s)
  const r = await uninstall({ purge: false, p, deps })
  assert.deepEqual(r.sessionsToRestart, ["abc12345"])
  const iSess = events.indexOf("sessions")
  const iStop = events.findIndex((e) => e.startsWith("run:launchctl bootout"))
  const iPlug = events.findIndex((e) => e.includes("plugin uninstall beacons@beacons"))
  assert.ok(iSess >= 0 && iSess < iStop && iStop < iPlug)
  assert.ok(events.some((e) => e.includes(`CLAUDE_CONFIG_DIR=${dir}`)))
  assert.ok(r.notes.some((n) => n.includes("restart")))
})

test("uninstall: the recorded profiles are read before unroute drops them, so the plugin still goes", async () => {
  const { p, root } = scratch()
  const dir = profile(root, "prof", { ANTHROPIC_BASE_URL: URL_A })
  add(p, { version: 1, profiles: {} }, dir)
  const { deps, calls } = fakes()
  await uninstall({ purge: false, p, deps })
  assert.equal(calls.filter(([, a]) => a.includes("plugin")).length, 1)
})

test("uninstall: the status line beacons wrote is removed too", async () => {
  const { p, root } = scratch()
  const line = { type: "command", command: "x status --line", refreshInterval: 30 }
  const dir = profile(root, "prof", { ANTHROPIC_BASE_URL: URL_A }, { statusLine: line })
  add(p, { version: 1, profiles: {} }, dir, { statusLine: line })
  await uninstall({ purge: false, p, deps: fakes().deps })
  assert.equal(settings(dir).statusLine, undefined)
})

test("uninstall: a profile parked by off still loses the status line and the plugin, and off is cleared", async () => {
  const { p, root } = scratch()
  const line = { type: "command", command: "x status --line", refreshInterval: 30 }
  // After `off`: the route key is gone, the status line stays, and the record is parked.
  const parked = profile(root, "parked", { KEEP: "1" }, { statusLine: line })
  const live = profile(root, "live", { ANTHROPIC_BASE_URL: URL_A })
  writeRoutes(p, { version: 1, profiles: { [live]: record() }, off: { [parked]: record({ statusLine: line }) } })
  const { deps, calls } = fakes()
  await uninstall({ purge: false, p, deps })
  assert.equal(settings(parked).statusLine, undefined)
  assert.deepEqual(settings(parked).env, { KEEP: "1" })
  assert.equal(settings(live).env, undefined)
  const plugins = calls.filter(([, a]) => a.includes("plugin")).map(([, a]) => a[0])
  assert.deepEqual(plugins.sort(), [`CLAUDE_CONFIG_DIR=${live}`, `CLAUDE_CONFIG_DIR=${parked}`].sort())
  const routes = JSON.parse(readFileSync(p.routesFile, "utf8"))
  assert.deepEqual(routes, { version: 1, profiles: {} })
})

test("uninstall: refuses while an upgrade holds the lock, changing nothing", async () => {
  const { p, root } = scratch()
  const dir = profile(root, "prof", { ANTHROPIC_BASE_URL: URL_A })
  add(p, { version: 1, profiles: {} }, dir)
  writeFileSync(p.upgradeLock, JSON.stringify({ pid: process.pid, at: Date.now() }))
  const { deps, calls } = fakes()
  await assert.rejects(uninstall({ purge: false, p, deps }), /upgrade is running/)
  assert.equal(calls.length, 0)
  assert.equal(settings(dir).env.ANTHROPIC_BASE_URL, URL_A)
  assert.ok(existsSync(p.dataDir))
})

test("uninstall: the launcher goes only when it links into beacons' data dir", async () => {
  const a = scratch()
  mkdirSync(path.dirname(a.p.launcher), { recursive: true })
  symlinkSync(path.join(a.p.currentRelease, "bin", "beacons"), a.p.launcher)
  await uninstall({ purge: false, p: a.p, deps: fakes().deps })
  assert.throws(() => lstatSync(a.p.launcher))

  const b = scratch()
  mkdirSync(path.dirname(b.p.launcher), { recursive: true })
  symlinkSync("/usr/bin/true", b.p.launcher)
  const r = await uninstall({ purge: false, p: b.p, deps: fakes().deps })
  assert.ok(lstatSync(b.p.launcher).isSymbolicLink())
  assert.ok(r.notes.some((n) => n.includes("left alone")))

  const c = scratch()
  mkdirSync(path.dirname(c.p.launcher), { recursive: true })
  writeFileSync(c.p.launcher, "#!/bin/sh\n")
  await uninstall({ purge: false, p: c.p, deps: fakes().deps })
  assert.ok(existsSync(c.p.launcher))
})

test("uninstall: a daemon that still answers after the service stops gets a note with the manual stop command", async () => {
  const { p } = scratch()
  const { deps } = fakes([], { health: async () => ({ version: "1" }) })
  const r = await uninstall({ purge: false, p, deps })
  assert.ok(r.notes.some((n) => n.includes("still answering") && n.includes("launchctl bootout")))
  const q = scratch()
  const s = await uninstall({ purge: false, p: q.p, deps: fakes([], { health: async () => ({ version: "1" }), platform: "linux" }).deps })
  assert.ok(s.notes.some((n) => n.includes("systemctl --user disable --now beacons.service")))
})

test("uninstall: a data dir not named beacons is kept, and so is a config dir under purge", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "beacons-"))
  const p = beaconsPaths({ HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data") })
  const odd: Paths = { ...p, dataDir: path.join(root, "data", "other"), configDir: path.join(root, "config", "other") }
  mkdirSync(path.join(odd.dataDir, "releases"), { recursive: true })
  mkdirSync(odd.configDir, { recursive: true })
  const r = await uninstall({ purge: true, p: odd, deps: fakes().deps })
  assert.ok(existsSync(odd.dataDir) && existsSync(odd.configDir))
  assert.equal(r.notes.filter((n) => n.includes("not an absolute folder named beacons")).length, 2)
})

test("uninstall: a profile that cannot be put back stops it before the service is touched", async () => {
  const { p, root } = scratch()
  const bad = path.join(root, "bad")
  mkdirSync(bad)
  writeFileSync(path.join(bad, "settings.json"), "{ not json")
  add(p, { version: 1, profiles: {} }, bad)
  const { deps, calls } = fakes()
  await assert.rejects(uninstall({ purge: false, p, deps }), /bad still routes to beacons.*run uninstall again/)
  assert.ok(!calls.some(([c]) => c === "launchctl" || c === "systemctl"))
  assert.ok(existsSync(p.dataDir))
})

test("uninstall: a data dir with no beacons marker survives, with a note", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "beacons-"))
  const p = beaconsPaths({ HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data") })
  mkdirSync(p.dataDir, { recursive: true })
  writeFileSync(path.join(p.dataDir, "mine.txt"), "x")
  const r = await uninstall({ purge: false, p, deps: fakes().deps })
  assert.ok(existsSync(p.dataDir))
  assert.ok(r.notes.some((n) => n.includes("holds nothing beacons made")))
})
