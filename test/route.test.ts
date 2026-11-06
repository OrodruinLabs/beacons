// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
import { test } from "node:test"
import assert from "node:assert/strict"
import { isOurs, parseRoute, routeBase } from "../src/route.ts"
import { browserRefusal } from "../src/browser.ts"

test("route: names with @ and spaces round-trip", () => {
  const base = routeBase(4774, "pool", "a@b.com work")
  assert.equal(base, "http://127.0.0.1:4774/pool/a%40b.com%20work")
  assert.deepEqual(parseRoute("/pool/a%40b.com%20work/v1/messages?beta=true"), { mode: "pool", account: "a@b.com work", url: "/v1/messages?beta=true" })
})
test("route: pin and bare paths", () => {
  assert.deepEqual(parseRoute("/pin/personal/v1/messages"), { mode: "pin", account: "personal", url: "/v1/messages" })
  assert.deepEqual(parseRoute("/v1/messages"), { mode: "pool", account: null, url: "/v1/messages" })
})
test("route: a path under any other prefix is not ours and passes through unparsed", () => {
  assert.deepEqual(parseRoute("/other/x/v1/messages"), { mode: "pool", account: null, url: "/other/x/v1/messages" })
})
test("route: a malformed escape in the account is not ours and does not throw", () => {
  assert.deepEqual(parseRoute("/pool/bad%zz/v1/messages"), { mode: "pool", account: null, url: "/pool/bad%zz/v1/messages" })
})
test("browser: a page's fetch and a rebinding Host are refused; curl and Claude Code pass", () => {
  assert.match(browserRefusal({ origin: "https://evil.example" }, "127.0.0.1")!, /cross-origin/)
  assert.match(browserRefusal({ host: "evil.example:4774" }, "127.0.0.1")!, /Host/)
  assert.equal(browserRefusal({ host: "127.0.0.1:4774" }, "127.0.0.1"), null)
  assert.equal(browserRefusal({}, "127.0.0.1"), null)
  assert.match(browserRefusal({ "sec-fetch-site": "cross-site" }, "127.0.0.1")!, /cross-origin/)
})

test("browser: the edge cases at the door", () => {
  // Host names for this machine pass, IPv6 in brackets with a port included.
  for (const host of ["localhost:4774", "LOCALHOST", "[::1]:4774", "[::1]", "::1", "127.0.0.1"]) {
    assert.equal(browserRefusal({ host }, "127.0.0.1"), null, host)
  }
  // A sandboxed frame or a file: page sends Origin "null": still a page.
  assert.match(browserRefusal({ origin: "null", host: "127.0.0.1:4774" }, "127.0.0.1")!, /cross-origin/)
  // A typed-in URL (none) and the gateway's own origin (same-origin) pass, even with an Origin beside them.
  assert.equal(browserRefusal({ "sec-fetch-site": "none", host: "127.0.0.1:4774" }, "127.0.0.1"), null)
  assert.equal(browserRefusal({ "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:4774", host: "127.0.0.1:4774" }, "127.0.0.1"), null)
  assert.match(browserRefusal({ "sec-fetch-site": "same-site", host: "127.0.0.1:4774" }, "127.0.0.1")!, /cross-origin/)
  // An IPv6 Host with no closing bracket names nothing: refused.
  assert.match(browserRefusal({ host: "[::1" }, "127.0.0.1")!, /Host/)
  assert.match(browserRefusal({ host: "[::1:4774" }, "127.0.0.1")!, /Host/)
})

test("route: isOurs is a pool or pin route on beacons' own port, and nothing else", () => {
  assert.equal(isOurs(routeBase(4774, "pool", "a@b.com"), 4774), true)
  assert.equal(isOurs(routeBase(4774, "pin", "work"), 4774), true)
  assert.equal(isOurs(routeBase(4775, "pool", "work"), 4774), false)
  assert.equal(isOurs("http://127.0.0.1:4774/v1", 4774), false)
  assert.equal(isOurs("http://localhost:4774/pool/work", 4774), false)
})
