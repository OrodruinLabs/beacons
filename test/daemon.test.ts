// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The daemon as the service manager runs it: a real process from
// src/daemon.ts with a scratch HOME and XDG dirs and port 0, and, where a reply
// must stay open, a fake upstream on loopback named as the chain. The one
// account is an API key, and the quota prober is off, so nothing here reaches
// Anthropic. Every daemon spawned here is killed in `finally`.
import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import type { IncomingHttpHeaders, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { clearEnvironmentFailures, forgetBoot, noteEnvironmentFailure, recordBoot } from "../src/bootcount.ts"
import { beaconsPaths } from "../src/paths.ts"
import type { Paths } from "../src/paths.ts"
import { readReleaseState, switchTo } from "../src/release.ts"

const DAEMON = fileURLToPath(new URL("../src/daemon.ts", import.meta.url))
const PLUGIN_VERSION = (JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8")) as { version: string }).version
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (pred: () => boolean, ms = 3000) => {
  const t = Date.now() + ms
  while (!pred() && Date.now() < t) await sleep(20)
  return pred()
}

function scratch(): { env: NodeJS.ProcessEnv; p: Paths } {
  const dir = mkdtempSync(path.join(tmpdir(), "beacons-"))
  const env = {
    HOME: dir,
    XDG_CONFIG_HOME: path.join(dir, "config"),
    XDG_DATA_HOME: path.join(dir, "data"),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  }
  return { env, p: beaconsPaths(env) }
}

/** `gateway.json` with port 0 unless `gateway` says otherwise, and an accounts file when given. */
function configure(p: Paths, gateway: Record<string, unknown> = {}, accounts?: Record<string, unknown>): void {
  mkdirSync(p.configDir, { recursive: true, mode: 0o700 })
  writeFileSync(p.gatewayFile, JSON.stringify({ port: 0, ...gateway }))
  if (accounts) writeFileSync(p.accountsFile, JSON.stringify(accounts), { mode: 0o600 })
}

const ONE_API_KEY = {
  accounts: [{ name: "k", type: "apikey", apiKey: "sk-test-not-a-real-key" }],
  switchThreshold: 0.98,
  quotaProbeSeconds: 0,
}

/** A release folder with its release.json, and the Node it names installed. */
function makeRelease(p: Paths, version: string, node: string): void {
  const dir = path.join(p.releasesDir, version)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "release.json"), JSON.stringify({ version, node }))
  mkdirSync(path.join(p.nodeDir, node, "bin"), { recursive: true })
}

type Daemon = {
  child: ChildProcess
  /** The port from the stdout line; rejects if the daemon exits first. */
  port: Promise<number>
  out(): string
  err(): string
  /** The exit code once the process has exited and its output is read. */
  exit: Promise<number | null>
  kill(): void
}

function daemon(env: NodeJS.ProcessEnv): Daemon {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", DAEMON], { env, stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  let err = ""
  child.stdout!.setEncoding("utf8").on("data", (c: string) => (out += c))
  child.stderr!.setEncoding("utf8").on("data", (c: string) => (err += c))
  const exit = new Promise<number | null>((r) => child.once("close", (code) => r(code)))
  const port = new Promise<number>((resolve, reject) => {
    child.stdout!.on("data", () => {
      const m = /beacons: listening on 127\.0\.0\.1:(\d+)\n/.exec(out)
      if (m) resolve(Number(m[1]))
    })
    void exit.then((code) => reject(new Error(`the daemon exited (${code}) before listening: ${err}`)))
  })
  port.catch(() => {})
  return {
    child,
    port,
    out: () => out,
    err: () => err,
    exit,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    },
  }
}

const exitWithin = (d: Daemon, ms: number) => Promise.race([d.exit, sleep(ms).then(() => "still running" as const)])

/** A loopback upstream proxy: it takes connections, so the chain is up, and every request goes to `answer`. */
async function fakeUpstream(answer: (res: ServerResponse) => void) {
  let seen = 0
  const srv = http.createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      seen += 1
      answer(res)
    })
  })
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    seen: () => seen,
    close: () => {
      srv.closeAllConnections()
      return new Promise<void>((r) => srv.close(() => r()))
    },
  }
}

/** An SSE reply that starts at once and ends when `release` is called. */
function heldReply() {
  let release = () => {}
  const answer = (res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write("event: ping\ndata: {}\n\n")
    release = () => {
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
      res.end()
    }
  }
  return { answer, release: () => release() }
}

