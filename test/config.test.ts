// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { beaconsPaths, type Paths } from "../src/paths.ts"
import { loadGatewayConfig, saveGatewayConfig, ensurePrivateDirs, readRoutes, writeRoutes } from "../src/config.ts"
import { route } from "../src/routes.ts"

function scratchPaths(): Paths {
  const home = mkdtempSync(path.join(tmpdir(), "beacons-"))
  return beaconsPaths({ HOME: home })
}

test("config: XDG dirs win over HOME defaults", () => {
  const p = beaconsPaths({ HOME: "/h", XDG_CONFIG_HOME: "/c", XDG_DATA_HOME: "/d" })
  assert.equal(p.accountsFile, "/c/beacons/accounts.json"); assert.equal(p.currentRelease, "/d/beacons/releases/current")
  assert.equal(beaconsPaths({ HOME: "/h" }).configDir, "/h/.config/beacons")
  assert.equal(p.currentNode, "/d/beacons/node/current"); assert.equal(p.launcher, "/h/.local/bin/beacons")
})
test("config: port 0 asks for a spare port; a negative or fractional one is refused", () => {
  const p = scratchPaths()
  mkdirSync(p.configDir, { recursive: true })
  writeFileSync(p.gatewayFile, JSON.stringify({ port: 0 }))
  assert.equal(loadGatewayConfig(p).port, 0)
  for (const port of [-1, 1.5, 65536, "4774"]) {
    writeFileSync(p.gatewayFile, JSON.stringify({ port }))
    assert.throws(() => loadGatewayConfig(p), /port/, String(port))
  }
})
test("config: unknown keys are dropped and a bad fallback is refused", () => {
  const p = scratchPaths()
  mkdirSync(p.configDir, { recursive: true })
  writeFileSync(p.gatewayFile, JSON.stringify({ capture: "none", blobDays: 1, port: 5000 }))
  assert.deepEqual(loadGatewayConfig(p), { port: 5000, upstreamUrl: "https://api.anthropic.com", chainFallback: "wait" })
  writeFileSync(p.gatewayFile, JSON.stringify({ capture: "none", blobDays: 1, chainFallback: "sideways" }))
  assert.throws(() => loadGatewayConfig(p), /chainFallback/)
})
test("config: dirs are 0700 and accounts.json is 0600", () => {
  const p = scratchPaths()
  mkdirSync(p.configDir, { recursive: true, mode: 0o755 }); writeFileSync(p.accountsFile, "{}", { mode: 0o644 })
  ensurePrivateDirs(p)
  for (const d of [p.configDir, p.dataDir, p.logsDir]) assert.equal(statSync(d).mode & 0o777, 0o700, d)
  assert.equal(statSync(p.accountsFile).mode & 0o777, 0o600)
  const q = scratchPaths(); ensurePrivateDirs(q)
  assert.throws(() => statSync(q.accountsFile))
})
test("config: gateway.json and routes.json save atomically and round-trip", () => {
  const p = scratchPaths(); ensurePrivateDirs(p)
  saveGatewayConfig(p, { port: 5001, upstreamUrl: "http://127.0.0.1:9", chainFallback: "direct" })
  assert.deepEqual(loadGatewayConfig(p), { port: 5001, upstreamUrl: "http://127.0.0.1:9", chainFallback: "direct" })
  assert.deepEqual(readRoutes(p), { version: 1, profiles: {} })
  const r = { version: 1 as const, profiles: { "/x/.claude": { mode: "pin" as const, account: "a@b.com work", wrote: { ANTHROPIC_BASE_URL: "u" }, replaced: null, replacedKind: null, statusLine: null, plugin: true } } }
  writeRoutes(p, r)
  assert.deepEqual(readRoutes(p), r)
  assert.deepEqual(readdirSync(p.configDir).sort(), ["gateway.json", "routes.json"])
})

