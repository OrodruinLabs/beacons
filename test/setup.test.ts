// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// Setup, against a scratch HOME with a fake plugin copy, a fake Run and fake
// health, upstream proxy and probe. No test runs the real claude, launchctl,
// systemctl, loginctl or lsof, opens a browser, or sends a request anywhere
// but a local fake. The wizard is driven through its injected streams: the
// fake terminal types the next answer each time a prompt ends in "> ".
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { PassThrough, Writable } from "node:stream"
import { beaconsPaths, type Paths } from "../src/paths.ts"
import { readRoutes } from "../src/config.ts"
import { readPool, type LoginDeps } from "../src/accounts.ts"
import { readReleaseState, snapshot, switchTo } from "../src/release.ts"
import { route } from "../src/routes.ts"
import type { Run } from "../src/service.ts"
import { applySetup, findPortHolder, holderIsBeacons, planSetup, probeRequest, setupCommand, type SetupDeps } from "../src/setup.ts"

const uid = process.getuid!()
const PROXY = "http://127.0.0.1:9100/relay"

type Scratch = { home: string; env: NodeJS.ProcessEnv; p: Paths; plugin: string; unit: string }

const write = (file: string, text: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text) }
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"))
const settings = (profile: string) => json(path.join(profile, "settings.json"))

/** A scratch HOME and XDG dirs, a plugin copy at version 0.1.0, and that copy's Node "installed". */
function scratch(accounts: string[] = ["a@example.com", "b"]): Scratch {
  const home = mkdtempSync(path.join(tmpdir(), "beacons-"))
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    PATH: "/usr/bin:/bin",
  }
  const p = beaconsPaths(env)
  const plugin = path.join(home, "plugin")
  write(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "beacons", version: "0.1.0" }))
  write(path.join(plugin, "package.json"), "{}\n")
  write(path.join(plugin, "src", "daemon.ts"), "// fake\n")
  write(path.join(plugin, "bin", "beacons"), "#!/bin/sh\n")
  write(path.join(plugin, "node-sha256.txt"), "v26.13.0\n")
  mkdirSync(path.join(p.nodeDir, "26.13.0", "bin"), { recursive: true })
  if (accounts.length > 0) {
    write(p.accountsFile, JSON.stringify({
      accounts: accounts.map((name, i) => ({ name, type: "oauth", accountUuid: `u-${i}`, orgUuid: `o-${i}`, refreshToken: `fake-${i}`, priority: i })),
    }))
  }
  const unit = path.join(home, "Library", "LaunchAgents", "com.orodruinlabs.beacons.plist")
  return { home, env, p, plugin, unit }
}

type Answer = (cmd: string, args: string[]) => { code: number; stdout?: string; stderr?: string } | undefined

/**
 * Fake deps, on macOS unless told otherwise. Every effect goes into one log, in
 * order: each Run call, each probe, each boot check. Health answers 0.1.0 once
 * beacons' unit file is installed, unless `healthy` or `health` say otherwise.
 * The upstream proxy answers only when `proxy` says so; `asked` lists each URL it was asked at.
 */
function fakes(s: Scratch, o: {
  holder?: string | null; isBeacons?: boolean; proxy?: boolean; answer?: Answer; loginDeps?: LoginDeps; healthy?: () => boolean; env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform; health?: () => { version: string } | null; bootCheck?: (dir: string) => Promise<unknown>
} = {}) {
  const log: string[] = []
  const lines: string[] = []
  const asked: string[] = []
  const run: Run = async (cmd, args) => {
    log.push(`run ${cmd} ${args.join(" ")}`)
    const r = o.answer?.(cmd, args) ?? { code: 0 }
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
  }
  const deps: SetupDeps = {
    run,
    pluginRoot: s.plugin,
    portHolder: async () => o.holder ?? null,
    isBeacons: async () => o.isBeacons ?? false,
    proxyAnswers: async (url) => { asked.push(url); return o.proxy ?? false },
    health: async () => (o.health ? o.health() : (o.healthy ?? (() => existsSync(s.unit)))() ? { version: "0.1.0" } : null),
    probeRequest: async (base) => { log.push(`probe ${base}`); return 200 },
    log: (line) => lines.push(line),
    bootCheck: o.bootCheck ?? (async (dir) => { log.push(`bootCheck ${path.basename(dir)}`); return true }),
    env: o.env ?? s.env,
    platform: o.platform ?? "darwin",
    sleep: async () => {},
    reload: async (port) => { log.push(`reload ${port}`); return true },
    loginDeps: o.loginDeps,
    // A clock deadline; the fake sleep takes no time, so keep it short.
    startBudgetMs: 200,
  }
  return { deps, log, lines, asked }
}

/** Every path under `root` with its bytes or link target, to show that nothing changed. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const f = path.join(dir, name)
      const st = lstatSync(f)
      if (st.isSymbolicLink()) out[f] = `-> ${readlinkSync(f)}`
      else if (st.isDirectory()) { out[f] = "dir"; walk(f) }
      else out[f] = readFileSync(f, "base64")
    }
  }
  walk(root)
  return out
}

/** A terminal: answers the wizard's prompts in order, one per "> ", and keeps everything it was shown. */
function terminal(answers: string[]) {
  const input = new PassThrough()
  let text = ""
  const output = new Writable({
    write(chunk, _enc, cb) {
      text += chunk.toString()
      if (text.endsWith("> ")) {
        const a = answers.shift()
        if (a === undefined) input.end()
        else input.write(a + "\n")
      }
      cb()
    },
  })
  return { input, output, text: () => text, left: () => answers }
}

/** A terminal for flag runs: no prompts, just what was printed. */
function printer() {
  let text = ""
  const output = new Writable({ write(chunk, _enc, cb) { text += chunk.toString(); cb() } })
  return { input: new PassThrough(), output, text: () => text }
}

/**
 * An earlier setup: release 0.0.9 current, gateway.json written, ~/.claude routed to beacons.
 * Returns the bytes of each file a refused or reverted re-run must leave as they were.
 */