const messages = (port: number) =>
  fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5", stream: true, messages: [{ role: "user", content: "hi" }] }),
  })

const restart = (port: number, body?: unknown) =>
  fetch(`http://127.0.0.1:${port}/beacons/v1/restart`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) })

/** A GET on a keep-alive agent, so a `connection: close` in the answer is the server's, not the client's. */
function get(port: number, p: string, agent: http.Agent | false = false): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: p, agent }, (res) => {
        let body = ""
        res.setEncoding("utf8").on("data", (c: string) => (body += c))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      })
      .on("error", reject)
  })
}

/** True once a new connection to `port` is refused, polling for up to `ms`. */
async function refusedWithin(port: number, ms = 2000): Promise<boolean> {
  const t = Date.now() + ms
  while (Date.now() < t) {
    try {
      await get(port, "/beacons/v1/health")
    } catch {
      return true
    }
    await sleep(20)
  }
  return false
}

/** The start times boot-count.json holds now. */
const startsIn = (p: Paths) => (JSON.parse(readFileSync(p.bootCount, "utf8")) as { starts: number[] }).starts

// --- the boot counter and releases ----------------------------------------

test("daemon: three starts in a minute is a crash loop", () => {
  const { p } = scratch()
  const t = 1_800_000_000_000
  assert.equal(recordBoot(p.bootCount, t).crashLoop, false)
  assert.equal(recordBoot(p.bootCount, t + 20_000).crashLoop, false)
  assert.equal(recordBoot(p.bootCount, t + 40_000).crashLoop, true)
  // The file is cleared: the build that starts next counts from one.
  assert.equal(recordBoot(p.bootCount, t + 41_000).crashLoop, false)
  assert.equal(recordBoot(p.bootCount, t + 42_000).crashLoop, false)

  // A start more than a minute old does not count.
  const q = scratch().p
  recordBoot(q.bootCount, t)
  recordBoot(q.bootCount, t + 30_000)
  assert.equal(recordBoot(q.bootCount, t + 61_000).crashLoop, false)

  // A file it cannot read starts the count afresh.
  const r = scratch().p
  mkdirSync(r.dataDir, { recursive: true })
  writeFileSync(r.bootCount, "not json")
  assert.equal(recordBoot(r.bootCount, t).crashLoop, false)

  // A start that ended cleanly takes exactly itself back out, so it never adds up to a loop.
  const s = scratch().p
  recordBoot(s.bootCount, t)
  recordBoot(s.bootCount, t + 1000)
  forgetBoot(s.bootCount, t + 1000)
  assert.deepEqual(startsIn(s), [t])
  forgetBoot(s.bootCount, t + 5000)
  assert.deepEqual(startsIn(s), [t], "a start not in the file changes nothing")
  assert.equal(recordBoot(s.bootCount, t + 2000).crashLoop, false)
})

test("release: switchTo repoints current and node, and remembers previous", () => {
  const { p } = scratch()
  makeRelease(p, "1.0.0", "26.13.0")
  makeRelease(p, "1.1.0", "26.14.0")
  assert.deepEqual(readReleaseState(p), { current: null, previous: null, held: null })

  switchTo(p, "1.0.0")
  assert.deepEqual(readReleaseState(p), { current: "1.0.0", previous: null, held: null })
  switchTo(p, "1.1.0")
  assert.equal(readlinkSync(p.currentRelease), path.join(p.releasesDir, "1.1.0"))
  assert.equal(readlinkSync(p.currentNode), path.join(p.nodeDir, "26.14.0"))
  assert.deepEqual(readReleaseState(p), { current: "1.1.0", previous: "1.0.0", held: null })
  // No temp link is left beside either one.
  assert.deepEqual(readdirSync(p.releasesDir).sort(), ["1.0.0", "1.1.0", "current", "state.json"])
  assert.deepEqual(readdirSync(p.nodeDir).sort(), ["26.13.0", "26.14.0", "current"])

  // Switching to the current one again keeps the real previous; a plain switch never touches held.
  writeFileSync(p.releaseState, JSON.stringify({ current: "1.1.0", previous: "1.0.0", held: "0.9.0" }))
  switchTo(p, "1.1.0")
  assert.deepEqual(readReleaseState(p), { current: "1.1.0", previous: "1.0.0", held: "0.9.0" })
  switchTo(p, "1.0.0")
  assert.deepEqual(readReleaseState(p), { current: "1.0.0", previous: "1.1.0", held: "0.9.0" })
  assert.equal(readlinkSync(p.currentNode), path.join(p.nodeDir, "26.13.0"))

  // A switch that holds sets held to the version it left, in the same write.
  switchTo(p, "1.1.0", { hold: true })
  assert.deepEqual(readReleaseState(p), { current: "1.1.0", previous: "1.0.0", held: "1.0.0" })
  // Holding while already current leaves nothing, so held stays.
  switchTo(p, "1.1.0", { hold: true })
  assert.deepEqual(readReleaseState(p), { current: "1.1.0", previous: "1.0.0", held: "1.0.0" })
})

