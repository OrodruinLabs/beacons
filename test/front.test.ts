// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The front end to end: a real engine booted against an accounts file in a
// scratch dir, a scripted fake upstream on an ephemeral loopback port, and a
// chain stub that names it. No real credential, no network beyond 127.0.0.1,
// and every refresh goes to a stub. cc-gateway's trace rows have no beacons
// counterpart; what they asserted is read here from what the fake upstream saw,
// from the engine's status, and from `GET /beacons/v1/sessions/<id>`.
//
// One engine per process (TEAMCLAUDE_CONFIG is process-wide), so every test
// stops its engine before the next one boots, and the tests run in order.
import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import net from "node:net"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { bootEngine } from "../src/engine-glue.ts"
import type { Engine } from "../src/engine-glue.ts"
import type { Chain } from "../src/chain.ts"
import type { ControlDeps } from "../src/control.ts"
import { createFront } from "../src/front.ts"
import { SessionMap } from "../src/sessions.ts"
import type { Tokens } from "../src/engine/types.d.ts"

const FAR = Date.now() + 24 * 3_600_000
const scratch = () => mkdtempSync(path.join(tmpdir(), "beacons-"))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (pred: () => boolean, ms = 2000) => {
  const t = Date.now() + ms
  while (!pred() && Date.now() < t) await sleep(20)
  return pred()
}

type Seen = { auth: string | undefined; body: string; path: string; headers: http.IncomingHttpHeaders }
type Script = (n: number, seen: Seen, res: ServerResponse) => void

const sse = (res: ServerResponse) => {
  res.writeHead(200, { "content-type": "text/event-stream" })
  res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"cache_read_input_tokens":0}}}\n\n')
  res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n')
  res.end()
}
const fail = (res: ServerResponse, status: number, type: string, message: string, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers })
  res.end(JSON.stringify({ type: "error", error: { type, message } }))
}

function listen(srv: http.Server): Promise<number> {
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as AddressInfo).port)))
}
function shut(srv: http.Server): Promise<void> {
  srv.closeAllConnections()
  return new Promise((r) => srv.close(() => r()))
}

