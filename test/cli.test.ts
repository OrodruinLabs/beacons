// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The CLI, driven through `main(argv, env, io)` against a scratch HOME and XDG
// dirs. The Run is a fake that records calls, so no test runs the real claude,
// launchctl, systemctl or lsof. A daemon, where one is needed, is an HTTP
// server on an ephemeral port; a daemon that is down is a port nothing holds.
// The status-line comparison runs the real sh fast path (bin/beacons) beside
// the slow path, against the same servers.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import http from "node:http"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { main, realRun } from "../src/cli.ts"
import { get, whyNoAnswer } from "../src/loopback.ts"
import { readRoutes, saveGatewayConfig, writeRoutes, type ProfileRoute } from "../src/config.ts"
import type { LoginDeps } from "../src/accounts.ts"
import { beaconsPaths, type Paths } from "../src/paths.ts"
import { route, setStatusLine } from "../src/routes.ts"
import type { Run } from "../src/service.ts"

const REPO = fileURLToPath(new URL("..", import.meta.url))
const BOOT = path.join(REPO, "bin", "beacons")
const LABEL = "com.orodruinlabs.beacons"
const NOT_ANSWERING = "beacons is not answering; run `! beacons off` to go direct"

type Env = Record<string, string>
type Scratch = { dir: string; env: Env; p: Paths }

function scratch(): Scratch {
  const dir = mkdtempSync(path.join(tmpdir(), "beacons-"))
  const env: Env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, "config"), XDG_DATA_HOME: path.join(dir, "data"), PATH: process.env.PATH ?? "/usr/bin:/bin" }
  return { dir, env, p: beaconsPaths(env) }
}

function profile(s: Scratch, name: string, doc: Record<string, unknown> = {}): string {
  const dir = path.join(s.dir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify(doc, null, 2) + "\n")
  return dir
}

const settings = (dir: string) => JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"))

function gateway(s: Scratch, port: number, upstreamUrl = "https://api.anthropic.com"): void {
  saveGatewayConfig(s.p, { port, upstreamUrl, chainFallback: "wait" })
}

function accounts(s: Scratch, names: string[]): void {
  mkdirSync(s.p.configDir, { recursive: true })
  writeFileSync(s.p.accountsFile, JSON.stringify({ accounts: names.map((name, i) => ({ name, type: "oauth", refreshToken: `fake-${i}`, priority: i })) }), { mode: 0o600 })
}

/** A port nothing listens on: taken from the OS, then let go. */
async function closedPort(): Promise<number> {
  const srv = net.createServer()
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
  const port = (srv.address() as net.AddressInfo).port
  await new Promise<void>((r) => srv.close(() => r()))
  return port
}

