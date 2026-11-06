// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { isPassthrough, passthroughTarget, forwardPassthrough } from "../src/passthrough.ts"

type Seen = { headers: http.IncomingHttpHeaders; url: string; body: string }

async function listen(h: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(h)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  return { server, port: (server.address() as AddressInfo).port }
}
const close = (s: http.Server) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()) })

function readAll(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((res) => {
    const c: Buffer[] = []
    req.on("data", (d) => c.push(d))
    req.on("end", () => res(Buffer.concat(c)))
  })
}

/** A front that forwards every request to `targetOf(port)`, and records the result. */
async function front(targetOf: () => URL) {
  const results: Array<{ status: number | null; error: string | null }> = []
  const f = await listen(async (req, res) => {
    const body = await readAll(req)
    results.push(await forwardPassthrough({ req, res, body, target: targetOf() }))
  })
  return { ...f, results }
}

/** A front that hands each request over unread, so its body streams. */
async function streamingFront(targetOf: () => URL) {
  const results: Array<{ status: number | null; error: string | null }> = []
  const f = await listen(async (req, res) => {
    results.push(await forwardPassthrough({ req, res, target: targetOf() }))
  })
  return { ...f, results }
}

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_r, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms))])

/** An upstream that signals its first body chunk, then answers with what it got. */
async function uploadSink(onFirst: (req: http.IncomingMessage) => void = () => {}) {
  let firstSeen: () => void = () => {}
  const first = new Promise<void>((r) => (firstSeen = r))
  const got: Seen[] = []
  const up = await listen((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => {
      if (chunks.length === 0) {
        firstSeen()
        onFirst(req)
      }
      chunks.push(c)
    })
    req.on("end", () => {
      got.push({ headers: req.headers, url: req.url!, body: Buffer.concat(chunks).toString() })
      res.writeHead(200, { "content-type": "application/json" })
      res.end('{"ok":true}')
    })
  })
  return { ...up, first, got }
}