/** A scripted upstream: `script(n, seen, res)` answers the n-th request (1-based). */
async function fakeUpstream(script: Script): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = []
  const srv = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const s: Seen = {
        auth: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
        body: Buffer.concat(chunks).toString("utf8"),
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
const A_UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const A = (tok = "tok-A") => oauth("a@x", A_UUID, tok)
const B = (tok = "tok-B") => oauth("b@x", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", tok)
const C = () => oauth("c@x", "cccccccc-cccc-cccc-cccc-cccccccccccc", "tok-C")

const noRefresh = async (): Promise<never> => { throw new Error("this test refreshes nothing") }

type Upstream = ReturnType<Chain["upstreamFor"]>

/**
 * The front over a freshly booted engine. `upstream` is what the chain stub
 * answers: a plain URL is a live chain to it.
 */
async function gateway(o: { file: string; upstream: string | (() => Upstream); refreshFn?: (rt: string) => Promise<Tokens> }) {
  const engine: Engine = await bootEngine({ accountsFile: o.file, log: () => {}, refreshFn: o.refreshFn ?? noRefresh, probeSeconds: 0 })
  const sessions = new SessionMap()
  const upstreamFor = typeof o.upstream === "string" ? ((url: string) => () => ({ kind: "chain" as const, url }))(o.upstream) : o.upstream
  let connectFailures = 0
  const chain = { upstreamFor, noteConnectFailure: () => void (connectFailures += 1) }
  let port = 0
  let front: ReturnType<typeof createFront> | null = null
  const control: ControlDeps = {
    version: "0.0.0-test",
    engine,
    sessions,
    port: () => port,
    upstreamUrl: "http://127.0.0.1:1",
    routeFor: () => null,
    chain: () => undefined,
    inFlight: () => front?.inFlight() ?? 0,
    reload: () => engine.reload(),
    leave: () => {},
  }
  front = createFront({ cfg: { port: 0, upstreamUrl: control.upstreamUrl, chainFallback: "wait" }, engine, sessions, chain, control, log: () => {} })
  port = await listen(front.server)
  const f = front
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    engine,
    sessions,
    front: f,
    connectFailures: () => connectFailures,
    close: async () => {
      await shut(f.server)
      await engine.stop()
    },
  }
}

const PLACEHOLDER_UUID = "00000000-0000-0000-0000-000000000000"
const messages = (base: string, o: { path?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  fetch(`${base}${o.path ?? "/v1/messages"}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer the-clients-own", ...o.headers },
    body: JSON.stringify(o.body ?? {
      model: "claude-sonnet-5",
      stream: true,
      metadata: { user_id: JSON.stringify({ device_id: "d", account_uuid: PLACEHOLDER_UUID }) },
      messages: [{ role: "user", content: "hi" }],
    }),
  })

type SessionView = { session: { account: string; mode: "pool" | "pin"; first: string | null } | null; line: string }
const sessionOf = async (base: string, id: string): Promise<SessionView> =>
  (await (await fetch(`${base}/beacons/v1/sessions/${id}`)).json()) as SessionView
/** What the session map holds for `id`, as [account, mode, first], or null. */
const entryOf = async (base: string, id: string) => {
  const s = (await sessionOf(base, id)).session
  return s && [s.account, s.mode, s.first]
}

/**
 * One raw request on its own socket, for what `http.request` and `fetch` would
 * normalise or refuse to send. Resolves on the first full reply.
 */
function raw(port: number, text: string): Promise<{ status: number; headers: string; body: string }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(text))
    let buf = Buffer.alloc(0)
    const parse = (final: boolean) => {
      const end = buf.indexOf("\r\n\r\n")
      if (end < 0) return final ? reject(new Error(`no reply head: ${JSON.stringify(buf.toString())}`)) : undefined
      const head = buf.subarray(0, end).toString("latin1")
      const len = /\r\ncontent-length:\s*(\d+)/i.exec(head)
      const body = buf.subarray(end + 4)
      if (!final && (!len || body.length < Number(len[1]))) return
      s.destroy()
      resolve({ status: Number(head.split(" ")[1]), headers: head, body: body.toString("utf8") })
    }
    s.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      parse(false)
    })
    s.on("close", () => parse(true))
    s.on("error", () => {})
  })
}
const errorBody = (text: string) => JSON.parse(text) as { type: string; error: { type: string; message: string } }

// --- ported from cc-gateway test/direct.test.ts ---------------------------

test("front: the account's token goes upstream and the body's account_uuid follows it", async () => {
  const file = accountsFile(scratch(), [A()])
  const up = await fakeUpstream((_n, _s, res) => sse(res))
  const g = await gateway({ file, upstream: up.url })
  try {
    const res = await messages(g.base, { headers: { "x-claude-code-session-id": "sess-1" } })
    assert.equal(res.status, 200)
    await res.text()

    assert.equal(up.seen.length, 1)
    assert.equal(up.seen[0].auth, "Bearer tok-A", "the account's token, not the client's")
    assert.ok(up.seen[0].body.includes(A_UUID), "account_uuid rewritten to the serving account")
    assert.ok(!up.seen[0].body.includes(PLACEHOLDER_UUID), "the client's placeholder uuid must not reach upstream")
    assert.deepEqual(await entryOf(g.base, "sess-1"), ["a@x", "pool", null], "the engine chose, from the pool")
  } finally {
    await g.close()
    await up.close()
  }
})

test("front: a quota-spent 429 rotates to the next account; the client never sees it", async () => {
  const file = accountsFile(scratch(), [A(), B()])
  const up = await fakeUpstream((n, _s, res) => {
    if (n === 1) {
      return fail(res, 429, "rate_limit_error", "spent", {
        "retry-after": "3600",
        "anthropic-ratelimit-unified-5h-status": "rejected",
        "anthropic-ratelimit-unified-5h-utilization": "1.0",
      })
    }
    sse(res)
  })
  const g = await gateway({ file, upstream: up.url })
  try {
    const res = await messages(g.base, { headers: { "x-claude-code-session-id": "sess-q" } })
    assert.equal(res.status, 200)
    await res.text()
    assert.deepEqual(up.seen.map((s) => s.auth), ["Bearer tok-A", "Bearer tok-B"])
    assert.equal((await sessionOf(g.base, "sess-q")).session?.account, "b@x")
    const a = g.engine.status().accounts.find((x) => x.name === "a@x")
    assert.equal(a?.status, "throttled", "the spent account is held for its window")
  } finally {
    await g.close()
    await up.close()
  }
})

test("front: a per-minute 429 hops once to an idle sibling, never a third account, the cursor stays", async () => {
  const file = accountsFile(scratch(), [A(), B(), C()])
  const up = await fakeUpstream((n, _s, res) => {
    if (n === 1) return fail(res, 429, "rate_limit_error", "slow down", { "retry-after": "1", "anthropic-ratelimit-unified-status": "allowed" })
    sse(res)
  })
  const g = await gateway({ file, upstream: up.url })
  try {
    const res = await messages(g.base, { headers: { "x-claude-code-session-id": "sess-h" } })
    assert.equal(res.status, 200)
    await res.text()
    assert.deepEqual(up.seen.map((s) => s.auth), ["Bearer tok-A", "Bearer tok-B"], "one hop, to the idle sibling")
    assert.equal(g.engine.status().currentAccount, "a@x", "a detour is not a switch")
    assert.equal((await sessionOf(g.base, "sess-h")).session?.account, "b@x")
  } finally {
    await g.close()
    await up.close()
  }
})

test("front: a pinned route never hops, a 429 and a 529 stay on the pinned account", async () => {
  const file = accountsFile(scratch(), [A(), B()])
  const up = await fakeUpstream((_n, s, res) => {
    if (s.auth !== "Bearer tok-A") return sse(res)
    if (s.path.includes("count_tokens")) return fail(res, 529, "overloaded_error", "Overloaded")
    fail(res, 429, "rate_limit_error", "slow down", { "retry-after": "1", "anthropic-ratelimit-unified-status": "allowed" })
  })
  const g = await gateway({ file, upstream: up.url })
  try {
    const body = { model: "claude-sonnet-5", messages: [] }
    const headers = { "x-claude-code-session-id": "sess-p" }
    const limited = await messages(g.base, { path: "/pin/a%40x/v1/messages", body, headers })
    assert.equal(limited.status, 429)
    await limited.text()
    assert.deepEqual(await entryOf(g.base, "sess-p"), ["a@x", "pin", "a@x"])
    const over = await messages(g.base, { path: "/pin/a%40x/v1/messages/count_tokens", body, headers })
    assert.equal(over.status, 529)
    await over.text()
    assert.ok(up.seen.length >= 2)
    assert.ok(up.seen.every((s) => s.auth === "Bearer tok-A"), "nothing went out on b's token")
    assert.ok(up.seen.every((s) => s.path.startsWith("/v1/messages")), "the route prefix never goes upstream")
  } finally {
    await g.close()
    await up.close()
  }
})

test("front: reload picks up an account added to the file and one the file disables", async () => {
  const file = accountsFile(scratch(), [A()])
  const up = await fakeUpstream((_n, _s, res) => sse(res))
  const g = await gateway({ file, upstream: up.url })
  try {
    // A new row lands (what `login` does), then a reload through the control API.
    rewrite(file, [A(), B()])
    const added = await fetch(`${g.base}/beacons/v1/reload`, { method: "POST" })
    assert.deepEqual(await added.json(), { added: 1, removed: 0 })
    assert.equal(g.engine.status().accounts.length, 2)

    // The file disables a@x; the reload applies it.
    rewrite(file, [{ ...A(), disabled: true }, B()])
    const toggled = await fetch(`${g.base}/beacons/v1/reload`, { method: "POST" })
    assert.deepEqual(await toggled.json(), { added: 0, removed: 0 })
    const status = (await (await fetch(`${g.base}/beacons/v1/status`)).json()) as { accounts: { name: string; disabled: boolean }[] }
    assert.deepEqual(status.accounts.map((a) => [a.name, a.disabled]), [["a@x", true], ["b@x", false]])

    const res = await messages(g.base)
    assert.equal(res.status, 200)
    await res.text()
    assert.equal(up.seen[up.seen.length - 1].auth, "Bearer tok-B", "a disabled account is not served")
  } finally {
    await g.close()
    await up.close()
  }
})

// Not ported from cc-gateway's version: "a removed login's token lands nowhere".
// It calls the manager's updateAccountTokens on the removed index, an engine
// internal the front cannot reach. What is ported reads the file and status.
test("front: removing an account takes it out live and never shifts the others", async () => {
  const file = accountsFile(scratch(), [A(), B()])
  let revokeB = false
  const refreshed: string[] = []
  const refreshFn = async (r: string) => {
    refreshed.push(r)
    return { accessToken: "tok-B2", refreshToken: "r-tok-B2", expiresAt: FAR + 1000 }
  }
  const up = await fakeUpstream((_n, s, res) => {
    if (revokeB && s.auth === "Bearer tok-B") return fail(res, 401, "authentication_error", "revoked")
    sse(res)
  })
  const g = await gateway({ file, upstream: up.url, refreshFn })
  try {
    const before = await messages(g.base, { path: "/pin/a%40x/v1/messages" })
    await before.text()
    assert.equal(up.seen[0].auth, "Bearer tok-A", "pinned to a@x")

    // `logout` takes a@x out of the file; the reload takes it out of service.
    rewrite(file, [B()])
    assert.deepEqual(await (await fetch(`${g.base}/beacons/v1/reload`, { method: "POST" })).json(), { added: 0, removed: 1 })
    assert.deepEqual(g.engine.status().accounts.map((a) => a.name), ["b@x"])
    assert.equal(g.engine.status().currentAccount, "b@x")

    // A hard pin to it is refused, and nothing leaves on its token.
    const pinned = await messages(g.base, { path: "/pin/a%40x/v1/messages" })
    assert.equal(pinned.status, 400)
    assert.equal(errorBody(await pinned.text()).error.type, "invalid_request_error")
    assert.equal(up.seen.length, 1)

    const after = await messages(g.base)
    assert.equal(after.status, 200)
    await after.text()
    assert.equal(up.seen[up.seen.length - 1].auth, "Bearer tok-B", "the next request goes to the one left")

    // Nothing shifted: b@x's refresh is b@x's, and it lands in b@x's row.
    revokeB = true
    const refreshedB = await messages(g.base)
    assert.equal(refreshedB.status, 200)
    await refreshedB.text()
    assert.deepEqual(refreshed, ["r-tok-B"])
    assert.ok(await until(() => readFileSync(file, "utf8").includes("tok-B2")))
    assert.deepEqual(rowsOf(file).map((r) => [r.name, r.accessToken]), [["b@x", "tok-B2"]])

    // Logged in again: the same place, back in service, not added twice.
    rewrite(file, [B("tok-B2"), A("tok-A3")])
    assert.deepEqual(await (await fetch(`${g.base}/beacons/v1/reload`, { method: "POST" })).json(), { added: 0, removed: 0 })
    const back = g.engine.status().accounts.find((a) => a.name === "a@x")
    assert.ok(back && !back.disabled, "a re-added account serves again")
    assert.equal(g.engine.status().accounts.length, 2, "revived in place, not added twice")
    const again = await messages(g.base, { path: "/pin/a%40x/v1/messages" })
    assert.equal(again.status, 200)
    await again.text()
    assert.equal(up.seen[up.seen.length - 1].auth, "Bearer tok-A3")
  } finally {
    await g.close()
    await up.close()
  }
})

test("front: the client's own OAuth refresh passes through untouched; telemetry is absorbed", async () => {
  const file = accountsFile(scratch(), [A()])
  const up = await fakeUpstream((_n, _s, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end('{"ok":true}')
  })
  const g = await gateway({ file, upstream: `${up.url}/relay` })
  try {
    const tok = await fetch(`${g.base}/v1/oauth/token`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer the-clients-own" }, body: "{}",
    })
    assert.equal(tok.status, 200)
    assert.equal(await tok.text(), '{"ok":true}')
    assert.equal(up.seen[0].auth, "Bearer the-clients-own", "no account token injected on a passthrough path")
    assert.equal(up.seen[0].path, "/relay/v1/oauth/token", "the upstream's path is kept")
    assert.equal(up.seen[0].body, "{}")

    for (const p of ["/api/event_logging/batch", "/pool/a%40x/api/event_logging/batch"]) {
      const ev = await fetch(`${g.base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: '[{"event":"x"}]' })
      assert.equal(ev.status, 200, p)
      assert.deepEqual(await ev.json(), {})
    }
    assert.equal(up.seen.length, 1, "telemetry never reached upstream")
  } finally {
    await g.close()
    await up.close()
  }
})

