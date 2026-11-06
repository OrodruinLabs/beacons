// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The smoke test: beacons end to end, in a scratch HOME, the way a user meets it.
//
//   setup (in this process: the real deps, with a fake service manager behind
//   its Run) routes ~/.claude → a `claude -p` stand-in POSTs through the route
//   → the service stops → the SessionStart hook (hooks/session-start, through
//   the release's bin/beacons) starts it again → `bin/beacons upgrade`, from a
//   plugin copy one patch newer, runs while a reply is open: the reply
//   finishes, then the new version answers health → `beacons uninstall`
//   through the launcher link exits 0 and prints its notes, though it deletes
//   the release it runs from.
//
// The service manager is a fake, launchd or systemd by this machine's
// platform. It reads the unit setup wrote and runs the daemon from it as a
// child process, and starts it again when it exits, as KeepAlive and
// Restart=always do. Setup reaches it through its Run; the CLI processes
// reach it through launchctl, systemctl and loginctl stand-ins first on their
// PATH, which hand their arguments to it over loopback. `claude` is a stand-in
// too: `-p` POSTs through the profile's ANTHROPIC_BASE_URL, anything else is
// logged. The upstream is a local fake proxy on loopback, so the chain is on
// and nothing leaves the machine. beacons' Node is a link to the Node
// running this test. Nothing here runs the real claude, launchctl or
// systemctl, and no request is paid for.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { realRun } from "../src/cli.ts"
import { readRoutes } from "../src/config.ts"
import { beaconsPaths } from "../src/paths.ts"
import { readReleaseState } from "../src/release.ts"
import { LABEL, UNIT, type Run } from "../src/service.ts"
import { daemonHealth } from "../src/loopback.ts"
import { applySetup, planSetup, setupDeps, type SetupDeps } from "../src/setup.ts"

const REPO = fileURLToPath(new URL("..", import.meta.url))
const VERSION = (JSON.parse(readFileSync(path.join(REPO, ".claude-plugin", "plugin.json"), "utf8")) as { version: string }).version
/** The Node a release runs on: the first line of node-sha256.txt. */
const NODE = /^v?(\d+\.\d+\.\d+)/.exec(readFileSync(path.join(REPO, "node-sha256.txt"), "utf8"))![1]
const KIND = process.platform === "darwin" ? "launchd" : "systemd"
const UID = process.getuid!()
const ACCOUNT = "a@b.com"
const API_KEY = "sk-test-smoke-not-a-real-key"
/** A prompt holding this word gets a reply that stays open until the test lets it go. */
const HOLD = "hold-this-reply"

type Result = { code: number; stdout: string; stderr: string }
type Ran = { code: number | null; stdout: string; stderr: string; ms: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(pred: () => boolean | Promise<boolean>, ms: number, every = 50): Promise<boolean> {
  const t = Date.now() + ms
  for (;;) {
    if (await pred()) return true
    if (Date.now() >= t) return false
    await sleep(every)
  }
}
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const json = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>

/** One patch above `v`: 0.1.0 → 0.1.1. */
function bump(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)!
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

async function listen(srv: http.Server): Promise<number> {
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
  return (srv.address() as AddressInfo).port
}
function shut(srv: http.Server): Promise<void> {
  srv.closeAllConnections()
  return new Promise((r) => srv.close(() => r()))
}

/** A plugin copy at `version`: the parts a release takes, and bin/beacons to run it. */
function pluginCopy(dir: string, version: string): void {
  for (const part of ["bin", "src", "package.json", "node-sha256.txt"]) cpSync(path.join(REPO, part), path.join(dir, part), { recursive: true })
  const manifest = json(path.join(REPO, ".claude-plugin", "plugin.json"))
  mkdirSync(path.join(dir, ".claude-plugin"))
  writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ ...manifest, version }, null, 2) + "\n")
}

// --- the fake upstream ------------------------------------------------------

const sse = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
const MESSAGE = { id: "msg_smoke", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 1 } }

type Seen = { path: string; headers: http.IncomingHttpHeaders; body: string }

/**
 * A loopback upstream proxy: gateway.json names it and it takes connections,
 * so setup keeps the chain on and beacons sends through it. A streamed message is a short SSE reply; one whose prompt says HOLD stays
 * open after its first event until `release`.
 */
