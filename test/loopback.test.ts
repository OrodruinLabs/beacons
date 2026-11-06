// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The loopback host names, against the engine's own egress allowlist, and the
// one loopback client every control call goes through, on ports fetch refuses.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import http from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { Writable } from "node:stream"
import { notifyReload } from "../src/accounts.ts"
import { main } from "../src/cli.ts"
import { saveGatewayConfig } from "../src/config.ts"
import { assertAllowedHost } from "../src/engine/upstream-fetch.js"
import { daemonHealth, LOOPBACK, loopbackUrl } from "../src/loopback.ts"
import { beaconsPaths } from "../src/paths.ts"
import { routeBase } from "../src/route.ts"
import { probeRequest } from "../src/setup.ts"

test("loopback: every host beacons counts as this machine is one the engine sends to, and no other", () => {
  for (const host of LOOPBACK) assert.doesNotThrow(() => assertAllowedHost(`http://${host}:9100/relay`), host)
  // ::1 is loopback, but the engine refuses it: counting it would turn on a chain whose every request is refused.
  assert.throws(() => assertAllowedHost("http://[::1]:9100/relay"), /refused/)
  assert.equal(loopbackUrl("http://[::1]:9100/relay"), null)
  assert.equal(loopbackUrl("http://127.0.0.1:9100/relay")?.origin, "http://127.0.0.1:9100")
  assert.equal(loopbackUrl("http://localhost:9100")?.origin, "http://localhost:9100")
  assert.equal(loopbackUrl("https://api.anthropic.com"), null)
  assert.equal(loopbackUrl("not a url"), null)
})

/** fetch's blocked ports above 1024: gateway.json may name any of them. */
const FETCH_BAD_PORTS = [10080, 6000, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 6566, 5060, 5061, 4190, 4045, 3659, 2049, 1723, 1720, 1719]

/** A fake daemon on the first of fetch's blocked ports that is free here; null when none is. */
async function daemonOnBadPort(): Promise<{ port: number; seen: string[]; close(): Promise<void> } | null> {
  const seen: string[] = []
  for (const port of FETCH_BAD_PORTS) {
    const server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`)
      req.resume()
      req.on("end", () => {
        const json = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" })
          res.end(JSON.stringify(body))
        }
        if (req.url === "/beacons/v1/health") return json(200, { ok: true, version: "0.3.0" })
        if (req.url === "/beacons/v1/status") return json(200, { version: "0.3.0", port, upstream: "https://api.anthropic.com", chain: null, current: null, accounts: [], sessions: [], inFlight: 0 })
        if (req.url === "/beacons/v1/reload") return json(200, { added: 0, removed: 0 })
        if (req.url?.endsWith("/v1/messages")) return json(200, {})
        json(404, { error: "not found" })
      })
    })
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false))
      server.listen(port, "127.0.0.1", () => resolve(true))
    })
    if (ok) return { port, seen, close: () => new Promise<void>((r) => server.close(() => r())) }
  }
  return null
}

test("loopback: every control call reaches a port fetch refuses", async (t) => {
  const d = await daemonOnBadPort()
  if (!d) return t.skip("every one of fetch's blocked ports is taken on this machine")
  try {
    // fetch refuses this port, so the test means something.
    await assert.rejects(fetch(`http://127.0.0.1:${d.port}/beacons/v1/health`), /fetch failed/)
    assert.deepEqual(await daemonHealth(d.port), { version: "0.3.0" })
    const home = mkdtempSync(path.join(tmpdir(), "beacons-"))
    const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"), PATH: process.env.PATH ?? "/usr/bin:/bin" }
    saveGatewayConfig(beaconsPaths(env), { port: d.port, upstreamUrl: "https://api.anthropic.com", chainFallback: "wait" })
    let out = ""
    const code = await main(["status"], env, {
      stdout: new Writable({ write(c, _e, cb) { out += c.toString(); cb() } }),
      stderr: new Writable({ write(_c, _e, cb) { cb() } }),
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
    })
    assert.equal(code, 0, out)
    assert.match(out, new RegExp(`^beacons 0\\.3\\.0, on 127\\.0\\.0\\.1:${d.port}$`, "m"))
    assert.equal(await notifyReload(d.port), true)
    assert.equal(await probeRequest(routeBase(d.port, "pool", "a@b.com")), 200)
    assert.deepEqual(d.seen, ["GET /beacons/v1/health", "GET /beacons/v1/status", "POST /beacons/v1/reload", "POST /pool/a%40b.com/v1/messages"])
  } finally {
    await d.close()
  }
})