test("front: a passthrough upload streams through the front, not buffered", async () => {
  const file = accountsFile(scratch(), [A()])
  let firstSeen: () => void = () => {}
  const first = new Promise<void>((r) => (firstSeen = r))
  const got: string[] = []
  const up = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => {
      if (chunks.length === 0) firstSeen()
      chunks.push(c)
    })
    req.on("end", () => {
      got.push(`${req.headers.authorization} ${Buffer.concat(chunks).toString()}`)
      res.writeHead(200, { "content-type": "application/json" })
      res.end('{"ok":true}')
    })
  })
  const upPort = await listen(up)
  const g = await gateway({ file, upstream: `http://127.0.0.1:${upPort}` })
  try {
    const req = http.request({ host: "127.0.0.1", port: g.port, method: "POST", path: "/pool/a%40x/api/oauth/file_upload", headers: { authorization: "Bearer the-clients-own" } })
    const status = new Promise<number>((resolve, reject) => {
      req.on("response", (res) => {
        res.resume()
        res.on("end", () => resolve(res.statusCode ?? 0))
      })
      req.on("error", reject)
    })
    status.catch(() => {})
    req.write("first-")
    const timedOut = sleep(3000).then(() => "timeout")
    assert.notEqual(await Promise.race([first.then(() => "first"), timedOut]), "timeout", "upstream saw the first chunk while the client still held the rest")
    req.end("last")
    assert.equal(await status, 200)
    assert.deepEqual(got, ["Bearer the-clients-own first-last"])
  } finally {
    await g.close()
    await shut(up)
  }
})