function earlier(s: Scratch, o: { gateway?: boolean } = {}) {
  const old = path.join(s.home, "plugin-0.0.9")
  write(path.join(old, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "beacons", version: "0.0.9" }))
  write(path.join(old, "package.json"), "{}\n")
  write(path.join(old, "src", "daemon.ts"), "// fake\n")
  write(path.join(old, "bin", "beacons"), "#!/bin/sh\n")
  write(path.join(old, "node-sha256.txt"), "v26.13.0\n")
  snapshot(old, s.p)
  switchTo(s.p, "0.0.9")
  // Compact, unlike what setup writes, so a gateway.json put back shows in its bytes.
  if (o.gateway !== false) write(s.p.gatewayFile, JSON.stringify({ port: 4774, upstreamUrl: "https://api.anthropic.com", chainFallback: "wait" }))
  const claude = path.join(s.home, ".claude")
  write(path.join(claude, "settings.json"), "{}")
  route(s.p, claude, { mode: "pool", account: "a@example.com", port: 4774 })
  const files = [s.p.releaseState, s.p.gatewayFile, s.p.routesFile, path.join(claude, "settings.json")]
  return { claude, bytes: () => files.map((f) => (existsSync(f) ? readFileSync(f, "utf8") : null)) }
}

// --- the brief's five ------------------------------------------------------

test("setup: a taken port stops setup before the service", async () => {
  const s = scratch()
  const f = fakes(s, { holder: "node 1234", healthy: () => false })
  const { plan } = await planSetup(s.p, s.env, f.deps)
  await assert.rejects(applySetup(plan, s.p, f.deps), (err: Error) => {
    assert.match(err.message, /port 4774 is held by node 1234; free it or set port in gateway\.json/)
    return true
  })
  assert.ok(!f.log.some((l) => l.startsWith("run launchctl")), f.log.join("\n"))
  assert.ok(!existsSync(s.p.releasesDir), "no release was made")
  assert.ok(!existsSync(s.unit))
})

test("setup: a beacons daemon that holds the port and does not answer is restarted, not named a foreign holder", async () => {
  const s = scratch()
  // Health misses its 2 s; lsof names node, which runs from beacons' own data folder.
  const f = fakes(s, { holder: "node 1234", isBeacons: true })
  const { plan, found } = await planSetup(s.p, s.env, f.deps)
  assert.equal(found.portHolder, null)
  assert.equal(found.beaconsHung, true)
  const t = printer()
  assert.equal(await setupCommand(["--profiles", "~/.claude"], s.env, { input: t.input, output: t.output, deps: f.deps }), 2)
  assert.match(t.text(), /restart beacons, which holds port 4774 but is not answering/)
  assert.ok(!t.text().includes("free it"), t.text())
  await applySetup(plan, s.p, f.deps)
  // Restarted by force before the unit goes in, so the hung process cannot hold the port against the new build.
  const service = f.log.filter((l) => l.startsWith("run launchctl"))
  assert.deepEqual(service.slice(0, 2), [`run launchctl kickstart -k gui/${uid}/com.orodruinlabs.beacons`, `run launchctl bootout gui/${uid}/com.orodruinlabs.beacons`])
  assert.ok(service.includes(`run launchctl bootstrap gui/${uid} ${s.unit}`), service.join("\n"))
})

test("setup: whether the port holder is beacons comes from its command line, under beacons' data folder", async () => {
  const calls: string[] = []
  const run = (out: string, code = 0): Run => async (cmd, args) => { calls.push(`${cmd} ${args.join(" ")}`); return { code, stdout: out, stderr: "" } }
  const data = "/h/.local/share/beacons"
  const ours = `${data}/node/current/bin/node --experimental-strip-types --no-warnings ${data}/releases/current/src/daemon.ts\n`
  assert.equal(await holderIsBeacons(run(ours), "node 1234", data), true)
  assert.equal(calls.pop(), "ps -o command= -p 1234")
  assert.equal(await holderIsBeacons(run("/usr/local/bin/node server.js\n"), "node 1234", data), false)
  assert.equal(await holderIsBeacons(run(`${data}-old/node/bin/node x\n`), "node 1234", data), false)
  assert.equal(await holderIsBeacons(run(ours, 1), "node 1234", data), false)
  assert.equal(await holderIsBeacons(run(ours), "another process", data), false)
  assert.equal(calls.length, 3)
})

test("setup: a port held by beacons itself is not taken", async () => {
  const s = scratch()
  const f = fakes(s, { holder: "node 999", healthy: () => true })
  const { found } = await planSetup(s.p, s.env, f.deps)
  assert.equal(found.portHolder, null)
})

test("setup: an upgrade holding its lock stops setup before anything changes", async () => {
  // Two release switches and restarts at once: the upgrade could switch back over setup's build, and hold it.
  const s = scratch()
  earlier(s)
  writeFileSync(s.p.upgradeLock, JSON.stringify({ pid: process.pid, time: new Date().toISOString() }))
  const f = fakes(s, { health: () => ({ version: "0.0.9" }) })
  const before = tree(s.home)
  const { plan, found } = await planSetup(s.p, s.env, f.deps)
  assert.equal(found.upgrading, true)
  await assert.rejects(applySetup(plan, s.p, f.deps), /an upgrade is running; try again in a minute/)
  assert.deepEqual(tree(s.home), before)
  assert.deepEqual(f.log, [])
  const t = printer()
  assert.equal(await setupCommand(["--yes"], s.env, { input: t.input, output: t.output, deps: f.deps }), 2)
  assert.match(t.text(), /an upgrade is running; try again in a minute\nNothing was changed\./)
  const w = terminal([])
  assert.equal(await setupCommand([], s.env, { input: w.input, output: w.output, deps: f.deps }), 2)
  assert.match(w.text(), /an upgrade is running; try again in a minute\. Setup stopped\. No profile, setting or service was changed\./)
  assert.deepEqual(tree(s.home), before)
  assert.deepEqual(f.log, [])
})

test("setup: --plan prints the plan and changes nothing", async () => {
  const s = scratch()
  write(path.join(s.home, ".claude-alt", "settings.json"), JSON.stringify({ env: { KEEP: "1" } }))
  const f = fakes(s)
  const before = tree(s.home)
  const t = printer()
  const code = await setupCommand(["--plan", "--mode", "~/.claude-alt=pin:b", "--chain-fallback", "direct"], s.env, { input: t.input, output: t.output, deps: f.deps })
  assert.equal(code, 0, t.text())
  const out = JSON.parse(t.text())
  const claude = path.join(s.home, ".claude"), alt = path.join(s.home, ".claude-alt")
  assert.deepEqual(out.plan.profiles, [claude, alt])
  assert.deepEqual(out.plan.order, ["a@example.com", "b"])
  assert.deepEqual(out.plan.modes, { [claude]: { mode: "pool", account: "a@example.com" }, [alt]: { mode: "pin", account: "b" } })
  assert.deepEqual(out.plan.chain, { url: null, fallback: "direct" })
  assert.deepEqual(out.plan.replace, [])
  assert.equal(out.found.proxy, null)
  assert.deepEqual(out.problems, [])
  assert.deepEqual(tree(s.home), before)
  assert.deepEqual(f.log, [])
  assert.deepEqual(f.lines, [])
  assert.deepEqual(f.asked, [], "a user with no proxy is never probed")
})

