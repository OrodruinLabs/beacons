// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, lstatSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { beaconsPaths, type Paths } from "../src/paths.ts"
import { readRoutes, writeRoutes, type ProfileRoute } from "../src/config.ts"
import { readSettings, writeSettings, SettingsError } from "../src/settings.ts"
import { discoverProfiles, resolveProfile, tilde } from "../src/profiles.ts"
import { baseUrlIn, baseUrlOf, onChain, route, unroute, setStatusLine, removeStatusLine, shellWord } from "../src/routes.ts"

const URL_ = "http://127.0.0.1:4774/pool/a"
function scratch(): { p: Paths; home: string } {
  const home = mkdtempSync(path.join(tmpdir(), "beacons-"))
  return { p: beaconsPaths({ HOME: home }), home }
}
function profile(home: string, name: string, doc?: unknown): string {
  const d = path.join(home, name)
  mkdirSync(d, { recursive: true })
  if (doc !== undefined) writeFileSync(path.join(d, "settings.json"), JSON.stringify(doc, null, 2) + "\n")
  return d
}
const settings = (d: string) => JSON.parse(readFileSync(path.join(d, "settings.json"), "utf8"))
const opts = { mode: "pool" as const, account: "a", port: 4774 }

test("settings: unparseable file is refused untouched", () => {
  const { home } = scratch()
  const f = path.join(home, "settings.json")
  writeFileSync(f, "{ // c")
  assert.throws(() => readSettings(f), SettingsError)
  assert.throws(() => readSettings(f), /settings\.json/)
  assert.equal(readFileSync(f, "utf8"), "{ // c")
  const d = profile(home, ".claude"); writeFileSync(path.join(d, "settings.json"), "{ // c")
  assert.throws(() => route(scratch().p, d, opts), SettingsError)
  assert.equal(readFileSync(path.join(d, "settings.json"), "utf8"), "{ // c")
})
test("settings: a symlinked file is written through", () => {
  const { home } = scratch()
  const real = path.join(home, "real.json"); writeFileSync(real, '{"a":1}\n')
  const link = path.join(home, "settings.json"); symlinkSync(real, link)
  writeSettings(link, { a: 2, b: 3 })
  assert.ok(lstatSync(link).isSymbolicLink())
  assert.deepEqual(JSON.parse(readFileSync(real, "utf8")), { a: 2, b: 3 })
})
test("settings: the .beacons.bak is written once and never overwritten", () => {
  const { home } = scratch()
  const f = path.join(home, "settings.json"); writeFileSync(f, '{"orig":true}\n')
  writeSettings(f, { one: 1 }); writeSettings(f, { two: 2 })
  assert.equal(readFileSync(f + ".beacons.bak", "utf8"), '{"orig":true}\n')
  assert.equal(readFileSync(f, "utf8"), '{\n  "two": 2\n}\n')
})
test("profiles: discovery finds ~/.claude, settings folders and CLAUDE_CONFIG_DIR, de-duplicated", () => {
  const { home } = scratch()
  profile(home, ".claude-alt", {}); profile(home, ".claude-empty"); writeFileSync(path.join(home, ".claude.json"), "{}")
  const extra = profile(home, "elsewhere", {})
  symlinkSync(extra, path.join(home, ".claude-link"))
  const got = discoverProfiles(home, { CLAUDE_CONFIG_DIR: extra })
  assert.equal(got[0], path.join(home, ".claude"))
  assert.ok(got.includes(path.join(home, ".claude-alt")))
  assert.ok(!got.some((g) => g.endsWith(".claude-empty") || g.endsWith(".claude.json")))
  assert.equal(got.filter((g) => g === extra || g.endsWith(".claude-link")).length, 1)
  assert.ok(got.every((g) => path.isAbsolute(g)))
})
test("routes: a profile routed elsewhere is skipped unless replace", () => {
  const { p, home } = scratch()
  const d = profile(home, ".claude", { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9999" } })
  const r = route(p, d, opts)
  assert.deepEqual(r, { ok: false, reason: "routed-elsewhere", current: "http://127.0.0.1:9999" })
  assert.equal(settings(d).env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9999")
  assert.deepEqual(readRoutes(p).profiles, {})
  assert.equal(route(p, d, { ...opts, replace: true }).ok, true)
  assert.equal(settings(d).env.ANTHROPIC_BASE_URL, URL_)
  assert.equal(readRoutes(p).profiles[d].replacedKind, "other")
})
test("routes: off removes only our value and restores the replaced one", () => {
  const { p, home } = scratch()
  const d = profile(home, ".claude", { env: { ANTHROPIC_BASE_URL: "http://other.example", KEEP: "1" } })
  route(p, d, { ...opts, replace: true })
  assert.deepEqual(unroute(p, d, { proxyUp:false }), {})
  assert.deepEqual(settings(d).env, { KEEP: "1", ANTHROPIC_BASE_URL: "http://other.example" })
  assert.deepEqual(readRoutes(p).profiles, {})
})
test("routes: off leaves a value the user changed", () => {
  const { p, home } = scratch()
  const d = profile(home, ".claude", {})
  route(p, d, opts)
  const s = settings(d); s.env.ANTHROPIC_BASE_URL = "http://mine"; writeFileSync(path.join(d, "settings.json"), JSON.stringify(s))
  const r = unroute(p, d, { proxyUp:true })
  assert.equal(r.note, `${d}: ANTHROPIC_BASE_URL was changed after setup; left as is`)
  assert.equal(settings(d).env.ANTHROPIC_BASE_URL, "http://mine")
  assert.deepEqual(readRoutes(p).profiles, {})
})
test("routes: a proxy's route is restored only while the proxy answers", () => {
  const { p, home } = scratch()
  const proxy = "http://127.0.0.1:9100/relay"
  for (const up of [true, false]) {
    const d = profile(home, up ? ".claude-up" : ".claude-down", { env: { ANTHROPIC_BASE_URL: proxy } })
    assert.equal(route(p, d, { ...opts, chainUrl: proxy }).ok, true)
    assert.equal(readRoutes(p).profiles[d].replacedKind, "proxy")
    const r = unroute(p, d, { proxyUp: up })
    if (up) { assert.deepEqual(r, {}); assert.equal(settings(d).env.ANTHROPIC_BASE_URL, proxy) }
    else { assert.match(r.note!, /the upstream proxy is not answering/); assert.equal(settings(d).env, undefined) }
  }
})
test("routes: a replaced kind an older build wrote counts as a proxy's, so it too is restored only while the proxy answers", () => {
  const { p, home } = scratch()
  const proxy = "http://127.0.0.1:9100/relay"
  for (const up of [true, false]) {
    const d = profile(home, up ? ".claude-up" : ".claude-down", { env: { ANTHROPIC_BASE_URL: URL_ } })
    const rec = { mode: "pool", account: "a", wrote: { ANTHROPIC_BASE_URL: URL_ }, replaced: proxy, replacedKind: "an-older-kind", statusLine: null, plugin: false }
    writeRoutes(p, { version: 1, profiles: { [d]: rec as unknown as ProfileRoute } })
    const r = unroute(p, d, { proxyUp: up })
    if (up) { assert.deepEqual(r, {}); assert.equal(settings(d).env.ANTHROPIC_BASE_URL, proxy) }
    else { assert.match(r.note!, /the upstream proxy is not answering/); assert.equal(settings(d).env, undefined) }
  }
})
test("routes: only the chain URL and paths under it are the proxy's, not the rest of its host and port", () => {
  const { p, home } = scratch()
  const chainUrl = "http://127.0.0.1:9100/relay"
  for (const [value, mine] of [[chainUrl, true], [`${chainUrl}/`, true], [`${chainUrl}/v1`, true], ["http://127.0.0.1:9100/relay-two", false], ["http://127.0.0.1:9100/work", false], ["http://127.0.0.1:9100", false]] as const) {
    assert.equal(onChain(value, chainUrl), mine, value)
    assert.equal(onChain(value, `${chainUrl}/`), mine, `${value} against a chain URL with a trailing slash`)
  }
  const work = profile(home, ".claude-work", { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9100/work" } })
  assert.deepEqual(route(p, work, { ...opts, chainUrl }), { ok: false, reason: "routed-elsewhere", current: "http://127.0.0.1:9100/work" })
})
test("routes: a vanished profile is skipped with a note", () => {
  const { p, home } = scratch()
  const d = profile(home, ".claude-gone", {})
  route(p, d, opts)
  const moved = path.join(home, "moved"); renameSync(d, moved)
  assert.deepEqual(unroute(p, d, { proxyUp:true }), { note: `${d} no longer exists; skipped` })
  assert.deepEqual(readRoutes(p).profiles, {})
  assert.deepEqual(unroute(p, d, { proxyUp:true }), {})
})
test("routes: routing a parked profile unparks it and keeps its status line, plugin and replaced value", () => {
  const { p, home } = scratch()
  const other = "http://other.example"
  const d = profile(home, ".claude", { env: { ANTHROPIC_BASE_URL: other } })
  const keep = profile(home, ".claude-keep", {})
  route(p, d, { ...opts, replace: true }); route(p, keep, opts)
  setStatusLine(p, d, "/bin/beacons")
  // Parked as `off` parks it: the record kept under off, the route taken out.
  const park = () => {
    const routes = readRoutes(p)
    const rec = { ...routes.profiles[d], plugin: true }
    unroute(p, d, { proxyUp:true })
    writeRoutes(p, { ...readRoutes(p), off: { [d]: rec } })
  }
  park()
  assert.equal(settings(d).env.ANTHROPIC_BASE_URL, other)
  assert.ok(settings(d).statusLine)
  // The value restored at off is the one the record replaced, so no --replace is needed to route it again.
  assert.equal(route(p, d, { ...opts, mode: "pin", account: "b" }).ok, true)
  let routes = readRoutes(p)
  assert.equal(Object.hasOwn(routes, "off"), false)
  assert.equal(routes.profiles[d].mode, "pin")
  assert.equal(routes.profiles[d].replaced, other)
  assert.equal(routes.profiles[d].plugin, true)
  assert.deepEqual(routes.profiles[d].statusLine, settings(d).statusLine)
  assert.ok(routes.profiles[keep])
  // removeStatusLine reaches a parked record too.
  park()
  removeStatusLine(p, d)
  assert.equal(settings(d).statusLine, undefined)
  routes = readRoutes(p)
  assert.equal(routes.off![d].statusLine, null)
  assert.equal(routes.profiles[d], undefined)
})
test("routes: keys beacons did not write are listed and kept", () => {
  const { p, home } = scratch()
  const d = profile(home, ".claude", { model: "x", env: { _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1" }, z: 1 })
  const r = route(p, d, opts)
  assert.deepEqual(r, { ok: true, others: ["_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL"] })
  assert.deepEqual(Object.keys(settings(d)), ["model", "env", "z"])
  unroute(p, d, { proxyUp:true })
  assert.deepEqual(settings(d).env, { _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1" })
})
test("routes: an env object left empty is removed on off", () => {
  const { p, home } = scratch()
  const d = profile(home, ".claude", { model: "x" })
  route(p, d, opts); unroute(p, d, { proxyUp:true })
  assert.deepEqual(settings(d), { model: "x" })
})
test("routes: re-routing keeps the original replaced value", () => {
  const { p, home } = scratch()
  const d = profile(home, ".claude", { env: { ANTHROPIC_BASE_URL: "http://other.example" } })
  route(p, d, { ...opts, replace: true })
  assert.equal(route(p, d, { ...opts, mode: "pin", account: "b" }).ok, true)
  const rec = readRoutes(p).profiles[d]
  assert.equal(rec.replaced, "http://other.example"); assert.equal(rec.replacedKind, "other")
  assert.equal(rec.mode, "pin"); assert.equal(settings(d).env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4774/pin/b")
})
test("routes: a launcher path with a space is quoted as one shell word in the status line", () => {
  const { p, home } = scratch()
  const dir = profile(home, ".claude", {})
  route(p, dir, opts)
  assert.equal(setStatusLine(p, dir, "/my data/beacons/releases/current/bin/beacons"), "written")
  assert.equal(settings(dir).statusLine.command, "'/my data/beacons/releases/current/bin/beacons' status --line")
  assert.equal(shellWord("/plain/path-1.2_x+y"), "/plain/path-1.2_x+y")
  assert.equal(shellWord("/it's here"), `'/it'\\''s here'`)
})

test("routes: statusLine is written only where none exists and removed only while ours", () => {
  const { p, home } = scratch()
  const none = profile(home, ".claude", {}), has = profile(home, ".claude-alt", { statusLine: { type: "command", command: "x" } }), unrouted = profile(home, ".claude-u", {})
  route(p, none, opts); route(p, has, opts)
  assert.equal(setStatusLine(p, none, "/bin/beacons"), "written")
  assert.deepEqual(settings(none).statusLine, { type: "command", command: "/bin/beacons status --line", refreshInterval: 30 })
  assert.equal(setStatusLine(p, has, "/bin/beacons"), "kept")
  assert.equal(setStatusLine(p, unrouted, "/bin/beacons"), "kept")
  assert.equal(settings(unrouted).statusLine, undefined); assert.equal(readRoutes(p).profiles[unrouted], undefined)
  removeStatusLine(p, has); assert.deepEqual(settings(has).statusLine, { type: "command", command: "x" })
  const s = settings(none); s.statusLine.command = "mine"; writeFileSync(path.join(none, "settings.json"), JSON.stringify(s))
  removeStatusLine(p, none); assert.equal(settings(none).statusLine.command, "mine")
})
test("routes: the status line beacons wrote is its own on the next run, and follows a new command", () => {
  const { p, home } = scratch()
  const d = profile(home, ".claude", {}); route(p, d, opts)
  assert.equal(setStatusLine(p, d, "/bin/beacons"), "written")
  const before = readFileSync(path.join(d, "settings.json"), "utf8")
  assert.equal(setStatusLine(p, d, "/bin/beacons"), "ours")
  assert.equal(readFileSync(path.join(d, "settings.json"), "utf8"), before)
  // The command changed (the launcher is no longer beacons' own): beacons' line moves with it, record first.
  assert.equal(setStatusLine(p, d, "/data/releases/current/bin/beacons"), "ours")
  const line = { type: "command", command: "/data/releases/current/bin/beacons status --line", refreshInterval: 30 }
  assert.deepEqual(settings(d).statusLine, line)
  assert.deepEqual(readRoutes(p).profiles[d].statusLine, line)
  // Once the user edits it, it is theirs.
  const s = settings(d); s.statusLine.command = "mine"; writeFileSync(path.join(d, "settings.json"), JSON.stringify(s))
  assert.equal(setStatusLine(p, d, "/bin/beacons"), "kept")
  assert.equal(settings(d).statusLine.command, "mine")
})
test("routes: statusLine we wrote is removed", () => {
  const { p, home } = scratch()
  const d = profile(home, ".claude", {}); route(p, d, opts)
  setStatusLine(p, d, "/bin/beacons"); removeStatusLine(p, d)
  assert.equal(settings(d).statusLine, undefined); assert.equal(readRoutes(p).profiles[d].statusLine, null)
})
test("routes: a crash between the record and the settings write loses nothing", () => {
  const { p, home } = scratch()
  const orig = "http://other.example"
  const d = profile(home, ".claude", { env: { ANTHROPIC_BASE_URL: orig } })
  writeRoutes(p, { version: 1, profiles: { [d]: { mode: "pool", account: "a", wrote: { ANTHROPIC_BASE_URL: URL_ }, replaced: orig, replacedKind: "other", statusLine: null, plugin: false } } })
  assert.equal(route(p, d, opts).ok, true)
  assert.equal(readRoutes(p).profiles[d].replaced, orig)
  unroute(p, d, { proxyUp:true })
  assert.equal(settings(d).env.ANTHROPIC_BASE_URL, orig)
  // and a crash with no re-route: settings unchanged, so off leaves it and drops the record
  writeRoutes(p, { version: 1, profiles: { [d]: { mode: "pool", account: "a", wrote: { ANTHROPIC_BASE_URL: URL_ }, replaced: orig, replacedKind: "other", statusLine: null, plugin: false } } })
  assert.match(unroute(p, d, { proxyUp:true }).note!, /changed after setup/)
  assert.equal(settings(d).env.ANTHROPIC_BASE_URL, orig)
})
test("settings: a dangling symlink is refused, not replaced", () => {
  const { home } = scratch()
  const link = path.join(home, "settings.json"); symlinkSync(path.join(home, "nowhere.json"), link)
  assert.throws(() => writeSettings(link, { a: 1 }), (e: any) => e instanceof SettingsError && /settings\.json/.test(e.message) && /points nowhere/.test(e.message))
  assert.ok(lstatSync(link).isSymbolicLink())
})
test("routes: a non-object env is a SettingsError; a longer port is not the proxy's", () => {
  const { p, home } = scratch()
  const d = profile(home, ".claude", { env: "x" })
  assert.throws(() => route(p, d, opts), SettingsError)
  const e = profile(home, ".claude-e", { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:91000/w" } })
  assert.equal(route(p, e, { ...opts, chainUrl: "http://127.0.0.1:9100" }).ok, false)
})

test("routes: a profile's ANTHROPIC_BASE_URL, read one way everywhere", () => {
  const { home } = scratch()
  assert.equal(baseUrlOf(profile(home, ".claude-none")), null)
  assert.equal(baseUrlOf(profile(home, ".claude-empty", { env: { ANTHROPIC_BASE_URL: "" } })), null)
  assert.equal(baseUrlOf(profile(home, ".claude-number", { env: { ANTHROPIC_BASE_URL: 4774 } })), null)
  assert.equal(baseUrlOf(profile(home, ".claude-set", { env: { ANTHROPIC_BASE_URL: URL_ } })), URL_)
  // An env route() would refuse is refused here too; baseUrlIn, for a document already read, just finds none.
  const bad = profile(home, ".claude-bad-env", { env: "x" })
  assert.throws(() => baseUrlOf(bad), SettingsError)
  assert.equal(baseUrlIn({ env: "x" }), null)
  assert.equal(baseUrlIn({ env: { ANTHROPIC_BASE_URL: URL_ } }), URL_)
})

test("profiles: a profile named on the command line, and named back in messages", () => {
  assert.equal(resolveProfile("~", "/h"), "/h")
  assert.equal(resolveProfile("~/.claude-alt", "/h"), "/h/.claude-alt")
  assert.equal(resolveProfile("/x/.claude/", "/h"), "/x/.claude")
  assert.equal(resolveProfile(".claude", "/h"), path.resolve(".claude"))
  assert.equal(tilde("/h", "/h"), "~")
  assert.equal(tilde("/h", "/h/.claude"), "~/.claude")
  assert.equal(tilde("/h", "/home/.claude"), "/home/.claude")
})