test("release: switchTo a release that is not whole changes nothing", () => {
  const { p } = scratch()
  makeRelease(p, "1.0.0", "26.13.0")
  switchTo(p, "1.0.0")
  const before = readFileSync(p.releaseState, "utf8")

  assert.throws(() => switchTo(p, "2.0.0"), /2\.0\.0/)
  mkdirSync(path.join(p.releasesDir, "2.1.0"))
  assert.throws(() => switchTo(p, "2.1.0"), /release\.json/)
  mkdirSync(path.join(p.releasesDir, "2.2.0"))
  writeFileSync(path.join(p.releasesDir, "2.2.0", "release.json"), JSON.stringify({ version: "2.2.0", node: "27.0.0" }))
  assert.throws(() => switchTo(p, "2.2.0"), /27\.0\.0/, "its Node is not installed")
  for (const bad of ["", "..", "../1.0.0", "a/b"]) assert.throws(() => switchTo(p, bad), /is not a release version/, bad)

  assert.equal(readFileSync(p.releaseState, "utf8"), before)
  assert.equal(readlinkSync(p.currentRelease), path.join(p.releasesDir, "1.0.0"))
  assert.equal(readlinkSync(p.currentNode), path.join(p.nodeDir, "26.13.0"))
})

// --- the daemon process ---------------------------------------------------