test("front: no accounts at all is a clean 429 with a reason, not a crash", async () => {
  const file = accountsFile(scratch(), [])
  const up = await fakeUpstream((_n, _s, res) => sse(res))
  const g = await gateway({ file, upstream: up.url })
  try {
    const res = await messages(g.base, { headers: { "x-claude-code-session-id": "sess-none" } })
    assert.equal(res.status, 429)
    const body = errorBody(await res.text())
    assert.match(body.error.message, /0 accounts|exhausted/i)
    assert.equal(up.seen.length, 0)
    assert.equal((await sessionOf(g.base, "sess-none")).session, null, "no account served, none recorded")
  } finally {
    await g.close()
    await up.close()
  }
})

// cc-gateway's fix, not upstream teamclaude's: the engine's tool-pair sanitizer
// judged a thread continue as a whole conversation and pruned its leading
// tool_result (its tool_use is held server-side).
test("front: a thread continue reaches upstream with its leading tool_result", async () => {
  const file = accountsFile(scratch(), [A()])
  const up = await fakeUpstream((_n, _s, res) => sse(res))
  const g = await gateway({ file, upstream: up.url })
  try {
    const res = await messages(g.base, {
      body: {
        model: "claude-sonnet-5", stream: true,
        thread: { type: "continue", previous_message_id: "msg_1" },
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_held", content: "ok" }] }],
      },
    })
    assert.equal(res.status, 200)
    await res.text()
    const sent = JSON.parse(up.seen[0].body) as { messages: unknown[] }
    assert.equal(sent.messages.length, 1)
    assert.ok(up.seen[0].body.includes("toolu_held"))
  } finally {
    await g.close()
    await up.close()
  }
})

test("front: a headerless 429 reaches the client with its reason, no invented retry-after, and pauses nothing", async () => {
  process.env.TEAMCLAUDE_HEADERLESS_429_RETRY_DELAY_MS = "20"
  const file = accountsFile(scratch(), [A(), B()])
  const up = await fakeUpstream((_n, _s, res) => fail(res, 429, "rate_limit_error", "This model is not available."))
  const g = await gateway({ file, upstream: up.url })
  try {
    const t0 = Date.now()
    const res = await messages(g.base)
    assert.equal(res.status, 429)
    assert.equal(res.headers.get("retry-after"), null)
    assert.match(await res.text(), /This model is not available/)
    assert.ok(Date.now() - t0 < 5_000, "no 60 s wait")
    assert.deepEqual(up.seen.map((s) => s.auth), ["Bearer tok-A", "Bearer tok-B", "Bearer tok-B"], "one hop, one retry where it landed")
    assert.deepEqual(g.engine.status().accounts.map((a) => a.pausedUntil), [null, null], "no account paused for a request's problem")
  } finally {
    delete process.env.TEAMCLAUDE_HEADERLESS_429_RETRY_DELAY_MS
    await g.close()
    await up.close()
  }
})