test("setup: a profile parked by off keeps its mode in the plan, and routing it unparks it", async () => {
  const s = scratch()
  const claude = path.join(s.home, ".claude")
  write(path.join(claude, "settings.json"), "{}\n")
  write(s.p.routesFile, JSON.stringify({
    version: 1, profiles: {},
    off: { [claude]: { mode: "pin", account: "b", wrote: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4774/pin/b" }, replaced: null, replacedKind: null, statusLine: null, plugin: true } },
  }))
  const f = fakes(s)
  const t = printer()
  assert.equal(await setupCommand(["--yes"], s.env, { input: t.input, output: t.output, deps: f.deps }), 0, t.text() + f.lines.join("\n"))
  const routes = readRoutes(s.p)
  assert.equal(Object.hasOwn(routes, "off"), false)
  assert.equal(routes.profiles[claude].mode, "pin")
  assert.equal(routes.profiles[claude].account, "b")
  assert.equal(settings(claude).env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4774/pin/b")
})

test("setup: flags without --yes change nothing and say how to apply", async () => {
  const s = scratch()
  const f = fakes(s)
  const before = tree(s.home)
  const t = printer()
  const code = await setupCommand(["--order", "b,a@example.com"], s.env, { input: t.input, output: t.output, deps: f.deps })
  assert.equal(code, 2)
  assert.match(t.text(), /--yes/)
  assert.deepEqual(tree(s.home), before)
  assert.deepEqual(f.log, [])
})

test("setup: two logins of one account warn", async () => {
  const s = scratch([])
  let n = 0
  const loginDeps: LoginDeps = {
    loginOAuth: async () => ({ accessToken: `at-${++n}`, refreshToken: `rt-${n}`, expiresAt: Date.now() + 3_600_000 }),
    fetchProfile: async () => ({ email: "me@example.com", accountUuid: "u-1", orgUuid: "o-1", orgName: "Org" }),
  }
  const f = fakes(s, { loginDeps })
  // two sign-ins, the default profiles and mode, then no.
  const t = terminal(["2", "", "", "n"])
  const code = await setupCommand([], s.env, { input: t.input, output: t.output, deps: f.deps })
  assert.equal(code, 1, t.text())
  const text = t.text()
  const warnings = text.split("\n").filter((l) => l.startsWith("warning:"))
  assert.equal(warnings.length, 1, text)
  assert.match(warnings[0], /"me@example\.com"/)
  assert.match(warnings[0], /already signed in/)
  assert.match(warnings[0], /sign out/)
  assert.equal(readPool(s.p.accountsFile).accounts.length, 1)
  assert.match(text, /No profile, setting or service was changed/)
  assert.deepEqual(t.left(), [])
  assert.ok(!f.log.some((l) => l.startsWith("run ")), f.log.join("\n"))
})

test("setup: the wizard asks about a proxy a profile routes to before the profiles, with no as the default; yes takes its place", async () => {
  const s = scratch(["a@example.com"])
  const alt = path.join(s.home, ".claude-alt")
  write(path.join(alt, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: PROXY } }))
  const f = fakes(s, { proxy: true })
  const { plan, found } = await planSetup(s.p, s.env, f.deps)
  // Only suggested: the chain stays off, and the profile stays another gateway's, until the user says yes.
  assert.deepEqual(found.proxy, { url: PROXY, answers: true, source: "profiles" })
  assert.deepEqual(plan.chain, { url: null, fallback: "wait" })
  assert.ok(!plan.profiles.includes(alt))
  assert.deepEqual(found.elsewhere, { [alt]: PROXY })

  // sign-ins 0, yes to the proxy, its fallback, the default profiles (now both), two modes, go ahead.
  const t = terminal(["", "yes", "", "", "", "", ""])
  const code = await setupCommand([], s.env, { input: t.input, output: t.output, deps: f.deps })
  assert.equal(code, 0, t.text() + f.lines.join("\n"))
  const text = t.text()
  const question = `Send traffic on through the local proxy at ${PROXY}? It will see every pooled account's token. (yes/no) [no]\n> `
  assert.ok(text.includes(question), text)
  assert.ok(text.indexOf(question) < text.indexOf("Profiles:"), "asked before the profiles")
  assert.match(text, /wait.*direct.*\[wait\]\n> /s)
  assert.match(text, /routed to the upstream proxy at http:\/\/127\.0\.0\.1:9100\/relay; beacons takes its place/)
  assert.deepEqual(t.left(), [])
  assert.deepEqual(json(s.p.gatewayFile), { port: 4774, upstreamUrl: PROXY, chainFallback: "wait" })
  const rec = readRoutes(s.p).profiles[alt]
  assert.equal(rec.replaced, PROXY)
  assert.equal(rec.replacedKind, "proxy")
})

test("setup: the wizard answering no to a proxy (one that does not answer) leaves the chain off and its profile alone", async () => {
  const s = scratch(["a@example.com"])
  const alt = path.join(s.home, ".claude-alt")
  write(path.join(alt, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: PROXY } }))
  const before = readFileSync(path.join(alt, "settings.json"), "utf8")
  const f = fakes(s, { proxy: false })
  // sign-ins 0, the proxy's default (no), the default profiles (~/.claude only), its mode, go ahead.
  const t = terminal(["", "", "", "", ""])
  const code = await setupCommand([], s.env, { input: t.input, output: t.output, deps: f.deps })
  assert.equal(code, 0, t.text() + f.lines.join("\n"))
  const text = t.text()
  assert.ok(text.includes(`It will see every pooled account's token, and it does not answer now. (yes/no) [no]\n> `), text)
  assert.ok(!/wait.*direct/.test(text), "no fallback question after a no")
  assert.ok(text.includes(`routed to ${PROXY}; replaced only if you pick it`), text)
  assert.match(text, /send straight to Anthropic/)
  assert.deepEqual(t.left(), [])
  assert.deepEqual(json(s.p.gatewayFile), { port: 4774, upstreamUrl: "https://api.anthropic.com", chainFallback: "wait" })
  assert.equal(readFileSync(path.join(alt, "settings.json"), "utf8"), before)
  assert.equal(readRoutes(s.p).profiles[alt], undefined)
})