test("config: routes.json keeps its parked records (off) through a read and a write", () => {
  const p = scratchPaths(); ensurePrivateDirs(p)
  const rec = { mode: "pin" as const, account: "work", wrote: { ANTHROPIC_BASE_URL: "u" }, replaced: null, replacedKind: null, statusLine: null, plugin: true }
  const r = { version: 1 as const, profiles: { "/x/.claude": rec }, off: { "/x/.claude-alt": { ...rec, mode: "pool" as const } } }
  writeRoutes(p, r)
  assert.deepEqual(readRoutes(p), r)
  // Read, changed, written back, as every caller does: off survives.
  const again = readRoutes(p)
  delete again.profiles["/x/.claude"]
  writeRoutes(p, again)
  assert.deepEqual(readRoutes(p).off, r.off)
  // A file without off reads without one.
  writeRoutes(p, { version: 1, profiles: {} })
  assert.equal(Object.hasOwn(readRoutes(p), "off"), false)
})

test("paths: a relative XDG_CONFIG_HOME or XDG_DATA_HOME is ignored", () => {
  const p = beaconsPaths({ HOME: "/h", XDG_CONFIG_HOME: ".", XDG_DATA_HOME: "rel/data" })
  assert.equal(p.configDir, "/h/.config/beacons")
  assert.equal(p.dataDir, "/h/.local/share/beacons")
})

test("config: gateway.json must be an object, with a non-empty upstreamUrl and a port up to 65535", () => {
  const p = scratchPaths()
  mkdirSync(p.configDir, { recursive: true })
  writeFileSync(p.gatewayFile, JSON.stringify({ port: 65535, upstreamUrl: "http://127.0.0.1:9100/relay" }))
  assert.deepEqual(loadGatewayConfig(p), { port: 65535, upstreamUrl: "http://127.0.0.1:9100/relay", chainFallback: "wait" })
  for (const upstreamUrl of ["", 9100, null, ["https://api.anthropic.com"]]) {
    writeFileSync(p.gatewayFile, JSON.stringify({ upstreamUrl }))
    assert.throws(() => loadGatewayConfig(p), /upstreamUrl must be a non-empty string/, JSON.stringify(upstreamUrl))
  }
  for (const text of ["[]", "null", "4774", '"http://127.0.0.1:9100"']) {
    writeFileSync(p.gatewayFile, text)
    assert.throws(() => loadGatewayConfig(p), /gateway\.json must be a JSON object/, text)
  }
  writeFileSync(p.gatewayFile, "{not json")
  assert.throws(() => loadGatewayConfig(p), /gateway\.json is not valid JSON/)
})

test("config: gateway.json and routes.json are written 0600, a looser one included", () => {
  const p = scratchPaths()
  saveGatewayConfig(p, { port: 5001, upstreamUrl: "https://api.anthropic.com", chainFallback: "wait" })
  writeRoutes(p, { version: 1, profiles: {} })
  for (const f of [p.gatewayFile, p.routesFile]) {
    assert.equal(statSync(f).mode & 0o777, 0o600, f)
    chmodSync(f, 0o644)
  }
  saveGatewayConfig(p, { port: 5002, upstreamUrl: "https://api.anthropic.com", chainFallback: "wait" })
  writeRoutes(p, { version: 1, profiles: {} })
  for (const f of [p.gatewayFile, p.routesFile]) assert.equal(statSync(f).mode & 0o777, 0o600, f)
})

test("config: a routes.json whose profiles is an array is refused, so no route is written without its record", () => {
  // JSON.stringify drops a named property on an array: the settings change would be written and its record lost.
  const p = scratchPaths()
  mkdirSync(p.configDir, { recursive: true })
  writeFileSync(p.routesFile, JSON.stringify({ version: 1, profiles: [] }))
  assert.throws(() => readRoutes(p), /not a version 1 routes file/)
  const dir = path.join(p.home, ".claude")
  mkdirSync(dir)
  writeFileSync(path.join(dir, "settings.json"), "{}\n")
  assert.throws(() => route(p, dir, { mode: "pool", account: "work", port: 4774 }), /not a version 1 routes file/)
  assert.equal(readFileSync(path.join(dir, "settings.json"), "utf8"), "{}\n")
  assert.equal(readFileSync(p.routesFile, "utf8"), JSON.stringify({ version: 1, profiles: [] }))
})
