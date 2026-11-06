// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The accounts file from outside the daemon: login, logout, order, and the lock
// they share with the daemon's token write-back. Every network call is injected;
// no test opens a browser or leaves the machine.
import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { accountNames, login, logout, notifyReload, order, readPool, updatePool } from "../src/accounts.ts"
import type { AccountRecord, AccountsFile } from "../src/engine/types.d.ts"

function scratchFile(doc?: AccountsFile): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "beacons-")), "accounts.json")
  if (doc) writeFileSync(file, JSON.stringify(doc), { mode: 0o600 })
  return file
}
const row = (name: string, extra: Partial<AccountRecord> = {}): AccountRecord => ({ name, type: "oauth", accessToken: `at-${name}`, refreshToken: `rt-${name}`, ...extra })
const names = (file: string) => readPool(file).accounts.map((a) => a.name)
const noLog = () => {}
const fakeLogin = (n = 1) => async () => ({ accessToken: `new-at-${n}`, refreshToken: `new-rt-${n}`, expiresAt: 1000 + n })
const fakeProfile = (p: Record<string, unknown>) => async () => p as never

test("login: names the account by its email and upserts by identity, reporting existed", async () => {
  const file = scratchFile()
  const profile = fakeProfile({ email: "a@b.com", accountUuid: "u1", orgUuid: "o1", orgName: "Org" })
  const first = await login(file, {}, noLog, { loginOAuth: fakeLogin(1), fetchProfile: profile })
  assert.equal(first.existed, false)
  assert.equal(first.account.name, "a@b.com")
  const second = await login(file, {}, noLog, { loginOAuth: fakeLogin(2), fetchProfile: profile })
  assert.equal(second.existed, true)
  const pool = readPool(file)
  assert.equal(pool.accounts.length, 1)
  assert.equal(pool.accounts[0].accessToken, "new-at-2")
  assert.equal(pool.accounts[0].name, "a@b.com")
})

test("login: an explicit name wins; an existing row keeps its own name", async () => {
  const file = scratchFile({ accounts: [row("work", { accountUuid: "u1", orgUuid: "o1" })] })
  const r = await login(file, { name: "other" }, noLog, { loginOAuth: fakeLogin(), fetchProfile: fakeProfile({ email: "a@b.com", accountUuid: "u1", orgUuid: "o1" }) })
  assert.equal(r.existed, true)
  assert.equal(r.account.name, "work")
  const fresh = await login(file, { name: "mine" }, noLog, { loginOAuth: fakeLogin(), fetchProfile: fakeProfile({ email: "c@d.com", accountUuid: "u2", orgUuid: "o2" }) })
  assert.equal(fresh.account.name, "mine")
})

test("login: two orgs of one person get (org) suffixes", async () => {
  const file = scratchFile()
  const p = (o: string, n: string) => fakeProfile({ email: "a@b.com", accountUuid: "u1", orgUuid: o, orgName: n })
  await login(file, {}, noLog, { loginOAuth: fakeLogin(1), fetchProfile: p("o1", "Alpha") })
  const second = await login(file, {}, noLog, { loginOAuth: fakeLogin(2), fetchProfile: p("o2", "Beta") })
  assert.equal(second.existed, false)
  assert.deepEqual(names(file), ["a@b.com (Alpha)", "a@b.com (Beta)"])
})

test("login: tokens never reach the log", async () => {
  const file = scratchFile()
  const lines: string[] = []
  await login(file, {}, (l) => lines.push(l), { loginOAuth: fakeLogin(7), fetchProfile: fakeProfile({ email: "a@b.com", accountUuid: "u1", orgUuid: "o1" }) })
  assert.ok(lines.length > 0)
  assert.ok(!lines.join("\n").includes("new-at-7") && !lines.join("\n").includes("new-rt-7"))
})

test("logout: removes the exact name and returns the row; an unknown name lists the known ones", async () => {
  const file = scratchFile({ accounts: [row("one"), row("two")] })
  const gone = await logout(file, "one")
  assert.equal(gone.name, "one")
  assert.deepEqual(names(file), ["two"])
  await assert.rejects(logout(file, "tw"), /two/)
  await assert.rejects(logout(file, "nope"), /no account named "nope".*two/)
  assert.deepEqual(names(file), ["two"])
})

test("order: sets priority 0..n-1 in the given order; unnamed rows follow in their old order", async () => {
  const file = scratchFile({ accounts: [row("a", { priority: 2 }), row("b", { priority: 0 }), row("c", { priority: 1 }), row("d", { priority: 3 })] })
  await order(file, ["d", "a"])
  const pr = Object.fromEntries(readPool(file).accounts.map((a) => [a.name, a.priority]))
  assert.deepEqual(pr, { d: 0, a: 1, b: 2, c: 3 })
})

test("order: refuses an unknown, a repeated or an ambiguous name, and writes nothing", async () => {
  const file = scratchFile({ accounts: [row("a"), row("b"), row("b")] })
  const before = readFileSync(file, "utf8")
  await assert.rejects(order(file, ["zzz"]), /no account named "zzz"/)
  await assert.rejects(order(file, ["b"]), /"b" matches 2 accounts/)
  await assert.rejects(order(file, ["a", "a"]), /twice/)
  assert.equal(readFileSync(file, "utf8"), before)
})

test("updatePool: a token rotated by the daemon and a reorder, racing, both land", async () => {
  const file = scratchFile({ accounts: [row("a"), row("b")] })
  const rotate = updatePool(file, (d) => {
    d.accounts[0].refreshToken = "rotated"
  })
  const reorder = order(file, ["b", "a"])
  const rotateB = updatePool(file, (d) => {
    d.accounts[1].accessToken = "rotated-b"
  })
  await Promise.all([rotate, reorder, rotateB])
  const pool = readPool(file)
  const a = pool.accounts.find((x) => x.name === "a")!
  const b = pool.accounts.find((x) => x.name === "b")!
  assert.equal(a.refreshToken, "rotated")
  assert.equal(b.accessToken, "rotated-b")
  assert.equal(b.priority, 0)
  assert.equal(a.priority, 1)
})

test("updatePool: the file is 0600 after every write, even when it began wider", async () => {
  const file = scratchFile({ accounts: [row("a")] })
  chmodSync(file, 0o644)
  await updatePool(file, () => {})
  assert.equal(statSync(file).mode & 0o777, 0o600)
  await order(file, ["a"])
  assert.equal(statSync(file).mode & 0o777, 0o600)
  await logout(file, "a")
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test("notifyReload: POSTs the reload path, and says false when nothing answers", async () => {
  const seen: string[] = []
  const srv = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    res.end("{}")
  })
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
  const port = (srv.address() as AddressInfo).port
  assert.equal(await notifyReload(port), true)
  assert.deepEqual(seen, ["POST /beacons/v1/reload"])
  await new Promise((r) => srv.close(r))
  assert.equal(await notifyReload(port), false)
})

test("accountNames: by priority, then by place in the file, as the engine tries them", () => {
  const file = scratchFile({ accounts: [row("c", { priority: 2 }), row("a", { priority: 0 }), row("none"), row("b", { priority: 0 })] })
  assert.deepEqual(accountNames(file), ["a", "none", "b", "c"])
  assert.deepEqual(accountNames(path.join(mkdtempSync(path.join(tmpdir(), "beacons-")), "accounts.json")), [])
})