test("front: a 401 the refresh cannot cure fails over, the client never sees a 401", async () => {
  const file = accountsFile(scratch(), [A(), B()])
  const up = await fakeUpstream((_n, s, res) => {
    if (s.auth === "Bearer tok-B") return sse(res)
    fail(res, 401, "authentication_error", "invalid")
  })
  const refused = async (): Promise<never> => { throw Object.assign(new Error("the refresh is refused"), { status: 503 }) }
  const g = await gateway({ file, upstream: up.url, refreshFn: refused })
  try {
    const res = await messages(g.base, { headers: { "x-claude-code-session-id": "sess-401" } })
    assert.equal(res.status, 200)
    await res.text()
    assert.deepEqual(up.seen.map((s) => s.auth), ["Bearer tok-A", "Bearer tok-A", "Bearer tok-B"])
    assert.equal((await sessionOf(g.base, "sess-401")).session?.account, "b@x")
  } finally {
    await g.close()
    await up.close()
  }
})

test("front: per-org overage headers are stripped by default, kept with stripOverageHeaders: false, and quota is learned either way", async () => {
  const up = await fakeUpstream((_n, _s, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-overage-status": "rejected",
      "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
      "anthropic-ratelimit-unified-upgrade-paths": "max",
    })
    res.end('{"type":"message","content":[],"usage":{"input_tokens":1,"output_tokens":1}}')
  })
  try {
    for (const strip of [undefined, false]) {
      const file = accountsFile(scratch(), [A()], strip === undefined ? {} : { stripOverageHeaders: strip })
      const g = await gateway({ file, upstream: up.url })
      try {
        const res = await messages(g.base)
        await res.text()
        const kept = strip === false
        assert.equal(res.headers.get("anthropic-ratelimit-unified-overage-status"), kept ? "rejected" : null, String(strip))
        assert.equal(res.headers.get("anthropic-ratelimit-unified-upgrade-paths"), kept ? "max" : null)
        assert.equal(res.headers.get("anthropic-ratelimit-unified-5h-utilization"), "0.42", "the rest of the family stays")
        assert.equal(g.engine.status().accounts[0].quota.unified5h, 0.42, "the engine read the quota first")
      } finally {
        await g.close()
      }
    }
  } finally {
    await up.close()
  }
})

// --- beacons' own -----------------------------------------------------------

test("front: an email-named pin reaches that account", async () => {
  const file = accountsFile(scratch(), [oauth("x@y.com", "11111111-1111-1111-1111-111111111111", "tok-XY"), oauth("a@b.com", "22222222-2222-2222-2222-222222222222", "tok-AB")])
  const up = await fakeUpstream((_n, _s, res) => sse(res))
  const g = await gateway({ file, upstream: up.url })
  try {
    for (const p of ["/pin/a%40b.com/v1/messages", "/pool/a%40b.com/v1/messages"]) {
      const res = await messages(g.base, { path: p, headers: { "x-claude-code-session-id": "sess-mail" } })
      assert.equal(res.status, 200, p)
      await res.text()
      assert.equal(up.seen[up.seen.length - 1].auth, "Bearer tok-AB", p)
      assert.equal(up.seen[up.seen.length - 1].path, "/v1/messages", p)
      assert.equal((await sessionOf(g.base, "sess-mail")).session?.first, "a@b.com", p)
    }
  } finally {
    await g.close()
    await up.close()
  }
})

test("front: a failed-over continue relays 404 thread_not_found untouched", async () => {
  const notFound = '{"type":"error","error":{"type":"not_found_error","message":"thread_not_found"}}'
  const file = accountsFile(scratch(), [A(), B()])
  const up = await fakeUpstream((_n, s, res) => {
    if (s.auth === "Bearer tok-A") {
      return fail(res, 429, "rate_limit_error", "spent", {
        "retry-after": "3600",
        "anthropic-ratelimit-unified-5h-status": "rejected",
        "anthropic-ratelimit-unified-5h-utilization": "1.0",
      })
    }
    res.writeHead(404, { "content-type": "application/json" })
    res.end(notFound)
  })
  const g = await gateway({ file, upstream: up.url })
  try {
    const res = await messages(g.base, {
      body: {
        model: "claude-sonnet-5", stream: true,
        thread: { type: "continue", previous_message_id: "msg_1" },
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_held", content: "ok" }] }],
      },
    })
    assert.equal(res.status, 404)
    assert.equal(await res.text(), notFound)
    assert.deepEqual(up.seen.map((s) => s.auth), ["Bearer tok-A", "Bearer tok-B"])
  } finally {
    await g.close()
    await up.close()
  }
})

