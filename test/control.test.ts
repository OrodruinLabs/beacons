// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { handleControl } from "../src/control.ts"
import type { ControlDeps } from "../src/control.ts"
import { SessionMap } from "../src/sessions.ts"
import type { Engine } from "../src/engine-glue.ts"

type Opts = { chain?: ControlDeps["chain"] extends () => infer R ? R : never; reload?: ControlDeps["reload"]; leave?: ControlDeps["leave"] }

async function start(o: Opts = {}) {
  const sessions = new SessionMap()
  const left: { now: boolean }[] = []
  const engine = {
    status: () => ({
      switchThreshold: 0.98,
      routes: [],
      sessions: { known: 0, active: 0, perAccount: {}, distribute: false },
      accounts: [
        { name: "a", type: "oauth", orgName: null, priority: 1, disabled: false, status: "ok", sessions: 0, quota: { unified5h: 0.25, unified7d: 0.5 }, usage: {}, rateLimitedUntil: null, pausedUntil: null },
        { name: "b", type: "oauth", orgName: null, priority: 2, disabled: true, status: "ok", sessions: 0, quota: {}, usage: {}, rateLimitedUntil: null, pausedUntil: null },
      ],
    }),
  } as unknown as Engine
  const deps: ControlDeps = {
    version: "9.9.9",
    engine,
    sessions,
    port: () => 4774,
    upstreamUrl: "https://api.anthropic.com",
    routeFor: (p) => (p === "/p/personal" ? { mode: "pin", account: "personal" } : null),
    chain: () => o.chain,
    inFlight: () => 3,
    reload: o.reload ?? (async () => ({ added: 1, removed: 0 })),
    leave: o.leave ?? ((x) => void left.push(x)),
  }
  const server = http.createServer((req, res) => {
    if (!handleControl(req, res, new URL(req.url!, "http://x").pathname, deps)) {
      res.statusCode = 599
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, sessions, left, close: () => new Promise<void>((r) => server.close(() => r())) }
}

test("control: status reports accounts without credentials", async () => {
  const s = await start()
  s.sessions.record("s1", { account: "a", mode: "pool", first: "a" })
  const r = await fetch(s.base + "/beacons/v1/status")
  const j = (await r.json()) as Record<string, any>
  assert.equal(j.sessions.length, 1)
  assert.deepEqual(j.accounts[0], { name: "a", priority: 1, use5h: 0.25, use7d: 0.5, disabled: false })
  assert.equal(j.accounts[1].disabled, true)
  assert.equal(j.accounts[1].use5h, null)
  assert.doesNotMatch(JSON.stringify(j), /token/i)
  await s.close()
})

test("control: sessions/<id> for an unseen session answers from the profile's route", async () => {
  const s = await start()
  const r = await fetch(s.base + "/beacons/v1/sessions/abc?profile=" + encodeURIComponent("/p/personal"))
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { session: null, line: "◔ beacons personal" })
  await s.close()
})

test("control: a profile path spelled with // or /./ or .. finds its route", async () => {
  const s = await start()
  for (const spelled of ["/p//personal", "/p/./personal", "/p/x/../personal"]) {
    const r = await fetch(s.base + "/beacons/v1/sessions/abc?profile=" + encodeURIComponent(spelled))
    assert.deepEqual(await r.json(), { session: null, line: "◔ beacons personal" }, spelled)
  }
  await s.close()
})

test("control: an unrouted profile is direct", async () => {
  const s = await start()
  const r = await fetch(s.base + "/beacons/v1/sessions/abc?profile=/elsewhere")
  assert.equal(((await r.json()) as any).line, "◔ beacons direct")
  const r2 = await fetch(s.base + "/beacons/v1/sessions/abc")
  assert.equal(((await r2.json()) as any).line, "◔ beacons direct")
  await s.close()
})

test("control: a failed-over pool session shows ◑", async () => {
  const s = await start()
  s.sessions.record("sess-1", { account: "b", mode: "pool", first: "a" })
  const r = await fetch(s.base + "/beacons/v1/sessions/sess-1?profile=/p/personal")
  const j = (await r.json()) as any
  assert.equal(j.line, "◑ beacons b")
  assert.equal(j.session.account, "b")
  await s.close()
})

test("control: once off takes a profile's route out, its sessions read direct, though the map still names them", async () => {
  const s = await start()
  try {
    s.sessions.record("sess-1", { account: "b", mode: "pool", first: "a" })
    // /p/gone has no route: off put its earlier value back, so the session's requests already leave beacons.
    const gone = await fetch(s.base + "/beacons/v1/sessions/sess-1?profile=/p/gone")
    assert.deepEqual(await gone.json(), { session: null, line: "◔ beacons direct" })
    const line = await fetch(s.base + "/beacons/v1/sessions/sess-1?profile=/p/gone&format=line")
    assert.equal(await line.text(), "◔ beacons direct")
    // A routed profile, or no profile named, still reads the session from the map.
    assert.equal(((await (await fetch(s.base + "/beacons/v1/sessions/sess-1?profile=/p/personal")).json()) as any).line, "◑ beacons b")
    assert.equal(((await (await fetch(s.base + "/beacons/v1/sessions/sess-1")).json()) as any).line, "◑ beacons b")
  } finally {
    await s.close()
  }
})

test("control: a session line follows a down chain", async () => {
  const s = await start({ chain: { on: true, state: "down", fallback: "wait" } })
  const r = await fetch(s.base + "/beacons/v1/sessions/x?profile=/p/personal")
  assert.equal(((await r.json()) as any).line, "◕ beacons proxy down")
  await s.close()
})

test("control: a bad session id is 400", async () => {
  const s = await start()
  for (const id of ["a%20b", "a%2Fb", "x".repeat(129), "%E0%A4%A"]) {
    const r = await fetch(s.base + "/beacons/v1/sessions/" + id)
    assert.equal(r.status, 400, id)
  }
  assert.equal((await fetch(s.base + "/beacons/v1/sessions/" + "x".repeat(128))).status, 200)
  await s.close()
})

test("control: an unknown control path is 404 and never forwarded", async () => {
  const s = await start()
  for (const p of ["/beacons/v1/nope", "/beacons/other", "/_gateway/accounts.live"]) {
    const r = await fetch(s.base + p)
    assert.equal(r.status, 404, p)
    assert.ok(((await r.json()) as any).error)
  }
  assert.equal((await fetch(s.base + "/v1/messages")).status, 599)
  await s.close()
})

test("control: a wrong method is 405", async () => {
  const s = await start()
  assert.equal((await fetch(s.base + "/beacons/v1/health", { method: "POST" })).status, 405)
  assert.equal((await fetch(s.base + "/beacons/v1/status", { method: "POST" })).status, 405)
  assert.equal((await fetch(s.base + "/beacons/v1/reload")).status, 405)
  assert.equal((await fetch(s.base + "/beacons/v1/restart")).status, 405)
  assert.equal((await fetch(s.base + "/beacons/v1/sessions/a", { method: "POST" })).status, 405)
  await s.close()
})

test("control: reload returns the counts, and a failure is 500", async () => {
  const s = await start()
  const r = await fetch(s.base + "/beacons/v1/reload", { method: "POST" })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { added: 1, removed: 0 })
  await s.close()
  const f = await start({ reload: async () => { throw new Error("bad file") } })
  const r2 = await fetch(f.base + "/beacons/v1/reload", { method: "POST" })
  assert.equal(r2.status, 500)
  assert.deepEqual(await r2.json(), { error: "bad file" })
  await f.close()
})