async function fakeUpstream() {
  const seen: Seen[] = []
  const held: (() => void)[] = []
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      seen.push({ path: req.url ?? "", headers: req.headers, body })
      let stream = false
      try {
        stream = (JSON.parse(body) as { stream?: unknown }).stream === true
      } catch {
        // Not JSON: answered as a plain message.
      }
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ...MESSAGE, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }))
        return
      }
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(sse("message_start", { message: MESSAGE }))
      const finish = () => {
        res.write(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }))
        res.write(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }))
        res.write(sse("content_block_stop", { index: 0 }))
        res.write(sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }))
        res.write(sse("message_stop", {}))
        res.end()
      }
      if (body.includes(HOLD)) held.push(finish)
      else finish()
    })
  })
  const port = await listen(srv)
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    held: () => held.length,
    release: () => {
      for (const f of held.splice(0)) f()
    },
    close: () => shut(srv),
  }
}

// --- the fake service manager ---------------------------------------------

type Unit = { program: string[]; env: Record<string, string> }

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")

/** The program and environment of the launchd plist renderLaunchd wrote. */
function parsePlist(text: string): Unit {
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)
  const vars = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)
  assert.ok(args && vars, `the plist names a program and its environment:\n${text}`)
  const program = [...args[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1]))
  const env = Object.fromEntries([...vars[1].matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)].map((m) => [unxml(m[1]), unxml(m[2])]))
  return { program, env }
}

/** systemd's words, as far as renderSystemd uses them: "quoted" with \\ and \" inside, else bare. */
const words = (line: string) => [...line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]))

/** The program and environment of the systemd unit renderSystemd wrote: `%` doubled everywhere, `$` in ExecStart. */
function parseSystemd(text: string): Unit {
  const exec = /^ExecStart=(.*)$/m.exec(text)
  assert.ok(exec, `the unit has an ExecStart:\n${text}`)
  const program = words(exec[1]).map((w) => w.replace(/%%/g, "%").replace(/\$\$/g, "$"))
  const env: Record<string, string> = {}
  for (const m of text.matchAll(/^Environment=(.*)$/gm)) {
    const kv = words(m[1])[0].replace(/%%/g, "%")
    const i = kv.indexOf("=")
    env[kv.slice(0, i)] = kv.slice(i + 1)
  }
  return { program, env }
}

/**
 * launchd or systemd, as far as beacons asks them: load a unit, start it,
 * stop it, unload it. The daemon runs as a child process, from the unit as
 * written; while the service is wanted, a daemon that exits is started again
 * after 100 ms (KeepAlive, Restart=always). `halt` stops the daemon and leaves
 * the unit loaded: a service that is down until something starts it.
 */
function serviceManager(unitFile: string) {
  let unit: Unit | null = null
  let child: ChildProcess | null = null
  let wanted = false
  let starts = 0
  let output = ""
  const calls: string[] = []
  const unknown: string[] = []

  const start = (): void => {
    if (!unit || child) return
    const c = spawn(unit.program[0], unit.program.slice(1), { env: unit.env, stdio: ["ignore", "pipe", "pipe"] })
    child = c
    starts++
    c.stdout!.setEncoding("utf8").on("data", (d: string) => (output += d))
    c.stderr!.setEncoding("utf8").on("data", (d: string) => (output += d))
    c.on("error", (err) => (output += `the daemon did not start: ${err.message}\n`))
    c.once("exit", () => {
      if (child === c) child = null
      if (wanted) setTimeout(() => wanted && start(), 100)
    })
  }
  const stop = async (): Promise<void> => {
    wanted = false
    const c = child
    if (!c) return
    const gone = new Promise<void>((r) => c.once("exit", () => r()))
    c.kill("SIGTERM")
    const hard = setTimeout(() => c.kill("SIGKILL"), 5000)
    await gone
    clearTimeout(hard)
  }
  const ok = (stdout = ""): Result => ({ code: 0, stdout, stderr: "" })
  const no = (code: number, stderr: string): Result => ({ code, stdout: "", stderr })
  const service = `gui/${UID}/${LABEL}`

  async function handle(cmd: string, args: string[]): Promise<Result> {
    calls.push([cmd, ...args].join(" "))
    const [a, b, c] = args
    if (cmd === "launchctl" && KIND === "launchd") {
      if (a === "bootstrap" && b === `gui/${UID}` && c === unitFile && args.length === 3) {
        if (unit) return no(5, "Bootstrap failed: 5: Input/output error")
        unit = parsePlist(readFileSync(c, "utf8"))
        wanted = true
        start()
        return ok()
      }
      if (a === "bootout" && b === service && args.length === 2) {
        if (!unit) return no(3, "Boot-out failed: 3: No such process")
        await stop()
        unit = null
        return ok()
      }
      if (a === "kickstart" && args[args.length - 1] === service && (args.length === 2 || (args.length === 3 && b === "-k"))) {
        if (!unit) return no(113, `Could not find service "${LABEL}" in domain for user gui: ${UID}`)
        if (b === "-k") await stop()
        wanted = true
        start()
        return ok()
      }
    }
    if (cmd === "systemctl" && KIND === "systemd" && a === "--user") {
      const rest = args.slice(1).join(" ")
      if (rest === "daemon-reload" || rest === `reset-failed ${UNIT}`) return ok()
      if (rest === `enable --now ${UNIT}`) {
        unit = parseSystemd(readFileSync(unitFile, "utf8"))
        wanted = true
        start()
        return ok()
      }
      if (rest === `disable --now ${UNIT}`) {
        await stop()
        unit = null
        return ok()
      }
      if (rest === `start ${UNIT}` || rest === `restart ${UNIT}`) {
        if (!unit) return no(5, `Failed to start ${UNIT}: Unit ${UNIT} not found.`)
        if (b === "restart") await stop()
        wanted = true
        start()
        return ok()
      }
    }
    if (cmd === "loginctl" && a === "show-user") return ok("Linger=yes\n")
    unknown.push([cmd, ...args].join(" "))
    return no(127, `the smoke test's service manager does not know: ${cmd} ${args.join(" ")}`)
  }

  return {
    handle,
    calls,
    unknown,
    starts: () => starts,
    running: () => child !== null,
    output: () => output,
    halt: stop,
    /** Everything down, for `finally`. */
    shutdown: () => {
      wanted = false
      child?.kill("SIGKILL")
    },
  }
}