// The routing half of teamclaude #532, which this engine never needed: neither
// routing mode keys a continue on its delta. The fake upstream keeps each thread
// with the token that answered it and refuses a continue from any other, as
// Anthropic does.
test("front: a thread continue reaches the account holding its thread, distributeSessions off and on", async () => {
  const threadUpstream = () => {
    const holder = new Map<string, string | undefined>()
    return fakeUpstream((n, s, res) => {
      const { thread } = JSON.parse(s.body) as { thread?: { type: string; previous_message_id?: string } }
      if (thread?.type === "continue" && holder.get(thread.previous_message_id ?? "") !== s.auth) {
        return fail(res, 404, "not_found_error", "thread_not_found")
      }
      const id = `msg_${n}`
      holder.set(id, s.auth)
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, usage: { input_tokens: 7 } } })}\n\n`)
      res.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n')
    })
  }
  /** One turn of `session`'s thread; resolves to the id of the message that answered it. */
  const turn = async (base: string, session: string, previous: string | null) => {
    const res = await messages(base, {
      headers: { "x-claude-code-session-id": session },
      body: previous === null
        ? { model: "claude-sonnet-5", stream: true, thread: { type: "create" }, messages: [{ role: "user", content: "task" }] }
        : {
          model: "claude-sonnet-5", stream: true,
          thread: { type: "continue", previous_message_id: previous },
          messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_held", content: "ok" }] }],
        },
    })
    const text = await res.text()
    assert.equal(res.status, 200, text)
    return /"id":"(msg_\d+)"/.exec(text)?.[1] ?? ""
  }

  // Off, beacons' default: every request follows the one current account.
  let up = await threadUpstream()
  let g = await gateway({ file: accountsFile(scratch(), [A(), B()]), upstream: up.url })
  try {
    await turn(g.base, "sess-t1", await turn(g.base, "sess-t1", null))
    assert.deepEqual(up.seen.map((s) => s.auth), ["Bearer tok-A", "Bearer tok-A"])
  } finally {
    await g.close()
    await up.close()
  }

  // On: a new session goes to the least-loaded account, and each session's
  // continue stays where its create went.
  up = await threadUpstream()
  g = await gateway({ file: accountsFile(scratch(), [A(), B()], { distributeSessions: true }), upstream: up.url })
  try {
    const one = await turn(g.base, "sess-t1", null)
    const two = await turn(g.base, "sess-t2", null)
    await turn(g.base, "sess-t1", one)
    await turn(g.base, "sess-t2", two)
    assert.deepEqual(up.seen.map((s) => s.auth), ["Bearer tok-A", "Bearer tok-B", "Bearer tok-A", "Bearer tok-B"])
  } finally {
    await g.close()
    await up.close()
  }
})

test("front: a browser origin is refused before the body is read", async () => {
  const file = accountsFile(scratch(), [A()])
  const up = await fakeUpstream((_n, _s, res) => sse(res))
  const g = await gateway({ file, upstream: up.url })
  try {
    // Each declares a body it never sends: a reply at all means none was waited for.
    const pages = [
      `Host: 127.0.0.1:${g.port}\r\nOrigin: https://evil.example`,
      `Host: 127.0.0.1:${g.port}\r\nSec-Fetch-Site: cross-site`,
      `Host: evil.example:${g.port}`,
    ]
    for (const h of pages) {
      const r = await raw(g.port, `POST /v1/messages HTTP/1.1\r\n${h}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n`)
      assert.equal(r.status, 403, h)
      const j = errorBody(r.body)
      assert.equal(j.type, "error")
      assert.equal(j.error.type, "permission_error")
    }
    assert.equal(up.seen.length, 0)
  } finally {
    await g.close()
    await up.close()
  }
})

test("front: the session map records account, mode and first choice", async () => {
  const file = accountsFile(scratch(), [A(), B()])
  let spendA = false
  const up = await fakeUpstream((_n, s, res) => {
    if (spendA && s.auth === "Bearer tok-A") {
      return fail(res, 429, "rate_limit_error", "spent", {
        "retry-after": "3600",
        "anthropic-ratelimit-unified-5h-status": "rejected",
        "anthropic-ratelimit-unified-5h-utilization": "1.0",
      })
    }
    sse(res)
  })
  const g = await gateway({ file, upstream: up.url })
  const send = async (p: string, id: string) => {
    const res = await messages(g.base, { path: p, headers: { "x-claude-code-session-id": id } })
    assert.equal(res.status, 200, p)
    await res.text()
    return sessionOf(g.base, id)
  }
  try {
    const bare = await send("/v1/messages", "s-bare")
    assert.deepEqual([bare.session?.account, bare.session?.mode, bare.session?.first], ["a@x", "pool", null])

    const pool = await send("/pool/a%40x/v1/messages", "s-pool")
    assert.deepEqual([pool.session?.account, pool.session?.mode, pool.session?.first], ["a@x", "pool", "a@x"])
    assert.equal(pool.line, "◔ beacons a@x")

    const pin = await send("/pin/b%40x/v1/messages", "s-pin")
    assert.deepEqual([pin.session?.account, pin.session?.mode, pin.session?.first], ["b@x", "pin", "b@x"])
    assert.equal(pin.line, "◔ beacons b@x")

    // The first choice is spent: the pool fails over, and the session says so.
    spendA = true
    const over = await send("/pool/a%40x/v1/messages", "s-pool")
    assert.deepEqual([over.session?.account, over.session?.mode, over.session?.first], ["b@x", "pool", "a@x"])
    assert.equal(over.line, "◑ beacons b@x")

    // No session header: served, nothing recorded.
    const anon = await messages(g.base)
    assert.equal(anon.status, 200)
    await anon.text()
    assert.deepEqual(g.sessions.list().map((e) => e.id).sort(), ["s-bare", "s-pin", "s-pool"])
  } finally {
    await g.close()
    await up.close()
  }
})