test("daemon: prints its port and answers health", async () => {
  const { env, p } = scratch()
  configure(p)
  writeFileSync(
    p.routesFile,
    JSON.stringify({
      version: 1,
      profiles: { "/p/.claude": { mode: "pin", account: "a@b.com", wrote: { ANTHROPIC_BASE_URL: "x" }, replaced: null, replacedKind: null, statusLine: null, plugin: true } },
    }),
  )
  const d = daemon(env)
  try {
    const port = await d.port
    const base = `http://127.0.0.1:${port}`
    const health = await fetch(`${base}/beacons/v1/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true, version: PLUGIN_VERSION })

    const status = (await (await fetch(`${base}/beacons/v1/status`)).json()) as Record<string, unknown>
    assert.equal(status.port, port)

    // The route comes from routes.json, read when asked.
    const line = async (profile: string) => (await fetch(`${base}/beacons/v1/sessions/s1?format=line&profile=${encodeURIComponent(profile)}`)).text()
    assert.equal(await line("/p/.claude"), "◔ beacons a@b.com")
    assert.equal(await line("/elsewhere"), "◔ beacons direct")
    assert.equal(await line("constructor"), "◔ beacons direct", "an inherited key is no route")
  } finally {
    d.kill()
  }
})

test("daemon: restart waits for the open reply, then exits 0", async () => {
  const { env, p } = scratch()
  const held = heldReply()
  const up = await fakeUpstream(held.answer)
  configure(p, { upstreamUrl: up.url }, ONE_API_KEY)
  const d = daemon(env)
  const agent = new http.Agent({ keepAlive: true })
  try {
    const port = await d.port
    const pending = messages(port)
    assert.ok(await until(() => up.seen() === 1), "the reply is open upstream")

    const r = await restart(port)
    assert.equal(r.status, 202)
    assert.deepEqual(await r.json(), { ok: true, now: false })
    await sleep(300)
    assert.equal(d.child.exitCode, null, "it waits while a reply is open")

    // Still listening while it waits, and every answer says the connection closes.
    const h = await get(port, "/beacons/v1/health", agent)
    assert.equal(h.status, 200)
    assert.equal(h.headers.connection, "close")

    held.release()
    const res = await pending
    assert.equal(res.status, 200)
    assert.match(await res.text(), /message_stop/, "the open reply finished whole")
    assert.equal(await exitWithin(d, 2000), 0)
  } finally {
    d.kill()
    held.release()
    agent.destroy()
    await up.close()
  }
})

test("daemon: restart now drains at once", async () => {
  const { env, p } = scratch()
  const held = heldReply()
  const up = await fakeUpstream(held.answer)
  configure(p, { upstreamUrl: up.url }, ONE_API_KEY)
  const d = daemon(env)
  try {
    const port = await d.port
    const res = await messages(port)
    assert.equal(res.status, 200)

    const t0 = Date.now()
    const r = await restart(port, { now: true })
    assert.equal(r.status, 202)
    assert.deepEqual(await r.json(), { ok: true, now: true })
    assert.ok(await refusedWithin(port, 1000), "the listener closed at once")

    await assert.rejects(res.text(), "the reply still open at the cap is cut")
    assert.equal(await exitWithin(d, 5000), 0)
    const took = Date.now() - t0
    assert.ok(took >= 2500 && took < 5000, `left after ${took} ms (a 3 s drain)`)
  } finally {
    d.kill()
    held.release()
    await up.close()
  }
})

test("daemon: SIGTERM persists quota state", async () => {
  const { env, p } = scratch()
  const reset = String(Math.floor(Date.now() / 1000) + 3600)
  const up = await fakeUpstream((res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-5h-reset": reset,
    })
    res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 1 } }))
  })
  configure(p, { upstreamUrl: up.url }, ONE_API_KEY)
  const d = daemon(env)
  const stateFile = path.join(p.configDir, "accounts.state.json")
  try {
    const port = await d.port
    const res = await messages(port)
    assert.equal(res.status, 200)
    await res.text()
    assert.throws(() => readFileSync(stateFile), "nothing written before the signal")

    d.child.kill("SIGTERM")
    assert.equal(await exitWithin(d, 5000), 0)
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as { quota: { name: string; quota: { unified5h: number } }[] }
    assert.equal(state.quota.find((q) => q.name === "k")?.quota.unified5h, 0.42)
  } finally {
    d.kill()
    await up.close()
  }
})

test("daemon: a second signal while leaving exits at once", async () => {
  const { env, p } = scratch()
  const held = heldReply()
  const up = await fakeUpstream(held.answer)
  configure(p, { upstreamUrl: up.url }, ONE_API_KEY)
  const d = daemon(env)
  try {
    const port = await d.port
    const res = await messages(port)
    assert.equal(res.status, 200)
    d.child.kill("SIGTERM")
    await sleep(300)
    assert.equal(d.child.exitCode, null, "the first signal drains, up to 3 s")
    const t0 = Date.now()
    d.child.kill("SIGTERM")
    assert.equal(await exitWithin(d, 1000), 0)
    assert.ok(Date.now() - t0 < 1000)
  } finally {
    d.kill()
    held.release()
    await up.close()
  }
})

test("daemon: a signal during a patient restart drains at once", async () => {
  const { env, p } = scratch()
  const held = heldReply()
  const up = await fakeUpstream(held.answer)
  configure(p, { upstreamUrl: up.url }, ONE_API_KEY)
  const d = daemon(env)
  try {
    const port = await d.port
    const res = await messages(port)
    assert.equal(res.status, 200)
    assert.equal((await restart(port)).status, 202)
    await sleep(200)
    assert.equal((await get(port, "/beacons/v1/health")).status, 200, "patient: still listening")
    d.child.kill("SIGTERM")
    assert.ok(await refusedWithin(port, 1000), "the signal closed the listener")
    assert.equal(await exitWithin(d, 5000), 0)
  } finally {
    d.kill()
    held.release()
    await up.close()
  }
})

test("daemon: a crash loop switches back to the previous release, holds the one it left, and exits 1", async () => {
  const { env, p } = scratch()
  configure(p)
  makeRelease(p, "1.0.0", "26.13.0")
  makeRelease(p, "1.1.0", "26.13.0")
  switchTo(p, "1.0.0")
  switchTo(p, "1.1.0")
  const now = Date.now()
  recordBoot(p.bootCount, now - 2000)
  recordBoot(p.bootCount, now - 1000)
  const d = daemon(env)
  try {
    assert.equal(await exitWithin(d, 5000), 1)
    assert.doesNotMatch(d.out(), /listening/)
    const lines = d.err().trim().split("\n")
    assert.equal(lines.length, 1, d.err())
    assert.match(lines[0], /^beacons: .*1\.0\.0/)
    assert.equal(readlinkSync(p.currentRelease), path.join(p.releasesDir, "1.0.0"))
    // Held: the session hook does not upgrade straight back to the build that crash-looped.
    assert.deepEqual(readReleaseState(p), { current: "1.0.0", previous: "1.1.0", held: "1.1.0" })
  } finally {
    d.kill()
  }
})

test("daemon: a crash loop does not switch to a held previous release", async () => {
  const { env, p } = scratch()
  configure(p)
  makeRelease(p, "1.0.0", "26.13.0")
  makeRelease(p, "1.1.0", "26.13.0")
  switchTo(p, "1.1.0")
  switchTo(p, "1.0.0", { hold: true })
  // 1.1.0 crash-looped and was left; now 1.0.0 loops too. Going back would only flip between them.
  assert.deepEqual(readReleaseState(p), { current: "1.0.0", previous: "1.1.0", held: "1.1.0" })
  const now = Date.now()
  recordBoot(p.bootCount, now - 2000)
  recordBoot(p.bootCount, now - 1000)
  const d = daemon(env)
  try {
    const port = await d.port
    assert.equal((await fetch(`http://127.0.0.1:${port}/beacons/v1/health`)).status, 200, "it boots on")
    assert.match(d.err(), /^beacons: crash loop on 1\.0\.0; previous 1\.1\.0 is held, not switching$/m)
    assert.equal(readlinkSync(p.currentRelease), path.join(p.releasesDir, "1.0.0"))
    assert.deepEqual(readReleaseState(p), { current: "1.0.0", previous: "1.1.0", held: "1.1.0" })
  } finally {
    d.kill()
  }
})

test("daemon: three clean exits in a minute do not trip the guard", async () => {
  const { env, p } = scratch()
  configure(p)
  makeRelease(p, "1.0.0", "26.13.0")
  makeRelease(p, "1.1.0", "26.13.0")
  switchTo(p, "1.0.0")
  switchTo(p, "1.1.0")
  // A signal, a patient restart and a restart now: each a clean exit 0. Counted, the third would switch to 1.0.0.
  const stops: ((d: Daemon, port: number) => Promise<unknown>)[] = [
    async (d) => d.child.kill("SIGTERM"),
    (_d, port) => restart(port),
    (_d, port) => restart(port, { now: true }),
    async (d) => d.child.kill("SIGINT"),
  ]
  for (const [i, stop] of stops.entries()) {
    const d = daemon(env)
    try {
      const port = await d.port
      await stop(d, port)
      assert.equal(await exitWithin(d, 5000), 0, `stop ${i}`)
      assert.deepEqual(startsIn(p), [], `stop ${i} took its start back out`)
      assert.doesNotMatch(d.err(), /crash loop|three starts/, `stop ${i}`)
    } finally {
      d.kill()
    }
  }
  assert.deepEqual(readReleaseState(p), { current: "1.1.0", previous: "1.0.0", held: null })
})

test("daemon: a crash loop with no previous release boots anyway", async () => {
  const { env, p } = scratch()
  configure(p)
  const now = Date.now()
  recordBoot(p.bootCount, now - 2000)
  recordBoot(p.bootCount, now - 1000)
  const d = daemon(env)
  try {
    const port = await d.port
    assert.equal((await fetch(`http://127.0.0.1:${port}/beacons/v1/health`)).status, 200)
    assert.match(d.err(), /no previous release/)
  } finally {
    d.kill()
  }
})

test("daemon: a taken port exits 1, names it, and is not counted", async () => {
  const { env, p } = scratch()
  const blocker = http.createServer()
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r))
  const taken = (blocker.address() as AddressInfo).port
  configure(p, { port: taken })
  const d = daemon(env)
  try {
    assert.equal(await exitWithin(d, 5000), 1)
    assert.match(d.err(), new RegExp(`^beacons: port ${taken} is in use$`, "m"))
    assert.deepEqual(startsIn(p), [], "the environment's fault, not the build's")
  } finally {
    d.kill()
    await new Promise<void>((r) => blocker.close(() => r()))
  }
})