/**
 * The service manager over loopback, for the CLI processes: a POST /run whose
 * body is the command and its arguments, one per line. The answer is the exit
 * code on the first line, then the output.
 */
async function controlServer(handle: (cmd: string, args: string[]) => Promise<Result>) {
  const srv = http.createServer((req, res) => {
    let body = ""
    req.setEncoding("utf8").on("data", (c: string) => (body += c))
    req.on("end", () => {
      const [cmd, ...args] = body.replace(/\n$/, "").split("\n")
      void handle(cmd, args).then((r) => {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end(`${r.code}\n${r.code === 0 ? r.stdout : r.stderr}`)
      })
    })
  })
  const port = await listen(srv)
  return { port, close: () => shut(srv) }
}

/** A stand-in for a service tool: its arguments go to the control server, its answer comes back as output and an exit code. */
const toolShim = (control: number) => `#!/bin/sh
# The smoke test's stand-in: hands its arguments to the fake service manager.
out=$(printf '%s\\n' "$(basename "$0")" "$@" | curl -q -sS --noproxy '*' --max-time 60 --data-binary @- 'http://127.0.0.1:${control}/run') || exit 70
code=$(printf '%s\\n' "$out" | sed -n 1p)
rest=$(printf '%s\\n' "$out" | sed 1d)
if [ -n "$rest" ]; then
  if [ "$code" = 0 ]; then printf '%s\\n' "$rest"; else printf '%s\\n' "$rest" >&2; fi
fi
exit "$code"
`

/** The `claude` stand-in: `-p <prompt>` is the request below; anything else is logged with its profile. */
const claudeShim = (standin: string, log: string) => `#!/bin/sh
# The smoke test's stand-in for claude.
if [ "\${1:-}" = -p ]; then
  exec ${shq(process.execPath)} ${shq(standin)} "$@"
fi
printf '%s\\t%s\\n' "\${CLAUDE_CONFIG_DIR:-}" "$*" >> ${shq(log)}
exit 0
`

/** `claude -p <prompt>`, as far as beacons sees it: one streamed message through the profile's ANTHROPIC_BASE_URL. */
const STANDIN = `import { readFileSync } from "node:fs"
import path from "node:path"
const profile = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, ".claude")
const base = JSON.parse(readFileSync(path.join(profile, "settings.json"), "utf8")).env?.ANTHROPIC_BASE_URL
if (!base) {
  console.error("no ANTHROPIC_BASE_URL in " + profile)
  process.exit(2)
}
const prompt = process.argv[process.argv.indexOf("-p") + 1] ?? ""
const res = await fetch(base + "/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    authorization: "Bearer the-stand-ins-own-credential",
    "x-claude-code-session-id": process.env.SMOKE_SESSION || "smoke-session",
  },
  body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 64, stream: true, messages: [{ role: "user", content: prompt }] }),
})
const text = await res.text()
process.stdout.write(text, () => process.exit(res.status === 200 ? 0 : 1))
`