test("control: restart answers 202 first, then leaves once the answer has gone", async () => {
  const s = await start()
  const r = await fetch(s.base + "/beacons/v1/restart", { method: "POST", body: JSON.stringify({ now: true }) })
  assert.equal(r.status, 202)
  assert.deepEqual(await r.json(), { ok: true, now: true })
  await new Promise((x) => setTimeout(x, 20))
  assert.deepEqual(s.left, [{ now: true }])
  const r2 = await fetch(s.base + "/beacons/v1/restart", { method: "POST" })
  assert.deepEqual(await r2.json(), { ok: true, now: false })
  await new Promise((x) => setTimeout(x, 20))
  assert.deepEqual(s.left, [{ now: true }, { now: false }])
  await s.close()
})

test("control: restart with a bad or oversized body", async () => {
  const s = await start()
  assert.equal((await fetch(s.base + "/beacons/v1/restart", { method: "POST", body: "{nope" })).status, 400)
  const big = await fetch(s.base + "/beacons/v1/restart", { method: "POST", body: "x".repeat(65 * 1024) }).catch(() => null)
  assert.ok(big === null || big.status === 413)
  assert.deepEqual(s.left, [])
  await s.close()
})

test("control: a leave that throws is logged, not fatal", async () => {
  const lines: string[] = []
  const write = process.stderr.write
  process.stderr.write = ((c: string | Uint8Array) => (lines.push(String(c)), true)) as typeof process.stderr.write
  const s = await start({ leave: () => { throw new Error("boom") } })
  try {
    const r = await fetch(s.base + "/beacons/v1/restart", { method: "POST" })
    assert.equal(r.status, 202)
    await r.json()
    await new Promise((x) => setTimeout(x, 50))
    assert.equal((await fetch(s.base + "/beacons/v1/health")).status, 200, "still answering")
    assert.ok(lines.some((l) => /^beacons: .*boom/.test(l)), lines.join(""))
  } finally {
    process.stderr.write = write
    await s.close()
  }
})