test("setup: one loopback URL the profiles share is suggested, never proposed; two different ones suggest nothing", async () => {
  const other = "http://127.0.0.1:9200/relay"
  // One URL on two profiles: suggested in found.proxy; the chain stays off and both stay in elsewhere.
  {
    const s = scratch()
    const alt = path.join(s.home, ".claude-alt"), work = path.join(s.home, ".claude-work")
    write(path.join(alt, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: PROXY } }))
    write(path.join(work, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: PROXY } }))
    const f = fakes(s, { proxy: true })
    const { plan, found } = await planSetup(s.p, s.env, f.deps)
    assert.deepEqual(found.proxy, { url: PROXY, answers: true, source: "profiles" })
    assert.deepEqual(plan.chain, { url: null, fallback: "wait" })
    assert.deepEqual(plan.profiles, [path.join(s.home, ".claude")])
    assert.deepEqual(found.elsewhere, { [alt]: PROXY, [work]: PROXY })
    assert.deepEqual(f.asked, [PROXY])
  }
  // Two different URLs: nothing is suggested or probed, and both profiles stay in elsewhere.
  {
    const s = scratch()
    const alt = path.join(s.home, ".claude-alt"), work = path.join(s.home, ".claude-work")
    write(path.join(alt, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: PROXY } }))
    write(path.join(work, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: other } }))
    const f = fakes(s, { proxy: true })
    const { plan, found } = await planSetup(s.p, s.env, f.deps)
    assert.equal(found.proxy, null)
    assert.deepEqual(plan.chain, { url: null, fallback: "wait" })
    assert.deepEqual(found.elsewhere, { [alt]: PROXY, [work]: other })
    assert.deepEqual(f.asked, [], "nothing was probed")
  }
  // Only a loopback http URL off beacons' port can be suggested: a remote gateway, or a non-route on beacons'
  // own port, is no proxy, and does not count against the one that is.
  {
    const s = scratch()
    const alt = path.join(s.home, ".claude-alt"), remote = path.join(s.home, ".claude-remote"), port = path.join(s.home, ".claude-port")
    write(path.join(alt, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: PROXY } }))
    write(path.join(remote, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example/v1" } }))
    write(path.join(port, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4774/elsewhere" } }))
    const f = fakes(s, { proxy: true })
    const { found } = await planSetup(s.p, s.env, f.deps)
    assert.deepEqual(found.proxy, { url: PROXY, answers: true, source: "profiles" })
    assert.deepEqual(found.elsewhere, { [alt]: PROXY, [remote]: "https://gateway.example/v1", [port]: "http://127.0.0.1:4774/elsewhere" })
  }
  // A gateway the user replaced on purpose (routes.json records it as kind "other", here parked by off) is not suggested.
  {
    const s = scratch()
    const alt = path.join(s.home, ".claude-alt")
    write(path.join(alt, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: PROXY } }))
    write(s.p.routesFile, JSON.stringify({
      version: 1, profiles: {},
      off: { [alt]: { mode: "pool", account: "b", wrote: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4774/pool/b" }, replaced: PROXY, replacedKind: "other", statusLine: null, plugin: true } },
    }))
    const f = fakes(s, { proxy: true })
    const { found } = await planSetup(s.p, s.env, f.deps)
    assert.equal(found.proxy, null)
    assert.deepEqual(f.asked, [])
  }
})

test("setup: a plain --yes never turns the chain on through a suggested proxy, answering or not", async () => {
  for (const answering of [true, false]) {
    const s = scratch()
    const alt = path.join(s.home, ".claude-alt")
    write(path.join(alt, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: PROXY } }))
    const before = readFileSync(path.join(alt, "settings.json"), "utf8")
    const f = fakes(s, { proxy: answering })
    const t = printer()
    const code = await setupCommand(["--yes"], s.env, { input: t.input, output: t.output, deps: f.deps })
    assert.equal(code, 0, `${answering}: ${t.text()}${f.lines.join("\n")}`)
    assert.deepEqual(json(s.p.gatewayFile), { port: 4774, upstreamUrl: "https://api.anthropic.com", chainFallback: "wait" })
    assert.equal(readFileSync(path.join(alt, "settings.json"), "utf8"), before, "the proxy's profile is untouched")
    assert.equal(readRoutes(s.p).profiles[alt], undefined)
    assert.match(settings(path.join(s.home, ".claude")).env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:4774\/pool\//)
  }
})

test("setup: a re-run keeps gateway.json's proxy, and --upstream off turns the chain off", async () => {
  const s = scratch()
  const alt = path.join(s.home, ".claude-alt")
  write(path.join(alt, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: PROXY } }))
  write(s.p.gatewayFile, JSON.stringify({ port: 4774, upstreamUrl: PROXY, chainFallback: "direct" }))
  const f = fakes(s, { proxy: true })
  const { plan, found } = await planSetup(s.p, s.env, f.deps)
  assert.deepEqual(found.proxy, { url: PROXY, answers: true, source: "gateway" })
  assert.deepEqual(plan.chain, { url: PROXY, fallback: "direct" })
  assert.ok(plan.profiles.includes(alt))

  const t = printer()
  assert.equal(await setupCommand(["--plan", "--upstream", "off"], s.env, { input: t.input, output: t.output, deps: f.deps }), 0, t.text())
  const out = JSON.parse(t.text())
  assert.equal(out.found.proxy, null)
  assert.deepEqual(out.plan.chain, { url: null, fallback: "direct" })
  // Off, the proxy's route is another gateway's: left alone unless --replace names it.
  assert.deepEqual(out.found.elsewhere, { [alt]: PROXY })
  assert.ok(!out.plan.profiles.includes(alt))
})

