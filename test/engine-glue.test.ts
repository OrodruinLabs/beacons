// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// What is ported is the harness: a scripted fake upstream on an ephemeral
// loopback port and an accounts file in a scratch dir. The tests are beacons'
// own and drive `Engine.serve` through a one-request front of their own, so no
// network, no real credential and no state outside the scratch dir.
import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { bootEngine, DEFAULT_PROBE_SECONDS, isOverageHeader } from "../src/engine-glue.ts"
import type { Engine, ServeResult } from "../src/engine-glue.ts"

const FAR = Date.now() + 24 * 3_600_000

/**
 * The prober and a token refresh talk to Anthropic directly, never to the fake
 * upstream. So every boot here has the prober off and a refresh that fails,
 * unless a test turns one on for itself: the prober test with API-key rows only
 * (it never probes those), the refresh test with its own stub.
 */
const noRefresh = async (): Promise<never> => { throw new Error("this test refreshes nothing") }
const boot = (accountsFile: string, o: Partial<Parameters<typeof bootEngine>[0]> = {}) =>
  bootEngine({ accountsFile, log: () => {}, refreshFn: noRefresh, probeSeconds: 0, ...o })

type Seen = { auth: string | undefined; path: string; headers: http.IncomingHttpHeaders }
type Script = (n: number, seen: Seen, res: ServerResponse) => void
type Pin = { account: string | null; mode: "pool" | "pin" }

function listen(srv: http.Server): Promise<number> {
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as { port: number }).port)))
}
function shut(srv: http.Server): Promise<void> {
  srv.closeAllConnections()
  return new Promise((r) => srv.close(() => r()))
}

/** A scripted upstream: `script(n, seen, res)` answers the n-th request (1-based). */
async function fakeUpstream(script: Script): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = []
  const srv = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume()
    req.on("end", () => {
      const s: Seen = {
        auth: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
        path: req.url ?? "/",
        headers: req.headers,
      }
      seen.push(s)
      script(seen.length, s, res)
    })
  })
  const port = await listen(srv)
  return { url: `http://127.0.0.1:${port}`, seen, close: () => shut(srv) }
}

const ok = (res: ServerResponse, extra: Record<string, string> = {}) => {
  res.writeHead(200, { "content-type": "application/json", ...extra })
  res.end('{"type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}')
}

const scratch = () => mkdtempSync(path.join(tmpdir(), "beacons-"))

function accountsFile(dir: string, rows: Record<string, unknown>[], extra: Record<string, unknown> = {}): string {
  const f = path.join(dir, "accounts.json")
  writeFileSync(f, JSON.stringify({ accounts: rows, switchThreshold: 0.98, ...extra }, null, 2))
  return f
}
const rewrite = (f: string, rows: Record<string, unknown>[]) =>
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), accounts: rows }, null, 2))
const rowsOf = (f: string) => (JSON.parse(readFileSync(f, "utf8")) as { accounts: Record<string, unknown>[] }).accounts

const oauth = (name: string, uuid: string, tok: string) => ({
  name, type: "oauth", accountUuid: uuid, orgUuid: `org-${uuid}`, accessToken: tok, refreshToken: `r-${tok}`, expiresAt: FAR,
})
const A = () => oauth("a", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "tok-a")
const B = () => oauth("b", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "tok-b")
const C = () => oauth("c", "cccccccc-cccc-cccc-cccc-cccccccccccc", "tok-c")

/**
 * One request through a throwaway front that hands it to `e.serve`, the way the
 * real front will: the client's headers as sent, the body read whole.
 */
async function through(e: Engine, o: { upstream: string; url?: string; pin?: Pin; headers?: Record<string, string> }) {
  let served: Promise<ServeResult> | null = null
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      served = e.serve({
        req, res, url: o.url ?? req.url ?? "/", body: Buffer.concat(chunks), reqId: "t-1", sessionId: null,
        pin: o.pin ?? { account: null, mode: "pool" }, upstream: o.upstream,
      })
    })
  })
  const port = await listen(srv)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...o.headers },
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }),
    })
    const text = await res.text()
    assert.ok(served, "the front handed the request to the engine")
    return { status: res.status, headers: res.headers, text, result: await (served as Promise<ServeResult>) }
  } finally {
    await shut(srv)
  }
}

test("glue: the account's token goes upstream, never the client's", async () => {
  const dir = scratch()
  const file = accountsFile(dir, [A()])
  const up = await fakeUpstream((_n, _s, res) => ok(res))
  const e = await boot(file)
  try {
    // The chain's per-request base keeps its path; the url is appended, not resolved.
    const r = await through(e, {
      upstream: `${up.url}/relay`,
      url: "/v1/messages?beta=true",
      headers: { authorization: "Bearer client-own", "x-api-key": "client-key" },
    })
    assert.equal(r.status, 200)
    assert.equal(up.seen.length, 1)
    assert.equal(up.seen[0].auth, "Bearer tok-a")
    assert.equal(up.seen[0].headers["x-api-key"], undefined, "the client's key never leaves")
    assert.equal(up.seen[0].path, "/relay/v1/messages?beta=true")
    assert.deepEqual(r.result, { status: 200, account: "a", error: null })
  } finally {
    await e.stop()
    await up.close()
  }
})