// --- child processes --------------------------------------------------------

const children: ChildProcess[] = []

/** Run `cmd` without blocking this process (the control server answers from here), keeping its output. */
function launch(cmd: string, args: string[], env: NodeJS.ProcessEnv, input = ""): { child: ChildProcess; done: Promise<Ran> } {
  const t0 = Date.now()
  const child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] })
  children.push(child)
  let stdout = ""
  let stderr = ""
  child.stdout!.setEncoding("utf8").on("data", (c: string) => (stdout += c))
  child.stderr!.setEncoding("utf8").on("data", (c: string) => (stderr += c))
  const killer = setTimeout(() => child.kill("SIGKILL"), 90_000)
  const done = new Promise<Ran>((resolve) => {
    child.on("error", (err) => (stderr += `${cmd} did not start: ${err.message}\n`))
    child.on("close", (code) => {
      clearTimeout(killer)
      resolve({ code, stdout, stderr, ms: Date.now() - t0 })
    })
  })
  child.stdin!.end(input)
  return { child, done }
}

/** Health over a keep-alive agent: the version, and whether the daemon closes the connection after it, which it does only while leaving. */
function healthOn(port: number, agent: http.Agent): Promise<{ version: string; leaving: boolean } | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/beacons/v1/health", agent, timeout: 2000 }, (res) => {
      let body = ""
      res.setEncoding("utf8").on("data", (c: string) => (body += c))
      res.on("end", () => {
        try {
          resolve({ version: (JSON.parse(body) as { version: string }).version, leaving: res.headers.connection === "close" })
        } catch {
          resolve(null)
        }
      })
    })
    req.on("timeout", () => req.destroy())
    req.on("error", () => resolve(null))
  })
}

// --- the test ---------------------------------------------------------------