/** A fake daemon: every request is recorded as "METHOD url", then handed to `handler`. */
async function daemon(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`)
    handler(req, res)
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  return {
    port: (server.address() as net.AddressInfo).port,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

/** `main` with captured output, a recording fake Run, macOS unless told otherwise, and an exit that only records. */
async function cli(argv: string[], env: Env, o: { input?: string; stdin?: Readable; run?: Run; platform?: NodeJS.Platform; loginDeps?: LoginDeps } = {}) {
  let out = ""
  let err = ""
  const exits: number[] = []
  const calls: [string, string[]][] = []
  const run: Run =
    o.run ??
    (async (cmd, args) => {
      calls.push([cmd, args])
      return { code: 0, stdout: "", stderr: "" }
    })
  const code = await main(argv, env, {
    stdin: o.stdin ?? Readable.from(o.input === undefined ? [] : [o.input]),
    stdout: new Writable({ write(c, _e, cb) { out += c.toString(); cb() } }),
    stderr: new Writable({ write(c, _e, cb) { err += c.toString(); cb() } }),
    run,
    platform: o.platform ?? "darwin",
    exit: (c) => void exits.push(c),
    loginDeps: o.loginDeps,
  })
  return { code, out, err, exits, calls }
}

/** `sh bin/beacons status --line`, the fast path, without blocking this process's servers. */
function fastLine(env: Env, input: string, cwd?: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("sh", [BOOT, "status", "--line"], { env, cwd, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c))
    const killer = setTimeout(() => child.kill("SIGKILL"), 10_000)
    child.on("close", () => {
      clearTimeout(killer)
      resolve(stdout)
    })
    child.stdin.end(input)
  })
}

const STATUS_IN = (sid: string) => JSON.stringify({ session_id: sid, transcript_path: "/x/y.jsonl", cwd: "/x", model: { id: "m", display_name: "M" } })

/** Route `dir` as setup does: the route, then the status line beacons writes where there is none. */
function setUp(s: Scratch, dir: string, mode: "pool" | "pin", account: string, port: number, o: { replace?: boolean } = {}): void {
  assert.equal(route(s.p, dir, { mode, account, port, replace: o.replace }).ok, true)
  setStatusLine(s.p, dir, s.p.launcher)
}

/** No call that stops, restarts or removes the service. */
const stops = (calls: [string, string[]][]) =>
  calls.filter(([cmd, args]) => (cmd === "launchctl" && (args.includes("bootout") || args.includes("-k"))) || (cmd === "systemctl" && args.some((a) => ["stop", "disable", "restart"].includes(a))))

// --- usage -----------------------------------------------------------------

test("cli: an unknown verb prints the usage and exits 2", async () => {
  const s = scratch()
  const r = await cli(["frobnicate"], s.env)
  assert.equal(r.code, 2)
  assert.match(r.err, /unknown command "frobnicate"/)
  assert.match(r.err, /usage: beacons/)
  assert.equal(r.out, "")
  assert.deepEqual(r.calls, [])
  const none = await cli([], s.env)
  assert.equal(none.code, 2)
  assert.match(none.err, /usage: beacons/)
  const help = await cli(["--help"], s.env)
  assert.equal(help.code, 0)
  assert.match(help.out, /usage: beacons/)
  // Bad usage of a known verb is 2 as well.
  assert.equal((await cli(["logout"], s.env)).code, 2)
  assert.equal((await cli(["status", "--lines"], s.env)).code, 2)
  assert.equal((await cli(["hook", "stop"], s.env)).code, 2)
})

test("cli: setup goes to setup's own command", async () => {
  const s = scratch()
  const r = await cli(["setup", "--no-such-flag"], s.env)
  assert.equal(r.code, 2)
  assert.match(r.out, /unknown option --no-such-flag/)
  assert.match(r.out, /usage: beacons setup/)
  assert.deepEqual(r.calls, [])
})

// --- off and on ----------------------------------------------------------------

test("cli: off with no args unroutes every recorded profile and leaves the service running", async () => {
  const s = scratch()
  const port = await closedPort()
  gateway(s, port)
  const a = profile(s, ".claude", { model: "x" })
  const b = profile(s, ".claude-alt", { env: { ANTHROPIC_BASE_URL: "http://other.example/v1", KEEP: "1" } })
  setUp(s, a, "pool", "work", port)
  setUp(s, b, "pin", "a@b.com", port, { replace: true })
  const r = await cli(["off"], s.env)
  assert.equal(r.code, 0, r.err)
  // The route key is gone, or back to what it replaced; everything else, the status line included, stays.
  assert.deepEqual(settings(a).env, undefined)
  assert.equal(settings(a).model, "x")
  assert.deepEqual(settings(b).env, { ANTHROPIC_BASE_URL: "http://other.example/v1", KEEP: "1" })
  assert.deepEqual(settings(a).statusLine, { type: "command", command: `${s.p.launcher} status --line`, refreshInterval: 30 })
  assert.ok(settings(b).statusLine)
  const routes = readRoutes(s.p)
  assert.deepEqual(routes.profiles, {})
  assert.deepEqual(Object.keys(routes.off ?? {}).sort(), [a, b].sort())
  // The service keeps running: nothing was asked of the service manager at all.
  assert.deepEqual(r.calls, [])
  assert.deepEqual(stops(r.calls), [])
  assert.match(r.out, /\.claude: off/)
  // Again: nothing is routed, which is not an error.
  const again = await cli(["off"], s.env)
  assert.equal(again.code, 0, again.err)
})

test("cli: off then on round-trips each profile to the same mode and account", async () => {
  const s = scratch()
  current(s, "0.1.0")
  const port = await closedPort()
  gateway(s, port)
  accounts(s, ["a@b.com work", "work"])
  const a = profile(s, ".claude", {})
  const b = profile(s, ".claude-alt", { env: { ANTHROPIC_BASE_URL: "http://other.example/v1" } })
  setUp(s, a, "pin", "a@b.com work", port)
  setUp(s, b, "pool", "work", port, { replace: true })
  const before = readRoutes(s.p).profiles
  const settingsBefore = [settings(a), settings(b)]

  assert.equal((await cli(["off", a], s.env)).code, 0)
  assert.deepEqual(Object.keys(readRoutes(s.p).profiles), [b])
  assert.equal((await cli(["off"], s.env)).code, 0)
  const on = await cli(["on"], s.env)
  assert.equal(on.code, 0, on.err)
  const routes = readRoutes(s.p)
  assert.deepEqual(routes.profiles, before)
  assert.equal(Object.hasOwn(routes, "off"), false)
  assert.deepEqual([settings(a), settings(b)], settingsBefore)
  assert.deepEqual(stops(on.calls), [])

  // One by name, and one already on.
  assert.equal((await cli(["off", b], s.env)).code, 0)
  const one = await cli(["on", b, a], s.env)
  assert.equal(one.code, 0, one.err)
  assert.match(one.out, /already on/)
  assert.deepEqual(readRoutes(s.p).profiles, before)
})

test("cli: on for a profile neither parked nor routed says to run beacons route", async () => {
  const s = scratch()
  current(s, "0.1.0")
  gateway(s, await closedPort())
  const dir = profile(s, ".claude-new", {})
  const r = await cli(["on", dir], s.env)
  assert.equal(r.code, 1)
  assert.ok(r.err.includes(`beacons route ${dir} pool:<account>`), r.err)
  assert.deepEqual(settings(dir), {})
  // Nothing parked, no names: nothing to do.
  const none = await cli(["on"], s.env)
  assert.equal(none.code, 0, none.err)
})

test("cli: on leaves off a profile whose account was logged out, and goes on with the others", async () => {
  const s = scratch()
  current(s, "0.1.0")
  const port = await closedPort()
  gateway(s, port)
  accounts(s, ["work", "gone"])
  const a = profile(s, ".claude", {})
  const b = profile(s, ".claude-alt", {})
  setUp(s, a, "pin", "gone", port)
  setUp(s, b, "pool", "work", port)
  assert.equal((await cli(["off"], s.env)).code, 0)
  assert.equal((await cli(["logout", "gone"], s.env)).code, 0)
  const r = await cli(["on"], s.env)
  assert.equal(r.code, 1)
  assert.match(r.err, /~\/\.claude: account "gone" is no longer signed in; it stays off/)
  const routes = readRoutes(s.p)
  assert.deepEqual(Object.keys(routes.profiles), [b])
  assert.deepEqual(Object.keys(routes.off ?? {}), [a])
  assert.equal(settings(a).env, undefined)
  assert.equal(settings(b).env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}/pool/work`)
})