test("glue: a refreshed token lands in the accounts file by identity", async () => {
  const dir = scratch()
  const file = accountsFile(dir, [A(), B()])
  const refreshed: string[] = []
  const refreshFn = async (rt: string) => {
    refreshed.push(rt)
    return { accessToken: "new", refreshToken: "r-new", expiresAt: FAR + 1000 }
  }
  const up = await fakeUpstream((_n, s, res) => {
    if (s.auth === "Bearer tok-a") {
      res.writeHead(401, { "content-type": "application/json" })
      res.end('{"type":"error","error":{"type":"authentication_error","message":"revoked"}}')
      return
    }
    ok(res)
  })
  const e = await boot(file, { refreshFn })
  try {
    // `order` rewrote the file since boot: a is no longer the first row. The
    // engine still knows a as its account 0; the write must find a's row by who it is.
    rewrite(file, [B(), A()])
    const r = await through(e, { upstream: up.url, pin: { account: "a", mode: "pin" } })
    assert.equal(r.status, 200)
    assert.deepEqual(refreshed, ["r-tok-a"], "one refresh, with a's refresh token")
    assert.deepEqual(up.seen.map((s) => s.auth), ["Bearer tok-a", "Bearer new"])
  } finally {
    await e.stop()
    await up.close()
  }
  const rows = rowsOf(file)
  assert.deepEqual(rows.map((x) => x.name), ["b", "a"], "the file keeps its order")
  assert.equal(rows[1].accessToken, "new")
  assert.equal(rows[1].refreshToken, "r-new")
  assert.equal(rows[0].accessToken, "tok-b", "b's row is untouched")
})

test("glue: reload adds a new row and takes out a removed one", async () => {
  const dir = scratch()
  const file = accountsFile(dir, [A(), B()])
  const up = await fakeUpstream((_n, _s, res) => ok(res))
  const e = await boot(file)
  try {
    // `login` added c; `logout` took b out of the file.
    rewrite(file, [A(), C()])
    const r = await e.reload()
    assert.deepEqual(r, { added: 1, removed: 1 })
    assert.deepEqual(e.status().accounts.map((a) => a.name), ["a", "c"], "status hides it")

    // A pin naming the logged-out account never sends its token: it is refused.
    const pinned = await through(e, { upstream: up.url, pin: { account: "b", mode: "pin" } })
    assert.equal(pinned.status, 400)
    assert.equal(up.seen.length, 0)

    // Nothing changed: nothing counted twice.
    assert.deepEqual(await e.reload(), { added: 0, removed: 0 })

    // Logged in again: back in its old place, in service, not added twice.
    rewrite(file, [A(), C(), B()])
    assert.deepEqual(await e.reload(), { added: 0, removed: 0 })
    const back = e.status().accounts.find((a) => a.name === "b")
    assert.ok(back && !back.disabled, "a re-added account serves again")
    assert.equal(e.status().accounts.length, 3)

    // The current account disabled with nothing else left: status names no current one.
    rewrite(file, [{ ...A(), disabled: true }])
    assert.deepEqual(await e.reload(), { added: 0, removed: 2 })
    assert.equal(e.status().currentAccount, undefined, "a disabled account is not current")
    assert.deepEqual(e.status().accounts.map((a) => [a.name, a.disabled]), [["a", true]])

    // The only account logged out: no current account, no accounts.
    rewrite(file, [])
    assert.deepEqual(await e.reload(), { added: 0, removed: 1 })
    assert.equal(e.status().currentAccount, undefined, "a removed account is not current")
    assert.deepEqual(e.status().accounts, [])
  } finally {
    await e.stop()
    await up.close()
  }
})

test("glue: a hard pin to an account not in the file answers 400 and sends nothing upstream", async () => {
  const dir = scratch()
  const file = accountsFile(dir, [A(), { ...B(), disabled: true }])
  const up = await fakeUpstream((_n, _s, res) => ok(res))
  const e = await boot(file)
  /** An Anthropic-shaped invalid_request_error that names the pinned account. */
  const refused = (text: string, name: string) => {
    const j = JSON.parse(text) as { type: string; error: { type: string; message: string } }
    assert.equal(j.type, "error")
    assert.equal(j.error.type, "invalid_request_error")
    assert.ok(j.error.message.includes(`"${name}"`), j.error.message)
  }
  try {
    // Unknown, and a name that needs escaping.
    for (const name of ["nobody@x.com", 'odd "name"']) {
      const r = await through(e, { upstream: up.url, pin: { account: name, mode: "pin" } })
      assert.equal(r.status, 400)
      assert.match(r.headers.get("content-type") ?? "", /^application\/json/)
      refused(r.text, name)
      assert.deepEqual(r.result, { status: 400, account: null, error: "pinned account not live" })
    }
    // Disabled in the file: not live either.
    const off = await through(e, { upstream: up.url, pin: { account: "b", mode: "pin" } })
    assert.equal(off.status, 400)
    refused(off.text, "b")
    assert.equal(up.seen.length, 0, "nothing went upstream")

    // A live hard pin still serves.
    const live = await through(e, { upstream: up.url, pin: { account: "a", mode: "pin" } })
    assert.equal(live.status, 200)
    assert.equal(up.seen[0].auth, "Bearer tok-a")
  } finally {
    await e.stop()
    await up.close()
  }
})