/** Starts an upload with its first chunk written; `rest` finishes it. */
function startUpload(port: number, headers: Record<string, string>) {
  const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/oauth/file_upload", headers })
  const reply = new Promise<{ status: number; text: string }>((resolve, reject) => {
    req.on("response", (res) => {
      let text = ""
      res.on("data", (d) => (text += d))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on("error", reject)
  })
  req.write("first-")
  return { req, reply }
}

test("passthrough: only the four paths are passthrough", () => {
  for (const p of ["/v1/oauth/token", "/v1/code/x", "/api/oauth/files/abc", "/api/oauth/file_upload"]) assert.equal(isPassthrough(p), true, p)
  for (const p of ["/v1/messages", "/", "/v1/oauth"]) assert.equal(isPassthrough(p), false, p)
})

test("passthrough: the upstream path is kept", () => {
  assert.equal(passthroughTarget("http://127.0.0.1:9100/relay", "/v1/oauth/token").href, "http://127.0.0.1:9100/relay/v1/oauth/token")
  assert.equal(passthroughTarget("http://127.0.0.1:9100/relay/", "/v1/oauth/token?x=1").href, "http://127.0.0.1:9100/relay/v1/oauth/token?x=1")
  assert.equal(passthroughTarget("https://api.anthropic.com", "/v1/oauth/token").href, "https://api.anthropic.com/v1/oauth/token")
})

test("passthrough: a url starting with // cannot change the host", () => {
  const t = passthroughTarget("https://api.anthropic.com", "//evil.com/v1/oauth/token")
  assert.equal(t.host, "api.anthropic.com")
})

test("passthrough: the client's own authorization reaches upstream untouched", async () => {
  let seen: Seen | null = null
  const up = await listen(async (req, res) => {
    seen = { headers: req.headers, url: req.url!, body: (await readAll(req)).toString() }
    res.writeHead(200, { "content-type": "application/json", connection: "close" })
    res.end('{"ok":true}')
  })
  const f = await front(() => passthroughTarget(`http://127.0.0.1:${up.port}/relay`, "/v1/oauth/token?a=1"))
  try {
    const r = await fetch(`http://127.0.0.1:${f.port}/v1/oauth/token?a=1`, {
      method: "POST",
      headers: { authorization: "Bearer client", "content-type": "application/json", "x-api-key": "k", connection: "keep-alive" },
      body: '{"grant_type":"refresh_token"}',
    })
    assert.equal(r.status, 200)
    assert.equal(await r.text(), '{"ok":true}')
    const s = seen as unknown as Seen
    assert.equal(s.headers.authorization, "Bearer client")
    assert.equal(s.headers["x-api-key"], "k")
    assert.equal(s.headers.host, `127.0.0.1:${up.port}`)
    assert.equal(s.url, "/relay/v1/oauth/token?a=1")
    assert.equal(s.body, '{"grant_type":"refresh_token"}')
    assert.deepEqual(f.results, [{ status: 200, error: null }])
  } finally {
    await close(f.server)
    await close(up.server)
  }
})

test("passthrough: a host off the allowlist is refused before any socket opens", async () => {
  let called = 0
  const up = await listen((_req, res) => { called++; res.end() })
  const f = await front(() => new URL("https://example.com/v1/oauth/token"))
  try {
    const r = await fetch(`http://127.0.0.1:${f.port}/v1/oauth/token`, { method: "POST", body: "x" })
    assert.equal(r.status, 502)
    const j = (await r.json()) as { type: string; error: { type: string; message: string } }
    assert.equal(j.type, "error")
    assert.equal(j.error.type, "api_error")
    assert.equal(j.error.message, "egress to example.com refused")
    assert.equal(called, 0)
    assert.equal(f.results[0].status, 502)
    assert.ok(f.results[0].error)
  } finally {
    await close(f.server)
    await close(up.server)
  }
})

test("passthrough: a refused connection answers 502 api_error with status null", async () => {
  const dead = await listen((_q, r) => r.end())
  const deadPort = dead.port
  await close(dead.server)
  const f = await front(() => new URL(`http://127.0.0.1:${deadPort}/v1/oauth/token`))
  try {
    const r = await fetch(`http://127.0.0.1:${f.port}/v1/oauth/token`, { method: "POST", body: "x" })
    assert.equal(r.status, 502)
    const j = (await r.json()) as { type: string; error: { type: string } }
    assert.equal(j.type, "error")
    assert.equal(j.error.type, "api_error")
    assert.equal(f.results[0].status, null)
    assert.ok(f.results[0].error)
  } finally {
    await close(f.server)
  }
})

test("passthrough: hop-by-hop headers are not forwarded", async () => {
  let seen: Seen | null = null
  const up = await listen(async (req, res) => {
    seen = { headers: req.headers, url: req.url!, body: "" }
    await readAll(req)
    res.end("ok")
  })
  const f = await front(() => new URL(`http://127.0.0.1:${up.port}/v1/oauth/token`))
  try {
    await fetch(`http://127.0.0.1:${f.port}/v1/oauth/token`, { method: "POST", body: "x", headers: { te: "trailers", "proxy-authorization": "p" } })
    const s = seen as unknown as Seen
    assert.equal(s.headers["proxy-authorization"], undefined)
    assert.equal(s.headers.te, undefined)
  } finally {
    await close(f.server)
    await close(up.server)
  }
})

test("passthrough: a request body is streamed, not buffered", async () => {
  const up = await uploadSink()
  const f = await streamingFront(() => new URL(`http://127.0.0.1:${up.port}/api/oauth/file_upload`))
  try {
    // Chunked: the client holds back the rest of its body until upstream has the
    // first chunk. A front that buffered would wait for the end that never comes.
    const chunked = startUpload(f.port, { "content-type": "application/octet-stream", authorization: "Bearer client" })
    await within(up.first, 3000, "upstream never saw the first chunk before the client finished")
    chunked.req.end("last")
    assert.deepEqual(await chunked.reply, { status: 200, text: '{"ok":true}' })
    assert.equal(up.got[0].body, "first-last")
    assert.equal(up.got[0].headers["transfer-encoding"], "chunked")
    assert.equal(up.got[0].headers.authorization, "Bearer client")

    // A declared length goes upstream as declared.
    const up2 = await uploadSink()
    const f2 = await streamingFront(() => new URL(`http://127.0.0.1:${up2.port}/api/oauth/file_upload`))
    try {
      const sized = startUpload(f2.port, { "content-type": "application/octet-stream", "content-length": "10" })
      await within(up2.first, 3000, "upstream never saw the first chunk of a sized body")
      sized.req.end("last")
      assert.equal((await sized.reply).status, 200)
      assert.equal(up2.got[0].body, "first-last")
      assert.equal(up2.got[0].headers["content-length"], "10")
      assert.deepEqual(f2.results, [{ status: 200, error: null }])
    } finally {
      await close(f2.server)
      await close(up2.server)
    }
    assert.deepEqual(f.results, [{ status: 200, error: null }])
  } finally {
    await close(f.server)
    await close(up.server)
  }
})

test("passthrough: a client that leaves mid-upload takes the upstream request with it", async () => {
  let upClosed: (complete: boolean) => void = () => {}
  const closed = new Promise<boolean>((r) => (upClosed = r))
  const up = await uploadSink((req) => req.on("close", () => upClosed(req.complete)))
  const f = await streamingFront(() => new URL(`http://127.0.0.1:${up.port}/api/oauth/file_upload`))
  try {
    const u = startUpload(f.port, { "content-type": "application/octet-stream" })
    u.reply.catch(() => {})
    await within(up.first, 3000, "upstream never saw the first chunk")
    u.req.destroy()
    assert.equal(await within(closed, 3000, "the upstream request was left open"), false, "upstream saw an unfinished upload end")
    for (let i = 0; i < 100 && f.results.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(f.results, [{ status: null, error: "the client went away" }], "not reported as a connect failure")
    assert.equal(up.got.length, 0)
  } finally {
    await close(f.server)
    await close(up.server)
  }
})

test("passthrough: an upstream that fails mid-upload answers 502 api_error", async () => {
  const up = await uploadSink((req) => req.socket.destroy())
  const f = await streamingFront(() => new URL(`http://127.0.0.1:${up.port}/api/oauth/file_upload`))
  try {
    const u = startUpload(f.port, { "content-type": "application/octet-stream" })
    const r = await within(u.reply, 3000, "no reply after the upstream failed")
    u.req.end("last")
    assert.equal(r.status, 502)
    const j = JSON.parse(r.text) as { type: string; error: { type: string } }
    assert.equal(j.type, "error")
    assert.equal(j.error.type, "api_error")
    assert.equal(f.results[0].status, null)
    assert.ok(f.results[0].error)
  } finally {
    await close(f.server)
    await close(up.server)
  }
})

test("passthrough: an upstream reply cut after its head is cut for the client too", async () => {
  // Two ways a reply stops short: a reset, and a clean close before the declared length.
  const cuts: Array<(res: http.ServerResponse) => void> = [
    (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write("event: ping\ndata: {}\n\n")
      setTimeout(() => res.socket?.destroy(), 30)
    },
    (res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "100" })
      res.write('{"partial":')
      setTimeout(() => res.socket?.end(), 30)
    },
  ]
  for (const [i, cut] of cuts.entries()) {
    const up = await listen(async (req, res) => {
      await readAll(req)
      cut(res)
    })
    const f = await streamingFront(() => new URL(`http://127.0.0.1:${up.port}/v1/oauth/token`))
    try {
      const outcome = await within(
        new Promise<string>((resolve) => {
          const req = http.request({ host: "127.0.0.1", port: f.port, method: "POST", path: "/v1/oauth/token" }, (res) => {
            res.on("end", () => resolve(res.complete ? "clean end" : "cut"))
            res.on("aborted", () => resolve("cut"))
            res.on("error", () => resolve("cut"))
            res.on("close", () => resolve(res.complete ? "clean end" : "cut"))
            res.resume()
          })
          req.on("error", () => resolve("cut"))
          req.end("x")
        }),
        3000,
        "the client was left waiting",
      )
      assert.equal(outcome, "cut", `case ${i}: the client must not see a complete reply`)
      for (let n = 0; n < 100 && f.results.length === 0; n++) await new Promise((r) => setTimeout(r, 20))
      assert.equal(f.results[0]?.status, 200, `case ${i}`)
      assert.match(f.results[0]?.error ?? "", /^upstream stream: /, `case ${i}`)
    } finally {
      await close(f.server)
      await close(up.server)
    }
  }
})

test("passthrough: a chunked body on DELETE stays framed upstream", async () => {
  const up = await uploadSink()
  const f = await streamingFront(() => new URL(`http://127.0.0.1:${up.port}/api/oauth/files/abc`))
  try {
    const req = http.request({ host: "127.0.0.1", port: f.port, method: "DELETE", path: "/api/oauth/files/abc", headers: { "transfer-encoding": "chunked" } })
    const status = new Promise<number>((resolve, reject) => {
      req.on("response", (res) => {
        res.resume()
        res.on("end", () => resolve(res.statusCode ?? 0))
      })
      req.on("error", reject)
    })
    req.write("first-")
    req.end("last")
    assert.equal(await within(status, 3000, "no reply to the chunked DELETE"), 200)
    assert.equal(up.got.length, 1)
    assert.equal(up.got[0].body, "first-last")
    assert.equal(up.got[0].headers["transfer-encoding"], "chunked")
    assert.equal(up.got[0].headers["content-length"], undefined)
  } finally {
    await close(f.server)
    await close(up.server)
  }
})