test("setup: a kept chain whose proxy does not answer is a warning, not a refusal; a new one still waits for its proxy", async () => {
  const s = scratch()
  write(s.p.gatewayFile, JSON.stringify({ port: 4774, upstreamUrl: PROXY, chainFallback: "direct" }))
  const warning = `warning: the upstream proxy at ${PROXY} does not answer now; the chain is kept, and until the proxy answers, requests go direct to Anthropic`
  // --plan: no problem, and found says it does not answer.
  for (const argv of [["--plan"], ["--plan", "--upstream", PROXY]]) {
    const t = printer()
    assert.equal(await setupCommand(argv, s.env, { input: t.input, output: t.output, deps: fakes(s, { proxy: false }).deps }), 0, t.text())
    const out = JSON.parse(t.text())
    assert.deepEqual(out.found.proxy, { url: PROXY, answers: false, source: "gateway" }, argv.join(" "))
    assert.deepEqual(out.problems, [])
  }
  // Flags without --yes show the warning with the summary.
  const shown = printer()
  assert.equal(await setupCommand(["--order", "a@example.com,b"], s.env, { input: shown.input, output: shown.output, deps: fakes(s, { proxy: false }).deps }), 2)
  assert.ok(shown.text().includes(warning), shown.text())
  // A different URL that does not answer is refused.
  const other = "http://127.0.0.1:9200/relay"
  const refused = printer()
  assert.equal(await setupCommand(["--plan", "--upstream", other], s.env, { input: refused.input, output: refused.output, deps: fakes(s, { proxy: false }).deps }), 2)
  assert.deepEqual(JSON.parse(refused.text()).problems, [`the upstream proxy at ${other} does not answer; start it first, or leave the chain off (--upstream off)`])
  // --yes keeps the chain and says so.
  const f = fakes(s, { proxy: false })
  const t = printer()
  assert.equal(await setupCommand(["--yes"], s.env, { input: t.input, output: t.output, deps: f.deps }), 0, t.text() + f.lines.join("\n"))
  assert.deepEqual(json(s.p.gatewayFile), { port: 4774, upstreamUrl: PROXY, chainFallback: "direct" })
  assert.ok(f.lines.includes(warning), f.lines.join("\n"))
})

test("setup: --upstream names the proxy, and only the profiles routed to that URL are taken over", async () => {
  const s = scratch()
  const alt = path.join(s.home, ".claude-alt"), work = path.join(s.home, ".claude-work")
  // Another path on the proxy's own host and port is not the chain.
  const other = "http://127.0.0.1:9100/work"
  write(path.join(alt, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: PROXY } }))
  write(path.join(work, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: other } }))
  const f = fakes(s, { proxy: true })
  const { plan, found } = await planSetup(s.p, s.env, f.deps, { upstream: PROXY })
  assert.deepEqual(found.proxy, { url: PROXY, answers: true, source: "upstream" })
  assert.ok(plan.profiles.includes(alt) && !plan.profiles.includes(work))
  assert.deepEqual(found.elsewhere, { [work]: other })
  const t = printer()
  const code = await setupCommand(["--yes", "--upstream", PROXY, "--chain-fallback", "direct"], s.env, { input: t.input, output: t.output, deps: f.deps })
  assert.equal(code, 0, t.text() + f.lines.join("\n"))
  assert.deepEqual(json(s.p.gatewayFile), { port: 4774, upstreamUrl: PROXY, chainFallback: "direct" })
  assert.equal(readRoutes(s.p).profiles[alt].replacedKind, "proxy")
  assert.match(settings(alt).env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:4774\/pool\//)
  assert.equal(settings(work).env.ANTHROPIC_BASE_URL, other)
  assert.equal(readRoutes(s.p).profiles[work], undefined)
  assert.ok(f.lines.some((l) => l.includes(`on through the upstream proxy at ${PROXY}; if it stops answering: go direct to Anthropic`)), f.lines.join("\n"))
  assert.ok(f.asked.every((u) => u === PROXY) && f.asked.length > 0, f.asked.join(", "))
})

test("setup: --upstream takes only a loopback http URL that answers, off its own port; --chain is gone", async () => {
  const s = scratch()
  const before = tree(s.home)
  for (const argv of [["--upstream", "https://127.0.0.1:9100"], ["--upstream", "http://example.com:9100"], ["--upstream", "http://[::1]:9100"], ["--upstream", "on"], ["--chain", "on"]]) {
    const t = printer()
    const code = await setupCommand([...argv, "--plan"], s.env, { input: t.input, output: t.output, deps: fakes(s, { proxy: true }).deps })
    assert.equal(code, 2, argv.join(" "))
    assert.match(t.text(), /usage: beacons setup/, argv.join(" "))
  }
  const problems = async (argv: string[], proxy: boolean) => {
    const t = printer()
    assert.equal(await setupCommand([...argv, "--plan"], s.env, { input: t.input, output: t.output, deps: fakes(s, { proxy }).deps }), 2)
    return (JSON.parse(t.text()) as { problems: string[] }).problems
  }
  assert.ok((await problems(["--upstream", PROXY], false)).some((x) => x === `the upstream proxy at ${PROXY} does not answer; start it first, or leave the chain off (--upstream off)`))
  assert.ok((await problems(["--upstream", "http://127.0.0.1:4774/x"], true)).some((x) => x.includes("beacons' own port 4774")))
  assert.deepEqual(tree(s.home), before)
})

test("setup: a profile with a statusLine keeps it and gets the line printed", async () => {
  const s = scratch()
  const claude = path.join(s.home, ".claude"), alt = path.join(s.home, ".claude-alt")
  const own = { type: "command", command: "my-own-line" }
  write(path.join(alt, "settings.json"), JSON.stringify({ statusLine: own }))
  const f = fakes(s)
  const { plan } = await planSetup(s.p, s.env, f.deps)
  await applySetup(plan, s.p, f.deps)
  const line = `${s.p.launcher} status --line`
  assert.deepEqual(settings(alt).statusLine, own)
  assert.deepEqual(settings(claude).statusLine, { type: "command", command: line, refreshInterval: 30 })
  const printed = f.lines.filter((l) => l.includes(line))
  assert.equal(printed.length, 1, f.lines.join("\n"))
  assert.match(printed[0], /\.claude-alt/)
})

test("setup: a re-run says nothing about the status line it wrote itself", async () => {
  const s = scratch()
  const claude = path.join(s.home, ".claude")
  const first = fakes(s)
  await applySetup((await planSetup(s.p, s.env, first.deps)).plan, s.p, first.deps)
  const line = settings(claude).statusLine
  assert.equal(line.command, `${s.p.launcher} status --line`)
  const again = fakes(s)
  await applySetup((await planSetup(s.p, s.env, again.deps)).plan, s.p, again.deps)
  assert.deepEqual(settings(claude).statusLine, line)
  assert.ok(!again.lines.some((l) => l.includes("statusLine")), again.lines.join("\n"))
})