test("front: chain down with wait answers 503 naming the upstream proxy", async () => {
  const file = accountsFile(scratch(), [A()])
  const proxy = await fakeUpstream((_n, _s, res) => sse(res))
  const origin = proxy.url
  const g = await gateway({ file, upstream: () => ({ kind: "block", url: `${proxy.url}/relay` }) })
  try {
    for (const p of ["/v1/messages", "/pin/a%40x/v1/messages", "/v1/oauth/token"]) {
      const res = await messages(g.base, { path: p })
      assert.equal(res.status, 503, p)
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/)
      const j = errorBody(await res.text())
      assert.equal(j.type, "error", p)
      assert.equal(j.error.type, "api_error", p)
      assert.ok(j.error.message.includes(`proxy at ${origin} `), j.error.message)
    }
    assert.equal(proxy.seen.length, 0, "nothing reached the chain")
  } finally {
    await g.close()
    await proxy.close()
  }
})

test("front: chain down with direct serves from the direct URL", async () => {
  const file = accountsFile(scratch(), [A()])
  const proxy = await fakeUpstream((_n, _s, res) => sse(res))
  const direct = await fakeUpstream((_n, _s, res) => sse(res))
  const g = await gateway({ file, upstream: () => ({ kind: "direct", url: direct.url }) })
  try {
    const res = await messages(g.base)
    assert.equal(res.status, 200)
    await res.text()
    assert.equal(direct.seen.length, 1)
    assert.equal(direct.seen[0].auth, "Bearer tok-A")
    assert.equal(proxy.seen.length, 0)
  } finally {
    await g.close()
    await proxy.close()
    await direct.close()
  }
})

test("front: a request target that is not origin-form is refused with 400 and nothing is forwarded", async () => {
  const file = accountsFile(scratch(), [A()])
  const up = await fakeUpstream((_n, _s, res) => sse(res))
  const g = await gateway({ file, upstream: up.url })
  try {
    const targets = [
      "@evil.example/v1/messages",
      "//evil.example/v1/messages",
      "/pool/a//evil.example/v1/messages",
      "/pin/a%40x//evil.example/v1/messages",
      "http://evil.example/v1/messages",
      "*",
      // A URL parser reads "\" as "/": these would join to an upstream as "//evil.example/...".
      "/\\evil.example/v1/messages",
      "/pool/a/\\evil.example/v1/messages",
      "/pin/a%40x/\\evil.example/v1/messages",
      "/v1/messages\\x",
    ]
    for (const t of targets) {
      const r = await raw(g.port, `POST ${t} HTTP/1.1\r\nHost: 127.0.0.1:${g.port}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`)
      assert.equal(r.status, 400, t)
      const j = errorBody(r.body)
      assert.equal(j.type, "error", t)
      assert.equal(j.error.type, "invalid_request_error", t)
    }
    assert.equal(up.seen.length, 0)
  } finally {
    await g.close()
    await up.close()
  }
})

test("front: CONNECT is refused with 400 and nothing is forwarded", async () => {
  const file = accountsFile(scratch(), [A()])
  const up = await fakeUpstream((_n, _s, res) => sse(res))
  const g = await gateway({ file, upstream: up.url })
  try {
    for (const target of ["evil.example:443", `127.0.0.1:${new URL(up.url).port}`]) {
      const r = await raw(g.port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)
      assert.equal(r.status, 400, target)
      const j = errorBody(r.body)
      assert.equal(j.type, "error", target)
      assert.equal(j.error.type, "invalid_request_error", target)
    }
    assert.equal(up.seen.length, 0)
    assert.equal(g.front.inFlight(), 0)
  } finally {
    await g.close()
    await up.close()
  }
})

test("front: OPTIONS is answered 204 with no CORS grant and never forwarded", async () => {
  const file = accountsFile(scratch(), [A()])
  const up = await fakeUpstream((_n, _s, res) => sse(res))
  const g = await gateway({ file, upstream: up.url })
  try {
    for (const p of ["/v1/messages", "/pool/a%40x/v1/messages"]) {
      const res = await fetch(`${g.base}${p}`, { method: "OPTIONS", headers: { "access-control-request-method": "POST" } })
      assert.equal(res.status, 204, p)
      assert.deepEqual([...res.headers.keys()].filter((k) => k.startsWith("access-control-")), [], p)
    }
    assert.equal(up.seen.length, 0)
  } finally {
    await g.close()
    await up.close()
  }
})

test("front: a model call body over 32 MiB is refused with 413 and nothing is forwarded", async () => {
  const file = accountsFile(scratch(), [A()])
  const up = await fakeUpstream((_n, _s, res) => sse(res))
  const g = await gateway({ file, upstream: up.url })
  try {
    // Declared too large: refused from the head alone.
    const declared = await raw(g.port, `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${g.port}\r\nContent-Type: application/json\r\nContent-Length: ${32 * 1024 * 1024 + 1}\r\n\r\n`)
    assert.equal(declared.status, 413)
    assert.equal(errorBody(declared.body).error.type, "request_too_large")

    // Chunked past the cap: refused once it gets there (or cut while sending).
    const status = await new Promise<number | null>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: g.port, method: "POST", path: "/v1/messages", headers: { "content-type": "application/json" } })
      req.on("response", (res) => {
        res.resume()
        resolve(res.statusCode ?? null)
      })
      req.on("error", () => resolve(null))
      const mib = Buffer.alloc(1024 * 1024, 0x20)
      for (let i = 0; i < 33; i++) req.write(mib)
      req.end()
    })
    assert.ok(status === null || status === 413, String(status))
    assert.equal(up.seen.length, 0)

    // Under the cap still serves.
    const ok = await messages(g.base)
    assert.equal(ok.status, 200)
    await ok.text()
  } finally {
    await g.close()
    await up.close()
  }
})

