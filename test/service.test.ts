// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// Unit rendering and the install/uninstall/kickstart command sequences, against a
// scratch HOME. The Run is a fake that records calls: no test runs the real
// launchctl or systemctl.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { beaconsPaths } from "../src/paths.ts"
import type { Paths } from "../src/paths.ts"
import { ensureStarted, installService, kickstart, lingerOn, renderLaunchd, renderSystemd, serviceKind, uninstallService } from "../src/service.ts"
import type { Run } from "../src/service.ts"

function scratch(sub = ""): Paths {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "beacons-")), sub)
  return beaconsPaths({ HOME: dir, XDG_CONFIG_HOME: path.join(dir, "config"), XDG_DATA_HOME: path.join(dir, "data") })
}

function fakeRun(answer: (cmd: string, args: string[]) => { code: number; stdout?: string; stderr?: string } = () => ({ code: 0 })) {
  const calls: [string, string[]][] = []
  const run: Run = async (cmd, args) => {
    calls.push([cmd, args])
    const r = answer(cmd, args)
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
  }
  return { run, calls }
}

const uid = process.getuid!()
const LABEL = "com.orodruinlabs.beacons"

test("service: the plist runs the current release on the current node, with no CLAUDE_CONFIG_DIR", () => {
  const p = scratch()
  const xml = renderLaunchd(p)
  assert.ok(xml.includes(`${p.dataDir}/node/current/bin/node`))
  assert.ok(xml.includes(`${p.dataDir}/releases/current/src/daemon.ts`))
  assert.ok(!xml.includes("CLAUDE_CONFIG_DIR"))
  assert.ok(xml.includes(`${p.dataDir}/logs/daemon.log`))
})

test("service: the plist takes a label and escapes every path", () => {
  const p = scratch("a&b <c> d")
  const xml = renderLaunchd(p, "com.orodruinlabs.beacons.test")
  assert.ok(xml.includes("<string>com.orodruinlabs.beacons.test</string>"))
  assert.ok(xml.includes("a&amp;b &lt;c&gt; d"))
  assert.ok(!xml.includes("a&b"))
})

test("service: the systemd unit runs the current release on the current node, unquoted, with no CLAUDE_CONFIG_DIR", () => {
  const p = scratch()
  const u = renderSystemd(p)
  assert.ok(!u.includes("CLAUDE_CONFIG_DIR"))
  assert.ok(u.includes(`${p.dataDir}/node/current/bin/node --experimental-strip-types --no-warnings ${p.dataDir}/releases/current/src/daemon.ts`))
})

test("service: systemd quotes a path with a space in ExecStart and Environment", () => {
  const p = scratch("my home")
  const u = renderSystemd(p)
  assert.ok(u.includes(`ExecStart="${p.dataDir}/node/current/bin/node" --experimental-strip-types --no-warnings "${p.dataDir}/releases/current/src/daemon.ts"`))
  assert.ok(u.includes(`Environment="HOME=${p.home}"`))
  assert.ok(u.includes(`Environment="XDG_DATA_HOME=${path.dirname(p.dataDir)}"`))
})

test("service: install bootstraps launchd in the gui domain", async () => {
  const p = scratch()
  const { run, calls } = fakeRun((cmd, args) => (args[0] === "bootout" ? { code: 113, stderr: "Could not find service" } : { code: 0 }))
  await installService(p, run, LABEL, "darwin")
  const plist = path.join(p.home, "Library", "LaunchAgents", `${LABEL}.plist`)
  assert.deepEqual(calls, [
    ["launchctl", ["bootout", `gui/${uid}/${LABEL}`]],
    ["launchctl", ["bootstrap", `gui/${uid}`, plist]],
  ])
  assert.equal(readFileSync(plist, "utf8"), renderLaunchd(p))
  assert.equal(statSync(plist).mode & 0o777, 0o644)
  assert.equal(statSync(p.logsDir).mode & 0o777, 0o700)
})

test("service: a failed bootstrap throws with launchctl's words", async () => {
  const p = scratch()
  const { run } = fakeRun((cmd, args) => (args[0] === "bootstrap" ? { code: 5, stderr: "Bootstrap failed: 5" } : { code: 0 }))
  await assert.rejects(installService(p, run, LABEL, "darwin"), /Bootstrap failed: 5/)
})