test("glue: a soft pin to an unknown account is served by the pool", async () => {
  const dir = scratch()
  const file = accountsFile(dir, [A()])
  const up = await fakeUpstream((_n, _s, res) => ok(res))
  const e = await boot(file)
  try {
    const r = await through(e, { upstream: up.url, pin: { account: "nobody@x.com", mode: "pool" } })
    assert.equal(r.status, 200)
    assert.equal(up.seen[0].auth, "Bearer tok-a")
    assert.deepEqual(r.result, { status: 200, account: "a", error: null })
  } finally {
    await e.stop()
    await up.close()
  }
})

test("glue: a soft pin to a removed or disabled account is served by the pool", async () => {
  const dir = scratch()
  const file = accountsFile(dir, [A(), B(), { ...C(), disabled: true }])
  const up = await fakeUpstream((_n, _s, res) => ok(res))
  const e = await boot(file)
  try {
    rewrite(file, [A(), { ...C(), disabled: true }])
    assert.deepEqual(await e.reload(), { added: 0, removed: 1 })
    for (const name of ["b", "c"]) {
      const r = await through(e, { upstream: up.url, pin: { account: name, mode: "pool" } })
      assert.equal(r.status, 200, name)
      assert.deepEqual(r.result, { status: 200, account: "a", error: null }, name)
    }
    assert.deepEqual(up.seen.map((s) => s.auth), ["Bearer tok-a", "Bearer tok-a"], "neither b's nor c's token left")
  } finally {
    await e.stop()
    await up.close()
  }
})

test("glue: the overage headers are the overage family and upgrade-paths, in any case, and not the quota headers", () => {
  assert.equal(isOverageHeader("anthropic-ratelimit-unified-overage-status"), true)
  assert.equal(isOverageHeader("Anthropic-Ratelimit-Unified-Upgrade-Paths"), true)
  assert.equal(isOverageHeader("anthropic-ratelimit-unified-5h-utilization"), false)
})

test("glue: quota state survives a restart", async () => {
  const dir = scratch()
  const file = accountsFile(dir, [A()])
  const reset = String(Math.floor(FAR / 1000))
  const up = await fakeUpstream((_n, _s, res) => ok(res, {
    "anthropic-ratelimit-unified-5h-utilization": "0.42",
    "anthropic-ratelimit-unified-5h-reset": reset,
    "anthropic-ratelimit-unified-7d-utilization": "0.17",
    "anthropic-ratelimit-unified-7d-reset": reset,
  }))
  const first = await boot(file)
  try {
    await through(first, { upstream: up.url })
    await first.persist()
  } finally {
    await first.stop()
    await up.close()
  }
  assert.ok(existsSync(path.join(dir, "accounts.state.json")), "state sits beside the accounts file")

  const second = await boot(file)
  try {
    const q = second.status().accounts[0].quota
    assert.equal(q.unified5h, 0.42)
    assert.equal(q.unified7d, 0.17)
  } finally {
    await second.stop()
  }
})

test("glue: the prober is on by default even with a loopback upstream", async () => {
  // An API-key account: served through the loopback upstream, never probed
  // (the prober reads only OAuth accounts), so nothing here leaves the machine.
  const dir = scratch()
  const file = accountsFile(dir, [{ name: "k", type: "apikey", apiKey: "sk-test" }])
  const up = await fakeUpstream((_n, _s, res) => ok(res))
  const e = await boot(file, { probeSeconds: undefined })
  try {
    const r = await through(e, { upstream: up.url })
    assert.equal(r.status, 200)
    assert.equal(up.seen[0].headers["x-api-key"], "sk-test")
    const p = await e.probe()
    assert.equal(p.enabled, true)
    assert.equal(p.intervalSeconds, DEFAULT_PROBE_SECONDS)
  } finally {
    await e.stop()
    await up.close()
  }

  // `probeSeconds: 0` is off; the file's quotaProbeSeconds wins over either.
  const off = await boot(file)
  try {
    assert.equal((await off.probe()).enabled, false)
  } finally {
    await off.stop()
  }
  const fileDir = scratch()
  const fileSays = accountsFile(fileDir, [{ name: "k", type: "apikey", apiKey: "sk-test" }], { quotaProbeSeconds: 120 })
  const won = await boot(fileSays)
  try {
    assert.equal((await won.probe()).intervalSeconds, 120)
  } finally {
    await won.stop()
  }
})

test("glue: a missing accounts file is created empty and private", async () => {
  const dir = path.join(scratch(), "config", "beacons")
  const file = path.join(dir, "accounts.json")
  const e = await boot(file)
  try {
    assert.deepEqual(rowsOf(file), [])
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.deepEqual(e.status().accounts, [])
  } finally {
    await e.stop()
  }
})