test("cli: uninstall after off still removes the status line beacons wrote", async () => {
  const s = scratch()
  const port = await closedPort()
  gateway(s, port)
  const dir = profile(s, ".claude", { env: { KEEP: "1" } })
  setUp(s, dir, "pool", "work", port)
  assert.ok(settings(dir).statusLine)
  assert.equal((await cli(["off"], s.env)).code, 0)
  assert.ok(settings(dir).statusLine)
  const r = await cli(["uninstall"], s.env)
  assert.equal(r.code, 0, r.err)
  assert.equal(settings(dir).statusLine, undefined)
  assert.deepEqual(settings(dir).env, { KEEP: "1" })
  assert.ok(r.calls.some(([cmd, args]) => cmd === "env" && args[0] === `CLAUDE_CONFIG_DIR=${dir}` && args.includes("uninstall")), JSON.stringify(r.calls))
  assert.ok(r.calls.some(([cmd, args]) => cmd === "launchctl" && args[0] === "bootout"))
  assert.equal(Object.hasOwn(readRoutes(s.p), "off"), false)
  assert.match(r.out, /uninstalled/)
})

// --- route -------------------------------------------------------------------

test("cli: route refuses a profile on another gateway unless --replace, and an unknown account", async () => {
  const s = scratch()
  current(s, "0.1.0")
  const port = await closedPort()
  gateway(s, port)
  accounts(s, ["work", "a@b.com"])
  const other = "http://127.0.0.1:9/elsewhere"
  const dir = profile(s, ".claude", { env: { ANTHROPIC_BASE_URL: other } })
  const refused = await cli(["route", dir, "pin:a@b.com"], s.env)
  assert.equal(refused.code, 1)
  assert.ok(refused.err.includes(other) && refused.err.includes("--replace"), refused.err)
  assert.equal(settings(dir).env.ANTHROPIC_BASE_URL, other)
  const ok = await cli(["route", dir, "pin:a@b.com", "--replace"], s.env)
  assert.equal(ok.code, 0, ok.err)
  assert.equal(settings(dir).env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}/pin/a%40b.com`)
  assert.equal(readRoutes(s.p).profiles[dir].replaced, other)
  // Never set up: no plugin there yet, and route says how to add it.
  assert.ok(ok.out.includes("run `beacons setup` to add the plugin and status line to ~/.claude\n"), ok.out)
  // Now ours: a mode change needs no --replace. With the plugin in place there is nothing to add.
  const withPlugin = readRoutes(s.p)
  withPlugin.profiles[dir].plugin = true
  writeRoutes(s.p, withPlugin)
  const again = await cli(["route", dir, "pool:work"], s.env)
  assert.equal(again.code, 0, again.err)
  assert.equal(readRoutes(s.p).profiles[dir].mode, "pool")
  assert.ok(!again.out.includes("beacons setup"), again.out)
  // A profile off parked is unparked by route, and keeps the value it replaced.
  assert.equal((await cli(["off", dir], s.env)).code, 0)
  assert.equal(settings(dir).env.ANTHROPIC_BASE_URL, other)
  assert.equal((await cli(["route", dir, "pin:work"], s.env)).code, 0)
  assert.equal(Object.hasOwn(readRoutes(s.p), "off"), false)
  assert.equal(readRoutes(s.p).profiles[dir].replaced, other)

  const unknown = await cli(["route", dir, "pool:nobody"], s.env)
  assert.equal(unknown.code, 1)
  assert.match(unknown.err, /no account named "nobody"/)
  assert.equal((await cli(["route", dir, "both:work"], s.env)).code, 2)
  assert.equal((await cli(["route", dir], s.env)).code, 2)
  const missing = await cli(["route", path.join(s.dir, "nowhere"), "pool:work"], s.env)
  assert.equal(missing.code, 1)
  assert.deepEqual(missing.calls, [])
})

const NOT_SET_UP = /not set up on this machine/

test("cli: route before setup refuses, so no profile points at a gateway that is not installed", async () => {
  // Signed in with `beacons login`, but setup never got as far as the release and the service.
  const s = scratch()
  gateway(s, await closedPort())
  accounts(s, ["work"])
  const dir = profile(s, ".claude", { model: "x" })
  const r = await cli(["route", dir, "pin:work"], s.env)
  assert.equal(r.code, 1)
  assert.match(r.err, NOT_SET_UP)
  assert.deepEqual(settings(dir), { model: "x" })
  assert.equal(existsSync(s.p.routesFile), false)
  assert.deepEqual(r.calls, [])
})

test("cli: route after a first setup that stopped before the service refuses", async () => {
  // Setup switched to its release, then failed to start or was interrupted at the sign-ins: no unit is installed.
  const s = scratch()
  gateway(s, await closedPort())
  accounts(s, ["work"])
  current(s, "0.1.0", { unit: false })
  const dir = profile(s, ".claude", { model: "x" })
  const r = await cli(["route", dir, "pin:work"], s.env)
  assert.equal(r.code, 1)
  assert.match(r.err, NOT_SET_UP)
  assert.deepEqual(settings(dir), { model: "x" })
  assert.deepEqual(r.calls, [])
})

test("cli: on before setup refuses, and leaves the parked profiles off", async () => {
  // Uninstall without --purge keeps the config folder; a record off parked there must not route to a stopped gateway.
  const s = scratch()
  const port = await closedPort()
  gateway(s, port)
  accounts(s, ["work"])
  const dir = profile(s, ".claude", {})
  setUp(s, dir, "pool", "work", port)
  current(s, "0.1.0")
  assert.equal((await cli(["off"], s.env)).code, 0)
  writeFileSync(s.p.releaseState, JSON.stringify({ current: null, previous: null, held: null }))
  const routesBefore = readFileSync(s.p.routesFile, "utf8")
  const settingsBefore = settings(dir)
  for (const argv of [["on"], ["on", dir]]) {
    const r = await cli(argv, s.env)
    assert.equal(r.code, 1, argv.join(" "))
    assert.match(r.err, NOT_SET_UP)
    assert.equal(readFileSync(s.p.routesFile, "utf8"), routesBefore)
    assert.deepEqual(settings(dir), settingsBefore)
    assert.deepEqual(r.calls, [])
  }
})

// --- accounts ----------------------------------------------------------------

test("cli: login, logout and order tell a running daemon to reload", async () => {
  const s = scratch()
  const d = await daemon((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ added: 0, removed: 0 }))
  })
  try {
    gateway(s, d.port)
    accounts(s, ["work", "b"])
    const loginDeps: LoginDeps = {
      loginOAuth: async () => ({ accessToken: "at", refreshToken: "rt", expiresAt: 1 }) as never,
      fetchProfile: (async () => ({ email: "new@example.com", accountUuid: "u9", orgUuid: "o9" })) as never,
    }
    const login = await cli(["login", "--name", "fresh"], s.env, { loginDeps })
    assert.equal(login.code, 0, login.err)
    assert.match(login.out, /added "fresh"/)
    const order = await cli(["order", "fresh", "work"], s.env)
    assert.equal(order.code, 0, order.err)
    const logout = await cli(["logout", "b"], s.env)
    assert.equal(logout.code, 0, logout.err)
    const pool = JSON.parse(readFileSync(s.p.accountsFile, "utf8")).accounts as { name: string; priority: number }[]
    assert.deepEqual(pool.map((a) => a.name).sort(), ["fresh", "work"])
    assert.deepEqual(d.hits, ["POST /beacons/v1/reload", "POST /beacons/v1/reload", "POST /beacons/v1/reload"])
    // A name nobody has: an error, and no reload.
    const bad = await cli(["logout", "nobody"], s.env)
    assert.equal(bad.code, 1)
    assert.match(bad.err, /no account named "nobody"/)
    assert.equal(d.hits.length, 3)
  } finally {
    await d.close()
  }
})

// --- status --------------------------------------------------------------------

test("cli: status prints the accounts, open sessions, chain and version from the daemon", async () => {
  const s = scratch()
  const d = await daemon((req, res) => {
    if (req.url !== "/beacons/v1/status") return void res.writeHead(404).end()
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      version: "0.4.2", port: 0, upstream: "http://127.0.0.1:9100/relay",
      chain: { on: true, state: "up", fallback: "wait" }, current: "work",
      accounts: [
        { name: "a@b.com", priority: 1, use5h: null, use7d: null, disabled: true },
        { name: "work", priority: 0, use5h: 0.123, use7d: 0.4, disabled: false },
      ],
      sessions: [{ id: "abcdef0123456789", account: "work", mode: "pin", first: "work", lastSeen: 1 }],
      inFlight: 0,
    }))
  })
  try {
    gateway(s, d.port)
    const r = await cli(["status"], s.env)
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /0\.4\.2/)
    assert.match(r.out, /upstream: the proxy at http:\/\/127\.0\.0\.1:9100\/relay, which is up/)
    // First choice first, with its use.
    assert.ok(r.out.indexOf("work") < r.out.indexOf("a@b.com"), r.out)
    assert.match(r.out, /12%/)
    assert.match(r.out, /40%/)
    assert.match(r.out, /disabled/)
    assert.match(r.out, /abcdef01/)
    assert.ok(!r.out.includes("abcdef0123456789"))
    assert.match(r.out, /\bpin\b/)
  } finally {
    await d.close()
  }
})

test("cli: status with the daemon down says so and lists the routed profiles", async () => {
  const s = scratch()
  const port = await closedPort()
  gateway(s, port)
  const a = profile(s, ".claude", {})
  const b = profile(s, ".claude-alt", {})
  setUp(s, a, "pin", "work", port)
  setUp(s, b, "pool", "b", port)
  assert.equal((await cli(["off", b], s.env)).code, 0)
  const r = await cli(["status"], s.env)
  assert.equal(r.code, 1)
  assert.ok(r.out.includes(`beacons is not answering on 127.0.0.1:${port} (nothing is listening there).`), r.out)
  assert.match(r.out, /~\/\.claude\s+pin:work/)
  assert.match(r.out, /~\/\.claude-alt\s+pool:b.*\boff\b/)
})

test("cli: status gives up on a daemon that accepts and never answers, within its time limit", async () => {
  const sockets: net.Socket[] = []
  const hung = net.createServer((sock) => {
    sockets.push(sock)
    sock.resume()
  })
  await new Promise<void>((r) => hung.listen(0, "127.0.0.1", r))
  try {
    const s = scratch()
    gateway(s, (hung.address() as net.AddressInfo).port)
    const t0 = Date.now()
    const r = await cli(["status"], s.env)
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`)
    assert.equal(r.code, 1)
    assert.match(r.out, /not answering .*\(no answer within 2 s\)/)
  } finally {
    for (const sock of sockets) sock.destroy()
    await new Promise<void>((r) => hung.close(() => r()))
  }
})