test("service: install enables the systemd unit", async () => {
  const p = scratch()
  const { run, calls } = fakeRun()
  await installService(p, run, LABEL, "linux")
  const file = path.join(path.dirname(p.configDir), "systemd", "user", "beacons.service")
  assert.deepEqual(calls, [
    ["systemctl", ["--user", "daemon-reload"]],
    ["systemctl", ["--user", "enable", "--now", "beacons.service"]],
  ])
  assert.equal(readFileSync(file, "utf8"), renderSystemd(p))
  assert.equal(statSync(file).mode & 0o777, 0o644)
  assert.equal(statSync(p.logsDir).mode & 0o777, 0o700)
})

test("service: uninstall stops the service and removes the unit, keeping the data", async () => {
  for (const platform of ["darwin", "linux"] as const) {
    const p = scratch()
    await installService(p, fakeRun().run, LABEL, platform)
    const { run, calls } = fakeRun()
    await uninstallService(p, run, LABEL, platform)
    const file = platform === "darwin" ? path.join(p.home, "Library", "LaunchAgents", `${LABEL}.plist`) : path.join(path.dirname(p.configDir), "systemd", "user", "beacons.service")
    assert.ok(!existsSync(file))
    assert.ok(existsSync(p.logsDir))
    assert.ok(calls.length > 0)
    if (platform === "darwin") assert.deepEqual(calls[0], ["launchctl", ["bootout", `gui/${uid}/${LABEL}`]])
    else assert.deepEqual(calls[0], ["systemctl", ["--user", "disable", "--now", "beacons.service"]])
  }
})

test("service: kickstart forces a restart", async () => {
  const p = scratch()
  let r = fakeRun()
  await kickstart(p, r.run, LABEL, "darwin")
  assert.deepEqual(r.calls, [["launchctl", ["kickstart", "-k", `gui/${uid}/${LABEL}`]]])
  r = fakeRun()
  await kickstart(p, r.run, LABEL, "linux")
  assert.deepEqual(r.calls, [["systemctl", ["--user", "restart", "beacons.service"]]])
  await assert.rejects(kickstart(p, fakeRun(() => ({ code: 1, stderr: "nope" })).run, LABEL, "darwin"), /nope/)
})

test("service: ensureStarted starts a stopped service and never restarts a running one", async () => {
  const p = scratch()
  let r = fakeRun()
  // No -k: launchd does nothing to a job that is running.
  await ensureStarted(p, r.run, LABEL, "darwin")
  assert.deepEqual(r.calls, [["launchctl", ["kickstart", `gui/${uid}/${LABEL}`]]])
  r = fakeRun()
  // start, not restart: systemd leaves an active unit alone.
  await ensureStarted(p, r.run, LABEL, "linux")
  assert.deepEqual(r.calls, [["systemctl", ["--user", "start", "beacons.service"]]])
  await assert.rejects(ensureStarted(p, fakeRun(() => ({ code: 113, stderr: "Could not find service" })).run, LABEL, "darwin"), /Could not find service/)
})

test("service: lingerOn reads loginctl", async () => {
  let r = fakeRun(() => ({ code: 0, stdout: "Linger=yes\n" }))
  assert.equal(await lingerOn(r.run), true)
  assert.equal(r.calls[0][0], "loginctl")
  assert.deepEqual(r.calls[0][1].slice(0, 1), ["show-user"])
  assert.deepEqual(r.calls[0][1].slice(2), ["-p", "Linger"])
  assert.equal(await lingerOn(fakeRun(() => ({ code: 0, stdout: "Linger=no\n" })).run), false)
  assert.equal(await lingerOn(fakeRun(() => ({ code: 1 })).run), false)
})

test("service: Windows refuses with the later-version message", () => {
  assert.throws(() => serviceKind("win32"), /Windows comes in a later version/)
  assert.equal(serviceKind("darwin"), "launchd")
  assert.equal(serviceKind("linux"), "systemd")
})