test("setup: a launcher that is another program's is left alone, and the status line runs the release's beacons", async () => {
  const release = (s: Scratch) => path.join(s.p.currentRelease, "bin", "beacons")
  // Someone else's file, and someone else's link: neither is replaced, and no status line names them.
  for (const kind of ["file", "link"] as const) {
    const s = scratch()
    const claude = path.join(s.home, ".claude")
    mkdirSync(path.dirname(s.p.launcher), { recursive: true })
    if (kind === "file") writeFileSync(s.p.launcher, "#!/bin/sh\necho another beacons\n")
    else symlinkSync("/usr/bin/true", s.p.launcher)
    const before = kind === "file" ? readFileSync(s.p.launcher, "utf8") : readlinkSync(s.p.launcher)
    const f = fakes(s)
    await applySetup((await planSetup(s.p, s.env, f.deps)).plan, s.p, f.deps)
    assert.equal(kind === "file" ? readFileSync(s.p.launcher, "utf8") : readlinkSync(s.p.launcher), before, kind)
    assert.equal(settings(claude).statusLine.command, `${release(s)} status --line`, kind)
    assert.ok(f.lines.some((l) => l.startsWith(`${s.p.launcher} `) && l.includes("left alone")), f.lines.join("\n"))
    assert.ok(!f.lines.some((l) => l.includes("export PATH")), f.lines.join("\n"))
  }
  // A link into beacons' own data folder (an older release's) is beacons', and is moved to the current one.
  const s = scratch()
  mkdirSync(path.dirname(s.p.launcher), { recursive: true })
  symlinkSync(path.join(s.p.releasesDir, "0.0.9", "bin", "beacons"), s.p.launcher)
  const f = fakes(s)
  await applySetup((await planSetup(s.p, s.env, f.deps)).plan, s.p, f.deps)
  assert.equal(readlinkSync(s.p.launcher), release(s))
  assert.equal(settings(path.join(s.home, ".claude")).statusLine.command, `${s.p.launcher} status --line`)
})

// --- the steps and their order --------------------------------------------

test("setup: the steps run in order, each profile gets its route, plugin and status line", async () => {
  const s = scratch()
  const claude = path.join(s.home, ".claude")
  const seen: string[] = []
  const f = fakes(s, {
    answer: (cmd, args) => {
      if (cmd === "launchctl" && args[0] === "bootstrap") {
        seen.push(`bootstrap: release ${existsSync(path.join(s.p.currentRelease, "release.json"))}, gateway ${existsSync(s.p.gatewayFile)}, routes ${existsSync(s.p.routesFile)}`)
        seen.push(`order: ${readPool(s.p.accountsFile).accounts.map((a) => `${a.name}=${a.priority}`).join(" ")}`)
      }
      if (cmd === "env" && args.includes("install")) seen.push(`install: routed ${settings(claude).env?.ANTHROPIC_BASE_URL}`)
      if (args[0] === "status") return { code: 0, stdout: "beacons 0.1.0 is serving\n" }
      return undefined
    },
  })
  const { plan } = await planSetup(s.p, s.env, f.deps)
  plan.order = ["b", "a@example.com"]
  await applySetup(plan, s.p, f.deps)

  assert.deepEqual(seen, [
    "bootstrap: release true, gateway true, routes false",
    "order: a@example.com=1 b=0",
    "install: routed http://127.0.0.1:4774/pool/a%40example.com",
  ])
  const env = `CLAUDE_CONFIG_DIR=${claude}`
  const steps = f.log.filter((l) => !l.startsWith("run launchctl bootout"))
  assert.deepEqual(steps, [
    `run launchctl bootstrap gui/${uid} ${s.unit}`,
    "reload 4774",
    `run env ${env} claude plugin marketplace add OrodruinLabs/beacons`,
    `run env ${env} claude plugin install beacons@beacons`,
    "probe http://127.0.0.1:4774/pool/a%40example.com",
    `run ${path.join(s.p.currentRelease, "bin", "beacons")} status`,
  ])
  assert.deepEqual(json(s.p.gatewayFile), { port: 4774, upstreamUrl: "https://api.anthropic.com", chainFallback: "wait" })
  assert.equal(readRoutes(s.p).profiles[claude].plugin, true)
  assert.equal(readlinkSync(s.p.launcher), path.join(s.p.currentRelease, "bin", "beacons"))
  assert.ok(f.lines.some((l) => l.includes(`export PATH="${path.dirname(s.p.launcher)}:$PATH"`)), f.lines.join("\n"))
  assert.ok(f.lines.includes("beacons 0.1.0 is serving"))
})

test("setup: with ~/.local/bin on PATH it prints no PATH line", async () => {
  const s = scratch()
  const env = { ...s.env, PATH: `${path.dirname(s.p.launcher)}:/usr/bin` }
  const f = fakes(s, { env })
  const { plan } = await planSetup(s.p, env, f.deps)
  await applySetup(plan, s.p, f.deps)
  assert.ok(!f.lines.some((l) => l.includes("export PATH")), f.lines.join("\n"))
})

