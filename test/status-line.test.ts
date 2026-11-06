// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
import { test } from "node:test"
import assert from "node:assert/strict"
import { statusLine } from "../src/status-line.ts"
import { SessionMap } from "../src/sessions.ts"

test("line: not routed", () => {
  assert.equal(statusLine({ daemon: "up", routed: false }), "◔ beacons direct")
})
test("line: routed, daemon down", () => {
  assert.equal(statusLine({ daemon: "down", routed: true, mode: "pool", first: "a" }), "◕ beacons down")
})
test("line: chain down, fallback wait", () => {
  const chain = { on: true, state: "down", fallback: "wait" } as const
  assert.equal(statusLine({ daemon: "up", routed: true, mode: "pool", first: "a", account: "a", chain }), "◕ beacons proxy down")
})
test("line: chain down, fallback direct", () => {
  const chain = { on: true, state: "down", fallback: "direct" } as const
  assert.equal(statusLine({ daemon: "up", routed: true, mode: "pool", first: "a", account: "a", chain }), "◑ beacons proxy down → direct")
})
test("line: chain on and up does not override", () => {
  const chain = { on: true, state: "up", fallback: "wait" } as const
  assert.equal(statusLine({ daemon: "up", routed: true, mode: "pool", first: "a", account: "a", chain }), "◔ beacons a")
})
test("line: served by the first choice", () => {
  assert.equal(statusLine({ daemon: "up", routed: true, mode: "pool", first: "a", account: "a" }), "◔ beacons a")
})
test("line: pinned", () => {
  assert.equal(statusLine({ daemon: "up", routed: true, mode: "pin", first: "a", account: "a" }), "◔ beacons a")
})
test("line: not yet served shows the route's account", () => {
  assert.equal(statusLine({ daemon: "up", routed: true, mode: "pool", first: "a", account: null }), "◔ beacons a")
  assert.equal(statusLine({ daemon: "up", routed: true, mode: "pin", first: "p" }), "◔ beacons p")
})
test("line: pool, served by another account", () => {
  assert.equal(statusLine({ daemon: "up", routed: true, mode: "pool", first: "a", account: "b" }), "◑ beacons b")
})

test("sessions: record, get, list, prune", () => {
  const m = new SessionMap()
  m.record("s1", { account: "a", mode: "pool", first: "a" }, 1000)
  m.record("s2", { account: "b", mode: "pool", first: "a" }, 5000)
  assert.equal(m.get("s1")?.account, "a")
  assert.equal(m.get("nope"), null)
  m.record("s1", { account: "b", mode: "pool", first: "a" }, 9000)
  assert.equal(m.get("s1")?.lastSeen, 9000)
  assert.equal(m.list().length, 2)
  m.prune(8000, 2000)
  assert.deepEqual(m.list().map((e) => e.id), ["s1"])
  m.prune(9000 + 24 * 3600_000 + 1)
  assert.equal(m.list().length, 0)
})