test("smoke: setup, a request, a heal, an upgrade under an open reply, and uninstall through the launcher", { timeout: 180_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "beacons-"))
  const fakebin = path.join(home, "fakebin")
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    PATH: `${fakebin}:/usr/bin:/bin`,
  }
  const p = beaconsPaths(env)
  const profile = path.join(home, ".claude")
  const settings = () => json(path.join(profile, "settings.json"))
  const claudeLog = path.join(home, "claude.log")
  const loggedClaude = () => (existsSync(claudeLog) ? readFileSync(claudeLog, "utf8") : "")
  const unitFile = KIND === "launchd" ? path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`) : path.join(home, "config", "systemd", "user", UNIT)

  const up = await fakeUpstream()
  const sm = serviceManager(unitFile)
  const control = await controlServer(sm.handle)
  const agent = new http.Agent({ keepAlive: true })
  const port = await freePort()
  const route = `http://127.0.0.1:${port}/pool/${encodeURIComponent(ACCOUNT)}`
  const claude = path.join(fakebin, "claude")
  try {
    // The stand-ins, and a check that a CLI process finds them before anything real.
    mkdirSync(fakebin)
    for (const tool of ["launchctl", "systemctl", "loginctl"]) writeFileSync(path.join(fakebin, tool), toolShim(control.port), { mode: 0o755 })
    writeFileSync(path.join(home, "standin.mjs"), STANDIN)
    writeFileSync(claude, claudeShim(path.join(home, "standin.mjs"), claudeLog), { mode: 0o755 })
    // One name per `command -v`: dash, Debian's and Ubuntu's sh, answers for the first name only.
    const found = spawnSync("sh", ["-c", "for t in launchctl systemctl loginctl claude; do command -v \"$t\"; done"], { env, encoding: "utf8" })
    assert.deepEqual(found.stdout.trim().split("\n"), ["launchctl", "systemctl", "loginctl", "claude"].map((t) => path.join(fakebin, t)))

    // beacons' Node, "installed": a link to this one. The accounts, the gateway's port and the fake chain, and a profile.
    mkdirSync(path.join(p.nodeDir, NODE, "bin"), { recursive: true })
    symlinkSync(process.execPath, path.join(p.nodeDir, NODE, "bin", "node"))
    mkdirSync(p.configDir, { recursive: true, mode: 0o700 })
    writeFileSync(p.accountsFile, JSON.stringify({ accounts: [{ name: ACCOUNT, type: "apikey", apiKey: API_KEY }], switchThreshold: 0.98, quotaProbeSeconds: 0 }), { mode: 0o600 })
    writeFileSync(p.gatewayFile, JSON.stringify({ port, upstreamUrl: up.url, chainFallback: "wait" }), { mode: 0o600 })
    mkdirSync(profile)
    writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2) + "\n")

    // 1. Setup: setup's own deps, with the service manager behind its Run. claude and the release's
    // bin/beacons run for real, on the stand-ins' PATH; any other command is the test's failure.
    const real = realRun(env, 60_000)
    const run: Run = async (cmd, args) => {
      if (cmd === "launchctl" || cmd === "systemctl" || cmd === "loginctl") return sm.handle(cmd, args)
      if ((cmd === "env" && args.includes("claude")) || cmd === path.join(p.currentRelease, "bin", "beacons")) return real(cmd, args)
      sm.unknown.push([cmd, ...args].join(" "))
      return { code: 127, stdout: "", stderr: `not in the smoke test: ${cmd}` }
    }
    const lines: string[] = []
    const deps: SetupDeps = { ...setupDeps(p, { run, pluginRoot: REPO, env, log: (l) => lines.push(l) }), portHolder: async () => null }
    const { plan, found: seen } = await planSetup(p, env, deps)
    assert.deepEqual(seen.profiles, [profile])
    assert.deepEqual(seen.proxy, { url: up.url, answers: true, source: "gateway" }, "gateway.json's proxy is kept, and it answers")
    assert.deepEqual(plan.modes, { [profile]: { mode: "pool", account: ACCOUNT } })
    assert.equal(plan.chain.url, up.url)
    await applySetup(plan, p, deps)

    assert.deepEqual(settings(), {
      theme: "dark",
      env: { ANTHROPIC_BASE_URL: route },
      statusLine: { type: "command", command: `${p.launcher} status --line`, refreshInterval: 30 },
    })
    assert.equal(readRoutes(p).profiles[profile]?.plugin, true)
    assert.deepEqual(readReleaseState(p), { current: VERSION, previous: null, held: null })
    assert.equal(readlinkSync(p.launcher), path.join(p.currentRelease, "bin", "beacons"))
    assert.equal(json(p.gatewayFile).upstreamUrl, up.url, "on through the chain")
    assert.equal((await daemonHealth(port))?.version, VERSION)
    assert.ok(sm.calls.includes(KIND === "launchd" ? `launchctl bootstrap gui/${UID} ${unitFile}` : `systemctl --user enable --now ${UNIT}`), sm.calls.join("\n"))
    assert.ok(lines.includes(`a test request through ${route} answered 200`), lines.join("\n"))
    assert.ok(lines.join("\n").split("\n").includes(`beacons ${VERSION}, on 127.0.0.1:${port}`), `the release's own \`beacons status\` ran:\n${lines.join("\n")}`)
    assert.ok(loggedClaude().split("\n").includes(`${profile}\tplugin install beacons@beacons`), loggedClaude())
    assert.equal(up.seen.length, 1, "setup's one test request")

    // 2. `claude -p` through the route: the account's key goes upstream, never the client's own credential.
    const asked = await launch(claude, ["-p", "hello from the smoke test"], { ...env, SMOKE_SESSION: "smoke-1" }).done
    assert.equal(asked.code, 0, asked.stdout + asked.stderr)
    assert.match(asked.stdout, /"type":"message_stop"/)
    const last = up.seen[up.seen.length - 1]
    assert.equal(last.path, "/v1/messages")
    assert.equal(last.headers["x-api-key"], API_KEY)
    assert.equal(last.headers.authorization, undefined)
    assert.match(last.body, /hello from the smoke test/)
    // The status line's fast path (sh, curl, no Node) names the account that served the session.
    const line = await launch(p.launcher, ["status", "--line"], env, JSON.stringify({ session_id: "smoke-1" })).done
    assert.equal(line.stdout, `◔ beacons ${ACCOUNT}\n`, line.stderr)

    // 3. The service stops; the SessionStart hook, as Claude Code runs it, starts it again inside its 5 s.
    await sm.halt()
    assert.equal(await daemonHealth(port), null)
    const hook = await launch("sh", [path.join(REPO, "hooks", "session-start")], { ...env, CLAUDE_PLUGIN_ROOT: REPO }, JSON.stringify({ session_id: "smoke-2", hook_event_name: "SessionStart", source: "startup" })).done
    assert.equal(hook.code, 0, hook.stderr)
    assert.equal(hook.stdout, "{}\n", "healed, so nothing to say")
    assert.ok(hook.ms < 5000, `the hook took ${hook.ms} ms`)
    assert.ok(sm.calls.includes(KIND === "launchd" ? `launchctl kickstart gui/${UID}/${LABEL}` : `systemctl --user start ${UNIT}`), sm.calls.join("\n"))
    assert.equal((await daemonHealth(port))?.version, VERSION)

    // 4. An upgrade to a plugin copy one patch newer, with a reply open: the old daemon waits for it.
    const next = bump(VERSION)
    const copy = mkdtempSync(path.join(tmpdir(), "beacons-plugin-"))
    pluginCopy(copy, next)
    const held = launch(claude, ["-p", `${HOLD} please`], { ...env, SMOKE_SESSION: "smoke-3" })
    assert.ok(await until(() => up.held() === 1, 10_000), "the reply is open upstream")
    const startsBefore = sm.starts()
    const upgrading = launch("sh", [path.join(copy, "bin", "beacons"), "upgrade"], env)
    // It boots the new build on its own, switches to it, and asks the daemon to leave at its next quiet moment.
    assert.ok(await until(async () => (await healthOn(port, agent))?.leaving === true, 30_000), "the daemon was asked to leave")
    assert.equal(readReleaseState(p).current, next)
    await sleep(300)
    assert.deepEqual(await healthOn(port, agent), { version: VERSION, leaving: true }, "the old build serves on while the reply is open")
    assert.equal(held.child.exitCode, null, "the reply is still open")
    assert.equal(sm.starts(), startsBefore, "nothing has restarted the daemon")

    // The reply finishes; then the daemon leaves, the service manager starts the new build, and the upgrade sees it.
    up.release()
    const finished = await held.done
    assert.equal(finished.code, 0, finished.stdout + finished.stderr)
    assert.match(finished.stdout, /"type":"message_stop"/, "the open reply finished whole")
    const upgraded = await upgrading.done
    assert.equal(upgraded.code, 0, upgraded.stdout + upgraded.stderr)
    assert.ok(upgraded.stdout.includes(`beacons ${next} is running`), upgraded.stdout)
    assert.equal((await daemonHealth(port))?.version, next)
    assert.deepEqual(readReleaseState(p), { current: next, previous: VERSION, held: null })
    assert.equal(sm.starts(), startsBefore + 1)
    const after = await launch(claude, ["-p", "after the upgrade"], { ...env, SMOKE_SESSION: "smoke-4" }).done
    assert.equal(after.code, 0, after.stdout + after.stderr)
    assert.match(up.seen[up.seen.length - 1].body, /after the upgrade/)

    // 5. `beacons uninstall` through the launcher link: it deletes the release it runs from, and still finishes.
    const gone = await launch(p.launcher, ["uninstall"], env).done
    assert.equal(gone.code, 0, gone.stdout + gone.stderr)
    assert.equal(gone.stderr, "")
    assert.ok(gone.stdout.startsWith("beacons is uninstalled.\n"), gone.stdout)
    assert.ok(gone.stdout.split("\n").filter((l) => l.startsWith("- ")).length > 0, gone.stdout)
    assert.ok(gone.stdout.includes(`- ${p.configDir} was kept, with your accounts`), gone.stdout)
    assert.equal(existsSync(p.dataDir), false, "the data folder, the running release in it, is gone")
    assert.throws(() => lstatSync(p.launcher), "the launcher is gone")
    assert.equal(existsSync(unitFile), false)
    assert.ok(sm.calls.includes(KIND === "launchd" ? `launchctl bootout gui/${UID}/${LABEL}` : `systemctl --user disable --now ${UNIT}`), sm.calls.join("\n"))
    assert.equal(sm.running(), false)
    assert.equal(await daemonHealth(port), null)
    assert.deepEqual(settings(), { theme: "dark" }, "the profile is as it was")
    assert.ok(loggedClaude().split("\n").includes(`${profile}\tplugin uninstall beacons@beacons`), loggedClaude())
    assert.ok(existsSync(p.accountsFile), "the accounts stay without --purge")
    assert.deepEqual(sm.unknown, [], "nothing ran that the test does not know")
  } catch (err) {
    // The daemons' own output, which says why one did not start or answer.
    if (err instanceof Error) err.message += `\n--- daemon output ---\n${sm.output().slice(-4000)}`
    throw err
  } finally {
    sm.shutdown()
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL")
    agent.destroy()
    await control.close()
    await up.close()
  }
})