test("front: a refused connect upstream asks the chain to look again", async () => {
  const file = accountsFile(scratch(), [A()])
  const dead = await fakeUpstream((_n, _s, res) => sse(res))
  await dead.close()
  const g = await gateway({ file, upstream: dead.url })
  try {
    await assert.rejects(messages(g.base).then((r) => r.text()), "the engine resets the client's socket")
    assert.ok(await until(() => g.connectFailures() === 1), "served path")
    const tok = await fetch(`${g.base}/v1/oauth/token`, { method: "POST", body: "{}" })
    assert.equal(tok.status, 502)
    await tok.text()
    assert.ok(await until(() => g.connectFailures() === 2), "passthrough path")
  } finally {
    await g.close()
  }
})

test("front: inFlight counts open replies but not control requests, and drain waits for them", async () => {
  const file = accountsFile(scratch(), [A()])
  let release: () => void = () => {}
  const up = await fakeUpstream((_n, _s, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write('event: ping\ndata: {}\n\n')
    release = () => {
      res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n')
      res.end()
    }
  })
  const g = await gateway({ file, upstream: up.url })
  try {
    assert.equal(g.front.inFlight(), 0)
    const pending = messages(g.base)
    assert.ok(await until(() => g.front.inFlight() === 1))
    const health = await fetch(`${g.base}/beacons/v1/health`)
    assert.equal(health.status, 200)
    await health.text()
    assert.equal(g.front.inFlight(), 1, "a control request is not counted")

    let drained = false
    const draining = g.front.drain({ capMs: 5000 }).then(() => (drained = true))
    // New connections are refused at once.
    await assert.rejects(
      new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port: g.port, path: "/beacons/v1/health", agent: false }, resolve).on("error", reject)),
    )
    await sleep(50)
    assert.equal(drained, false, "drain waits for the reply in flight")
    release()
    const res = await pending
    assert.equal(res.status, 200)
    assert.match(await res.text(), /message_delta/)
    await draining
    assert.equal(g.front.inFlight(), 0)
  } finally {
    release()
    await g.close().catch(() => {})
    await up.close()
  }
})

test("front: drain past its cap cuts what is still open", async () => {
  const file = accountsFile(scratch(), [A()])
  const up = await fakeUpstream((_n, _s, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write('event: ping\ndata: {}\n\n')
  })
  const g = await gateway({ file, upstream: up.url })
  try {
    const res = await messages(g.base)
    assert.equal(res.status, 200)
    assert.equal(g.front.inFlight(), 1)
    const t0 = Date.now()
    await g.front.drain({ capMs: 150 })
    const took = Date.now() - t0
    assert.ok(took >= 140 && took < 2000, `drain took ${took} ms`)
    await assert.rejects(res.text(), "the open reply is cut")
    assert.ok(await until(() => g.front.inFlight() === 0))
  } finally {
    await g.close().catch(() => {})
    await up.close()
  }
})

/** A GET on `agent`; on a keep-alive agent a `connection: close` in the answer is the server's choice. */
function getVia(port: number, p: string, agent: http.Agent | false): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: p, agent }, (res) => {
        res.resume()
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }))
      })
      .on("error", reject)
  })
}

test("front: leaving marks every reply connection: close and closes the listener the instant nothing is open", async () => {
  const file = accountsFile(scratch(), [A()])
  let release: () => void = () => {}
  const up = await fakeUpstream((_n, _s, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write('event: ping\ndata: {}\n\n')
    release = () => {
      res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n')
      res.end()
    }
  })
  const g = await gateway({ file, upstream: up.url })
  const agent = new http.Agent({ keepAlive: true })
  try {
    const before = await getVia(g.port, "/beacons/v1/health", agent)
    assert.equal(before.headers.connection, "keep-alive", "a keep-alive request stays open while serving")

    const pending = messages(g.base)
    assert.ok(await until(() => g.front.inFlight() === 1))
    let quiet = false
    const leaving = g.front.leaving().then(() => (quiet = true))

    // While a reply is open the listener still takes requests, and each answer closes its connection.
    const during = await getVia(g.port, "/beacons/v1/health", agent)
    assert.equal(during.status, 200)
    assert.equal(during.headers.connection, "close")
    const fresh = await getVia(g.port, "/beacons/v1/health", false)
    assert.equal(fresh.status, 200, "a new connection is still accepted")
    await sleep(50)
    assert.equal(quiet, false, "it waits for the open reply")

    release()
    const res = await pending
    assert.match(await res.text(), /message_delta/)
    await leaving
    assert.equal(quiet, true)
    await assert.rejects(getVia(g.port, "/beacons/v1/health", false), "the listener is closed")
  } finally {
    release()
    agent.destroy()
    await g.close().catch(() => {})
    await up.close()
  }
})

test("front: leaving with nothing open closes the listener at once", async () => {
  const file = accountsFile(scratch(), [A()])
  const g = await gateway({ file, upstream: "http://127.0.0.1:1" })
  try {
    assert.equal(g.front.inFlight(), 0)
    await g.front.leaving()
    await assert.rejects(getVia(g.port, "/beacons/v1/health", false))
  } finally {
    await g.close().catch(() => {})
  }
})