test("daemon: an invalid gateway.json exits 1, says why, and is not counted", async () => {
  const { env, p } = scratch()
  for (const text of ["{not json", JSON.stringify({ port: "4774" })]) {
    configure(p)
    writeFileSync(p.gatewayFile, text)
    const d = daemon(env)
    try {
      assert.equal(await exitWithin(d, 5000), 1, text)
      assert.match(d.err(), /^beacons: .*gateway\.json/m, text)
      assert.deepEqual(startsIn(p), [], text)
    } finally {
      d.kill()
    }
  }
})

test("daemon: an accounts.json the engine cannot load exits 1, names the file, and is not counted", async () => {
  // One hand-edit typo must not read as a crash loop: that would switch to the previous release and hold this one.
  const { env, p } = scratch()
  const cases: [string, RegExp][] = [
    ["{not json", /accounts\.json is not valid JSON/],
    ["[]", /accounts\.json must be a JSON object/],
    [JSON.stringify({ accounts: [], upstreamProxy: "socks5://127.0.0.1:1080" }), /accounts\.json: .*unsupported proxy protocol/],
  ]
  for (const [text, why] of cases) {
    configure(p)
    writeFileSync(p.accountsFile, text, { mode: 0o600 })
    const d = daemon(env)
    try {
      assert.equal(await exitWithin(d, 5000), 1, text)
      assert.match(d.err(), new RegExp(`^beacons: ${p.accountsFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"), d.err())
      assert.match(d.err(), why, d.err())
      assert.deepEqual(startsIn(p), [], text)
    } finally {
      d.kill()
    }
  }
})

test("daemon: environment failures one after another wait longer each time, up to a minute", () => {
  const { p } = scratch()
  const f = path.join(p.dataDir, "env-failures.json")
  mkdirSync(p.dataDir, { recursive: true })
  const t = 1_000_000_000
  // The first exits at once; the next ones wait 1 s, 2 s, 4 s ... and never more than a minute.
  const waits = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => noteEnvironmentFailure(f, t + i * 61_000))
  assert.deepEqual(waits, [0, 1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000])
  // One long after the last starts a new run, and so does a start that served.
  assert.equal(noteEnvironmentFailure(f, t + 9 * 61_000 + 6 * 60_000), 0)
  assert.equal(noteEnvironmentFailure(f, t + 9 * 61_000 + 6 * 60_000 + 1000), 1000)
  clearEnvironmentFailures(f)
  assert.equal(noteEnvironmentFailure(f, t + 20 * 60_000), 0)
  // A clock set back is no run either; nor is a file that cannot be read.
  assert.equal(noteEnvironmentFailure(f, t), 0)
  writeFileSync(f, "{debris")
  assert.equal(noteEnvironmentFailure(f, t + 1000), 0)
})

test("daemon: a taken port the start before also met waits before exiting; a start that serves ends the run", async () => {
  const { env, p } = scratch()
  const blocker = http.createServer()
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r))
  const taken = (blocker.address() as AddressInfo).port
  configure(p, { port: taken })
  const first = daemon(env)
  assert.equal(await exitWithin(first, 5000), 1)
  const t0 = Date.now()
  const second = daemon(env)
  try {
    assert.equal(await exitWithin(second, 5000), 1)
    assert.ok(Date.now() - t0 >= 900, `exited after ${Date.now() - t0} ms`)
    assert.match(second.err(), new RegExp(`^beacons: port ${taken} is in use \\(the start before stopped too: waiting 1 s before exiting\\)$`, "m"))
    assert.deepEqual(startsIn(p), [])
  } finally {
    second.kill()
    await new Promise<void>((r) => blocker.close(() => r()))
  }
  const serves = daemon(env)
  try {
    await serves.port
    assert.equal(existsSync(path.join(p.dataDir, "env-failures.json")), false)
  } finally {
    serves.kill()
  }
})

test("daemon: a daemon.log past 5 MiB is moved aside at the next start, its tail kept", async () => {
  const { env, p } = scratch()
  configure(p)
  const log = path.join(p.logsDir, "daemon.log")
  mkdirSync(p.logsDir, { recursive: true })
  const cap = 5 * 1024 * 1024
  writeFileSync(log, Buffer.concat([Buffer.alloc(cap, "x"), Buffer.from("the last line\n")]))
  const d = daemon(env)
  try {
    await d.port
    assert.equal(statSync(log).size, 0)
    const kept = readFileSync(`${log}.1`)
    assert.equal(kept.length, cap)
    assert.ok(kept.toString("utf8").endsWith("xthe last line\n"), "the newest lines are the ones kept")
    // A log under the cap is left as it is.
    writeFileSync(log, "small\n")
  } finally {
    d.kill()
    await d.exit
  }
  const again = daemon(env)
  try {
    await again.port
    assert.equal(readFileSync(log, "utf8"), "small\n")
  } finally {
    again.kill()
  }
})
