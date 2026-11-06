// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer, Socket, type AddressInfo } from "node:net"
import { Chain, proxyAnswers } from "../src/chain.ts"
import { ANTHROPIC } from "../src/config.ts"

const PROXY = "http://127.0.0.1:9100/relay"
const down = async () => false
const up = async () => true

/** A TCP listener on loopback that counts the connections it takes, and the URL that names it. */
async function listener(): Promise<{ url: string; port: number; taken: () => number; close: () => Promise<void> }> {
  let n = 0
  const server = createServer((socket) => { n++; socket.destroy() })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}/relay`, port, taken: () => n, close: () => new Promise((r) => server.close(() => r())) }
}

test("chain: off for an Anthropic upstream", () => {
  const c = new Chain({ upstreamUrl: ANTHROPIC, fallback: "wait" })
  assert.equal(c.on, false)
  assert.deepEqual(c.upstreamFor(), { kind: "anthropic", url: ANTHROPIC })
})
test("chain: loopback hosts turn it on", () => {
  for (const u of ["http://127.0.0.1:9100", "http://localhost:9100/x"]) assert.equal(new Chain({ upstreamUrl: u, fallback: "wait" }).on, true, u)
  assert.equal(new Chain({ upstreamUrl: "http://example.com:9100", fallback: "wait" }).on, false)
  // The engine's egress allowlist has no ::1: a chain there would probe up and then refuse every request.
  assert.equal(new Chain({ upstreamUrl: "http://[::1]:9100", fallback: "wait" }).on, false)
})
test("chain: down with wait blocks", async () => {
  const c = new Chain({ upstreamUrl: PROXY, fallback: "wait", answers: down })
  assert.equal(c.state(), "unknown")
  assert.deepEqual(c.upstreamFor(), { kind: "chain", url: PROXY }, "before the first probe the chain is used")
  assert.equal(await c.probe(), "down")
  assert.deepEqual(c.upstreamFor(), { kind: "block", url: PROXY })
})
test("chain: direct goes to Anthropic while the proxy is down and back once it answers", async () => {
  let answering = false
  const asked: string[] = []
  const c = new Chain({ upstreamUrl: PROXY, fallback: "direct", answers: async (u) => { asked.push(u); return answering } })
  await c.probe()
  assert.deepEqual(c.upstreamFor(), { kind: "direct", url: ANTHROPIC })
  answering = true
  assert.equal(await c.probe(), "up")
  assert.deepEqual(c.upstreamFor(), { kind: "chain", url: PROXY })
  assert.deepEqual(asked, [PROXY, PROXY])
})
test("chain: a probe that fails reads as down", async () => {
  const c = new Chain({ upstreamUrl: PROXY, fallback: "wait", answers: async () => { throw new Error("boom") } })
  assert.equal(await c.probe(), "down")
})
test("chain: a chain that is off never probes", async () => {
  let n = 0
  const c = new Chain({ upstreamUrl: ANTHROPIC, fallback: "wait", answers: async () => { n++; return true } })
  c.start(); c.noteConnectFailure(); await c.probe(); c.stop()
  assert.equal(n, 0)
})
test("chain: noteConnectFailure probes at once, one in flight at a time", async () => {
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const c = new Chain({ upstreamUrl: PROXY, fallback: "wait", answers: async () => { calls++; await gate; return true } })
  c.noteConnectFailure(); c.noteConnectFailure(); c.noteConnectFailure()
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 1)
  release()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(c.state(), "up")
})
test("chain: the interval probes while started and stop ends it", async () => {
  let calls = 0
  const c = new Chain({ upstreamUrl: PROXY, fallback: "wait", answers: async () => { calls++; return true }, intervalMs: 20 })
  c.start()
  await new Promise((r) => setTimeout(r, 90))
  c.stop()
  const n = calls
  assert.ok(n >= 2, `calls ${n}`)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(calls, n)
})

// --- proxyAnswers: one TCP connection, on loopback only -------------------

test("proxyAnswers: up when something listens on the URL's port, whatever it speaks", async () => {
  const l = await listener()
  try {
    assert.equal(await proxyAnswers(l.url), true)
    assert.equal(await proxyAnswers(`http://127.0.0.1:${l.port}`), true)
    assert.equal(await new Chain({ upstreamUrl: l.url, fallback: "wait" }).probe(), "up")
    assert.ok(l.taken() >= 1)
  } finally {
    await l.close()
  }
})
test("proxyAnswers: down when nothing listens there", async () => {
  const l = await listener()
  await l.close()
  const t = Date.now()
  assert.equal(await proxyAnswers(l.url), false)
  assert.equal(await new Chain({ upstreamUrl: l.url, fallback: "wait" }).probe(), "down")
  assert.ok(Date.now() - t < 3000)
})
test("proxyAnswers: down for a URL that is not loopback, with no connection made", async () => {
  const l = await listener()
  try {
    for (const u of [`http://example.com:${l.port}`, `http://[::1]:${l.port}`, `http://10.0.0.1:${l.port}`, "not a url", ""]) {
      const t = Date.now()
      assert.equal(await proxyAnswers(u), false, u)
      assert.ok(Date.now() - t < 100, `${u} waited for an answer`)
    }
    assert.equal(l.taken(), 0)
  } finally {
    await l.close()
  }
})
test("proxyAnswers: a connection that never opens is down after the timeout, 1 s unless told, and is closed", async () => {
  const sockets: Socket[] = []
  const hang = (to: { host: string; port: number }) => {
    assert.deepEqual(to, { host: "127.0.0.1", port: 9100 })
    const s = new Socket() // never connected: neither "connect" nor "error" ever comes
    sockets.push(s)
    return s
  }
  let t = Date.now()
  assert.equal(await proxyAnswers(PROXY, { timeoutMs: 50, open: hang }), false)
  let took = Date.now() - t
  assert.ok(took >= 45 && took < 900, `took ${took} ms`)
  t = Date.now()
  assert.equal(await proxyAnswers(PROXY, { open: hang }), false)
  took = Date.now() - t
  assert.ok(took >= 950 && took < 2500, `took ${took} ms`)
  assert.ok(sockets.length === 2 && sockets.every((s) => s.destroyed))
})
test("proxyAnswers: a port no socket can open is down", async () => {
  assert.equal(await proxyAnswers("http://127.0.0.1:0"), false)
})