test("cli: status --line slow path prints the same string as the fast path for the same inputs", async () => {
  const s = scratch()
  // The daemon echoes what it was asked for, so equal lines mean equal questions; session "gone" is refused.
  const d = await daemon((req, res) => {
    const u = new URL(req.url ?? "/", "http://x")
    const id = u.pathname.slice("/beacons/v1/sessions/".length)
    if (id === "gone") return void res.writeHead(404).end("{}")
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
    res.end(`◑ beacons ${id} ${u.searchParams.get("profile")} ${u.searchParams.get("format")}`)
  })
  const down = await closedPort()
  try {
    const routedUp = profile(s, "my profile@home", { env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${d.port}/pool/a` } })
    const inputs = [
      STATUS_IN("abc-123_x.y"),
      STATUS_IN("gone"),
      STATUS_IN(".hidden"),
      STATUS_IN("x".repeat(129)),
      STATUS_IN("x".repeat(128)),
      STATUS_IN("a b"),
      JSON.stringify({ cwd: "/x" }),
      `{"session_id":"first"}\n{"session_id":"second"}`,
      `{"a":{"session_id":"inner"},"session_id":"outer"}`,
      "",
      "not json",
    ]
    // With a relative XDG_CONFIG_HOME, both paths ignore it and read ~/.config/beacons/gateway.json, which names the
    // daemon; the one the relative value would name (the scratch's own config dir, from cwd) names a dead port.
    saveGatewayConfig(beaconsPaths({ HOME: s.dir }), { port: d.port, upstreamUrl: "https://api.anthropic.com", chainFallback: "wait" })
    const cases: { env: Env; port: number; cwd?: string; first?: RegExp }[] = [
      { env: { ...s.env, CLAUDE_CONFIG_DIR: routedUp }, port: d.port },
      { env: { ...s.env, CLAUDE_CONFIG_DIR: routedUp + "//" }, port: d.port },
      { env: { ...s.env, CLAUDE_CONFIG_DIR: "my profile@home", PWD: s.dir }, port: d.port, cwd: s.dir },
      { env: { ...s.env, XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", CLAUDE_CONFIG_DIR: routedUp, PWD: s.dir }, port: down, cwd: s.dir, first: /^◑ beacons abc-123_x\.y /u },
      // Down: routed here, routed elsewhere, no settings at all.
      { env: { ...s.env, CLAUDE_CONFIG_DIR: profile(s, "down-routed", { env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${down}/pin/a` } }) }, port: down },
      { env: { ...s.env, CLAUDE_CONFIG_DIR: profile(s, "down-other", { env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${down + 1}/pin/a` } }) }, port: down },
      { env: { ...s.env, CLAUDE_CONFIG_DIR: path.join(s.dir, "no-such-profile") }, port: down },
    ]
    let compared = 0
    for (const c of cases) {
      gateway(s, c.port)
      for (const [i, input] of inputs.entries()) {
        const fast = await fastLine(c.env, input, c.cwd)
        const slow = await cli(["status", "--line"], c.env, { input })
        assert.equal(slow.code, 0, slow.err)
        assert.equal(slow.out, fast, `${c.env.CLAUDE_CONFIG_DIR} ${JSON.stringify(input)}`)
        assert.notEqual(fast, "")
        if (i === 0 && c.first) assert.match(fast, c.first)
        compared++
      }
    }
    assert.equal(compared, cases.length * inputs.length)
    // No usable session id asked for session "-", the route fallback, on both paths.
    const dash = d.hits.filter((h) => h.startsWith("GET /beacons/v1/sessions/-?"))
    assert.ok(dash.length >= 2 * 6, `${dash.length} asks for "-"`)
  } finally {
    await d.close()
  }
})

// --- hook ----------------------------------------------------------------------

test("cli: hook session-start with no routed profile prints {}", async () => {
  const s = scratch()
  gateway(s, await closedPort())
  const r = await cli(["hook", "session-start"], { ...s.env, CLAUDE_CONFIG_DIR: profile(s, ".claude-x") }, { input: JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart", source: "startup" }) })
  assert.equal(r.out, "{}\n")
  assert.deepEqual(r.exits, [0])
  assert.equal(r.code, 0)
  assert.deepEqual(r.calls, [])
})

test("cli: hook session-start never waits on a stdin that stays open", async () => {
  const s = scratch()
  gateway(s, await closedPort())
  // A writer that never closes its end: the hook's work starts at once all the same.
  const open = new Readable({ read() {} })
  const t0 = Date.now()
  const r = await cli(["hook", "session-start"], { ...s.env, CLAUDE_CONFIG_DIR: profile(s, ".claude-x") }, { stdin: open })
  const ms = Date.now() - t0
  assert.equal(r.out, "{}\n")
  assert.deepEqual(r.exits, [0])
  assert.ok(ms < 150, `took ${ms} ms`)
  open.destroy()
})

test("cli: hook session-start starts a stopped service without forcing a restart", async () => {
  const s = scratch()
  const port = await closedPort()
  gateway(s, port)
  const dir = profile(s, ".claude", {})
  setUp(s, dir, "pool", "work", port)
  const t0 = Date.now()
  const r = await cli(["hook", "session-start"], { ...s.env, CLAUDE_CONFIG_DIR: dir }, { input: "{}" })
  assert.ok(Date.now() - t0 < 4500, `took ${Date.now() - t0} ms`)
  assert.deepEqual(JSON.parse(r.out), { systemMessage: NOT_ANSWERING })
  assert.deepEqual(r.exits, [0])
  assert.deepEqual(r.calls, [["launchctl", ["kickstart", `gui/${process.getuid!()}/${LABEL}`]]])
})

// --- the real Run, and the reasons --------------------------------------------------

test("cli: the real Run never throws, and says why a command did not finish", async () => {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" }
  assert.deepEqual(await realRun(env, 5000)("sh", ["-c", "printf out; printf err >&2"]), { code: 0, stdout: "out", stderr: "err" })
  assert.deepEqual(await realRun(env, 5000)("sh", ["-c", "printf why >&2; exit 3"]), { code: 3, stdout: "", stderr: "why" })
  const missing = await realRun(env, 5000)("beacons-no-such-command", [])
  assert.equal(missing.code, 127)
  assert.match(missing.stderr, /ENOENT/)
  const slow = await realRun(env, 200)("sh", ["-c", "sleep 5"])
  assert.equal(slow.code, 124)
  assert.match(slow.stderr, /did not finish within 0\.2 s/)
  // Too much output is its own reason, not a timeout, though the child is killed for it.
  const loud = await realRun(env, 5000, 1024)("sh", ["-c", "yes | head -n 2000"])
  assert.equal(loud.code, 1)
  assert.match(loud.stderr, /output was too large \(over 1024 bytes\)/)
  assert.ok(!/did not finish/.test(loud.stderr), loud.stderr)
})

test("cli: a timeout reason names the timeout it was given", async () => {
  const timeout = Object.assign(new Error("no answer within 2 s"), { name: "TimeoutError" })
  assert.equal(whyNoAnswer(timeout, 1500), "no answer within 1.5 s")
  assert.equal(whyNoAnswer(timeout, 2000), "no answer within 2 s")
  // The loopback client's own errors: a port nothing holds, and one that accepts and never answers.
  const refused = await get(await closedPort(), "/beacons/v1/status", 2000).catch((err: unknown) => err)
  assert.equal(whyNoAnswer(refused, 2000), "nothing is listening there")
  const hung = net.createServer((sock) => void sock.resume())
  await new Promise<void>((r) => hung.listen(0, "127.0.0.1", r))
  try {
    const slow = await get((hung.address() as net.AddressInfo).port, "/beacons/v1/status", 300).catch((err: unknown) => err)
    assert.equal(whyNoAnswer(slow, 300), "no answer within 0.3 s")
  } finally {
    hung.close()
  }
  assert.equal(whyNoAnswer(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), 2000), "read ECONNRESET")
})

// --- upgrade (R41) --------------------------------------------------------------

function pluginAt(version: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "beacons-plugin-"))
  mkdirSync(path.join(root, ".claude-plugin"))
  writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "beacons", version }))
  return root
}

/** A finished setup as the CLI sees it: a current release and beacons' launchd unit in place (cli() runs as darwin). */
function current(s: Scratch, version: string, o: { unit?: boolean } = {}): void {
  mkdirSync(s.p.releasesDir, { recursive: true })
  writeFileSync(s.p.releaseState, JSON.stringify({ current: version, previous: null, held: null }))
  if (o.unit === false) return
  const agents = path.join(s.p.home, "Library", "LaunchAgents")
  mkdirSync(agents, { recursive: true })
  writeFileSync(path.join(agents, `${LABEL}.plist`), "<plist/>")
}

test("cli: upgrade with no plugin root says so and exits non-zero", async () => {
  const s = scratch()
  current(s, "0.1.0")
  const r = await cli(["upgrade"], s.env)
  assert.equal(r.code, 1)
  assert.match(r.err, /CLAUDE_PLUGIN_ROOT/)
  assert.match(r.err, /BEACONS_ROOT/)
  assert.deepEqual(r.calls, [])
})

test("cli: upgrade from the current release says it is already current; CLAUDE_PLUGIN_ROOT wins over BEACONS_ROOT", async () => {
  const s = scratch()
  current(s, "0.1.0")
  const r = await cli(["upgrade"], { ...s.env, BEACONS_ROOT: pluginAt("0.1.0") })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /0\.1\.0 is already the current release/)
  assert.deepEqual(r.calls, [])
  const both = await cli(["upgrade", "--now"], { ...s.env, CLAUDE_PLUGIN_ROOT: pluginAt("0.1.0"), BEACONS_ROOT: pluginAt("0.2.0") })
  assert.equal(both.code, 0, both.err)
  assert.match(both.out, /already the current release/)
  // Before setup there is no release to upgrade from.
  const fresh = scratch()
  const none = await cli(["upgrade"], { ...fresh.env, BEACONS_ROOT: pluginAt("0.2.0") })
  assert.equal(none.code, 1)
  assert.match(none.err, /beacons setup/)
})

test("cli: rollback with no previous release fails, changing nothing", async () => {
  const s = scratch()
  current(s, "0.1.0")
  const r = await cli(["rollback"], s.env)
  assert.equal(r.code, 1)
  assert.match(r.err, /no previous release/)
  assert.deepEqual(r.calls, [])
})