test("setup: a profile routed to another gateway is left alone unless --replace names it", async () => {
  const s = scratch()
  const other = path.join(s.home, ".claude-other"), kept = path.join(s.home, ".claude-kept")
  write(path.join(other, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9999/x" } }))
  write(path.join(kept, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9998/y" } }))
  const f = fakes(s)
  const { plan, found } = await planSetup(s.p, s.env, f.deps)
  assert.deepEqual(found.elsewhere, { [other]: "http://127.0.0.1:9999/x", [kept]: "http://127.0.0.1:9998/y" })
  assert.ok(!plan.profiles.includes(other) && !plan.profiles.includes(kept))

  const t = printer()
  const code = await setupCommand(["--yes", "--replace", other], s.env, { input: t.input, output: t.output, deps: f.deps })
  assert.equal(code, 0, t.text() + f.lines.join("\n"))
  assert.match(settings(other).env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:4774\/pool\//)
  assert.equal(readRoutes(s.p).profiles[other].replaced, "http://127.0.0.1:9999/x")
  assert.equal(settings(kept).env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9998/y")
})

test("setup: a start that never answers removes a fresh unit and says where the log is", async () => {
  const s = scratch()
  const f = fakes(s, { healthy: () => false })
  const { plan } = await planSetup(s.p, s.env, f.deps)
  await assert.rejects(applySetup(plan, s.p, f.deps), /did not answer within 0\.2 s.*removed.*daemon\.log/s)
  assert.ok(f.log.some((l) => l.startsWith("run launchctl bootstrap")))
  assert.ok(!existsSync(s.unit), "the unit is gone, so nothing restarts it in a loop")
  assert.ok(!existsSync(path.join(s.home, ".claude", "settings.json")), "no profile was routed")
})

// --- a re-run: the new build must be the one serving ----------------------

test("setup: a re-run on systemd restarts the running daemon and waits for the new version", async () => {
  const s = scratch()
  earlier(s)
  let serving: string | null = "0.0.9"
  const f = fakes(s, {
    platform: "linux",
    health: () => { f.log.push(`health ${serving}`); return serving === null ? null : { version: serving } },
    answer: (cmd, args) => {
      if (cmd === "loginctl") return { code: 0, stdout: "Linger=yes\n" }
      // systemctl restart: the old daemon drains, then the switched build boots.
      if (cmd === "systemctl" && args.join(" ") === "--user restart beacons.service") serving = null
      return undefined
    },
  })
  const { plan } = await planSetup(s.p, s.env, f.deps)
  let polls = 0
  f.deps.sleep = async () => { if (serving === null && ++polls === 3) serving = readReleaseState(s.p).current }
  await applySetup(plan, s.p, f.deps)

  const at = (line: string) => f.log.indexOf(line)
  assert.ok(at("bootCheck 0.1.0") >= 0, f.log.join("\n"))
  assert.ok(at("bootCheck 0.1.0") < at("run systemctl --user enable --now beacons.service"))
  assert.ok(at("run systemctl --user enable --now beacons.service") < at("run systemctl --user restart beacons.service"))
  const restarted = at("run systemctl --user restart beacons.service")
  const confirmed = f.log.indexOf("health 0.1.0", restarted)
  assert.ok(confirmed > restarted && f.log.slice(restarted, confirmed).includes("health null"), f.log.join("\n"))
  assert.ok(confirmed < f.log.findIndex((l) => l.startsWith("run env")))
  assert.equal(readReleaseState(s.p).current, "0.1.0")
  assert.equal(readReleaseState(s.p).previous, "0.0.9")
})

test("setup: a re-run whose new build does not boot changes nothing and leaves current alone", async () => {
  const s = scratch()
  const { bytes } = earlier(s)
  const before = bytes()
  const f = fakes(s, { health: () => ({ version: "0.0.9" }), bootCheck: async () => { throw new Error("exited 1 before answering: boom") } })
  const { plan } = await planSetup(s.p, s.env, f.deps)
  await assert.rejects(applySetup(plan, s.p, f.deps), /release 0\.1\.0 did not boot \(exited 1 before answering: boom\)\. Setup stopped before switching/)
  assert.equal(path.basename(readlinkSync(s.p.currentRelease)), "0.0.9")
  assert.deepEqual(readReleaseState(s.p), { current: "0.0.9", previous: null, held: null })
  assert.deepEqual(bytes(), before)
  assert.ok(!f.log.some((l) => l.startsWith("run ")), f.log.join("\n"))
})

test("setup: a re-run whose new build never reports its version switches back and starts the old one again", async () => {
  const s = scratch()
  const { bytes } = earlier(s)
  const [, gatewayBefore, routesBefore, settingsBefore] = bytes()
  // The old build keeps answering: the new one never comes up in its place.
  const f = fakes(s, { health: () => ({ version: "0.0.9" }) })
  const { plan } = await planSetup(s.p, s.env, f.deps)
  await assert.rejects(applySetup(plan, s.p, f.deps), new RegExp(
    "reports 0\\.0\\.9, not 0\\.1\\.0, after 0\\.2 s; switched back to 0\\.0\\.9, and 0\\.1\\.0 is held; " +
    "gateway\\.json is as it was, while the accounts, their order and any sign-ins are kept; " +
    "its unit was installed again and started on 0\\.0\\.9\\. No profile was changed\\."))
  assert.deepEqual(readReleaseState(s.p), { current: "0.0.9", previous: "0.1.0", held: "0.1.0" })
  assert.equal(path.basename(readlinkSync(s.p.currentRelease)), "0.0.9")
  // launchd: bootout and bootstrap restart it, both onto the new build and back; no kickstart on top.
  const bootstrap = `run launchctl bootstrap gui/${uid} ${s.unit}`
  assert.equal(f.log.filter((l) => l === bootstrap).length, 2, f.log.join("\n"))
  assert.equal(f.log.at(-1), bootstrap)
  assert.ok(!f.log.some((l) => l.includes("kickstart")), f.log.join("\n"))
  assert.ok(!f.log.some((l) => l.startsWith("run env") || l.startsWith("probe")))
  assert.deepEqual(bytes().slice(1), [gatewayBefore, routesBefore, settingsBefore])
})

test("setup: a launchd re-run restarts the daemon once, through bootout and bootstrap", async () => {
  const s = scratch()
  earlier(s)
  let serving = "0.0.9"
  const f = fakes(s, {
    health: () => ({ version: serving }),
    answer: (cmd, args) => {
      if (cmd === "launchctl" && args[0] === "bootstrap") serving = readReleaseState(s.p).current!
      return undefined
    },
  })
  const { plan } = await planSetup(s.p, s.env, f.deps)
  await applySetup(plan, s.p, f.deps)
  assert.equal(f.log.filter((l) => l.startsWith("run launchctl bootstrap")).length, 1)
  assert.ok(!f.log.some((l) => l.includes("kickstart")), f.log.join("\n"))
  assert.equal(readReleaseState(s.p).current, "0.1.0")
})

test("setup: when the re-run's bootstrap fails, the rollback installs the old release's unit again", async () => {
  const s = scratch()
  const { bytes } = earlier(s)
  const gatewayBefore = bytes()[1]
  let bootstraps = 0
  const f = fakes(s, {
    health: () => ({ version: "0.0.9" }),
    answer: (cmd, args) => {
      // launchd's bootout→bootstrap race: the first bootstrap fails and leaves the service unloaded.
      if (cmd === "launchctl" && args[0] === "bootstrap" && ++bootstraps === 1) return { code: 5, stderr: "Bootstrap failed: 5: Input/output error" }
      if (cmd === "launchctl" && args[0] === "kickstart") return { code: 113, stderr: "Could not find service" }
      return undefined
    },
  })
  const { plan } = await planSetup(s.p, s.env, f.deps)
  await assert.rejects(applySetup(plan, s.p, f.deps), (err: Error) => {
    assert.match(err.message, /beacons could not be started: launchctl bootstrap .*Input\/output error/)
    assert.match(err.message, /switched back to 0\.0\.9, and 0\.1\.0 is held/)
    assert.match(err.message, /its unit was installed again and started on 0\.0\.9/)
    return true
  })
  assert.equal(bootstraps, 2, f.log.join("\n"))
  assert.ok(!f.log.some((l) => l.includes("kickstart")))
  assert.equal(readReleaseState(s.p).current, "0.0.9")
  assert.equal(path.basename(readlinkSync(s.p.currentRelease)), "0.0.9")
  assert.equal(bytes()[1], gatewayBefore)
})

test("setup: a systemd rollback resets the failed state before restarting, and removes a gateway.json there was not", async () => {
  const s = scratch()
  earlier(s, { gateway: false })
  const f = fakes(s, {
    platform: "linux",
    health: () => ({ version: "0.0.9" }),
    answer: (cmd) => (cmd === "loginctl" ? { code: 0, stdout: "Linger=yes\n" } : cmd === "systemctl" ? { code: 0 } : undefined),
  })
  const { plan } = await planSetup(s.p, s.env, f.deps)
  await assert.rejects(applySetup(plan, s.p, f.deps), /switched back to 0\.0\.9.*the service was restarted on 0\.0\.9/s)
  const restart = "run systemctl --user restart beacons.service"
  const reset = "run systemctl --user reset-failed beacons.service"
  assert.ok(f.log.includes(reset), f.log.join("\n"))
  assert.equal(f.log.at(-1), restart)
  assert.equal(f.log.at(-2), reset)
  assert.ok(!existsSync(s.p.gatewayFile), "there was no gateway.json before, so there is none after")
  assert.equal(readReleaseState(s.p).current, "0.0.9")
})

test("setup: the wait for the new build is a clock deadline, however slow each health call is", async () => {
  const s = scratch()
  earlier(s)
  let calls = 0
  const f = fakes(s)
  f.deps.health = async () => { calls++; await new Promise((r) => setTimeout(r, 40)); return { version: "0.0.9" } }
  f.deps.startBudgetMs = 150
  const { plan } = await planSetup(s.p, s.env, f.deps)
  calls = 0
  const t0 = Date.now()
  await assert.rejects(applySetup(plan, s.p, f.deps), /after 0\.15 s/)
  const took = Date.now() - t0
  // Counting polls (250 ms each against 15 s) would make about 60 calls of 40 ms here.
  assert.ok(calls <= 8, `${calls} health calls`)
  assert.ok(took < 1500, `took ${took} ms`)
})

test("setup: with no profile routed, no test request is sent", async () => {
  const s = scratch()
  const f = fakes(s)
  const { plan } = await planSetup(s.p, s.env, f.deps)
  await applySetup({ ...plan, profiles: [], modes: {} }, s.p, f.deps)
  assert.ok(!f.log.some((l) => l.startsWith("probe")), f.log.join("\n"))
  assert.ok(f.lines.includes("no profile is routed, so setup sent no test request"))
})

test("setup: apply uses the command's env, not the env the deps came with", async () => {
  const s = scratch()
  // The deps' env has no ~/.local/bin on PATH, so a setup that used it would print the PATH line.
  const f = fakes(s)
  const t = printer()
  const code = await setupCommand(["--yes"], { ...s.env, PATH: `${path.dirname(s.p.launcher)}:/usr/bin` }, { input: t.input, output: t.output, deps: f.deps })
  assert.equal(code, 0, t.text())
  assert.ok(f.lines.length > 0, "setup ran")
  assert.ok(!f.lines.some((l) => l.includes("export PATH")), f.lines.join("\n"))
})

test("setup: the wizard stops, changing nothing, when its answers run out", async () => {
  const s = scratch()
  const f = fakes(s)
  const before = tree(s.home)
  // No sign-ins, the default profiles, then the input ends before the order, the modes and "Go ahead?".
  const t = terminal(["0", ""])
  const code = await setupCommand([], s.env, { input: t.input, output: t.output, deps: f.deps })
  assert.notEqual(code, 0)
  assert.match(t.text(), /input ended/)
  assert.ok(!t.text().includes("Go ahead?"))
  assert.deepEqual(tree(s.home), before)
  assert.ok(!f.log.some((l) => l.startsWith("run ")), f.log.join("\n"))
})

// --- the real deps, against local fakes only ------------------------------

test("setup: the probe posts one max_tokens 1 message through the route, with no credential of its own", async () => {
  let seen: { method?: string; url?: string; headers?: Record<string, unknown>; body?: any } = {}
  const server = createHttpServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      seen = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body) }
      res.writeHead(200, { "content-type": "application/json" })
      res.end("{}")
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address() as AddressInfo
  try {
    assert.equal(await probeRequest(`http://127.0.0.1:${port}/pool/a%40b.com`), 200)
    assert.equal(seen.method, "POST")
    assert.equal(seen.url, "/pool/a%40b.com/v1/messages")
    assert.equal(seen.body.max_tokens, 1)
    assert.equal(seen.body.messages.length, 1)
    assert.equal(seen.headers?.authorization, undefined)
  } finally {
    server.close()
  }
})

test("setup: the port holder comes from lsof on macOS and ss on Linux", async () => {
  const lsof = "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode    1234 me   20u  IPv4 0x1      0t0  TCP 127.0.0.1:4774 (LISTEN)\n"
  const ss = [
    "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
    "LISTEN 0      511        127.0.0.1:4774       0.0.0.0:*     users:((\"node\",pid=1234,fd=20))",
    "LISTEN 0      4096       127.0.0.1:9100       0.0.0.0:*     users:((\"proxy\",pid=99,fd=3))",
    "",
  ].join("\n")
  const calls: string[] = []
  const run = (out: string, code = 0): Run => async (cmd, args) => { calls.push(`${cmd} ${args.join(" ")}`); return { code, stdout: out, stderr: "" } }
  assert.equal(await findPortHolder(run(lsof), 4774, "darwin"), "node 1234")
  assert.equal(calls.pop(), "lsof -nP -iTCP:4774 -sTCP:LISTEN")
  assert.equal(await findPortHolder(run("", 1), 4774, "darwin"), null)
  assert.equal(await findPortHolder(run(ss), 4774, "linux"), "node 1234")
  assert.equal(calls.pop(), "ss -ltnp")
  assert.equal(await findPortHolder(run(ss), 9100, "linux"), "proxy 99")
  assert.equal(await findPortHolder(run(ss), 4775, "linux"), null)
})
