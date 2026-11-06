// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The sh bootstrap, run as `sh bin/beacons` against a scratch HOME and XDG
// dirs. Node installs come from fixture archives built here with `tar`, served
// from a local file:// folder through BEACONS_NODE_DIST, and checked against a
// node-sha256.txt in a temp copy of the plugin, so the real one stays real. The
// fixture's `bin/node` is a script that prints its arguments. `uname` is a fake
// on PATH, and `curl` a fake that logs its arguments and runs the real one. The
// status-line tests run the real curl against servers on ephemeral ports.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import http from "node:http"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const REPO = fileURLToPath(new URL("..", import.meta.url))
const BOOT = path.join(REPO, "bin", "beacons")
const NODE = "26.13.0"
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]
const REAL_CURL = spawnSync("sh", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim()

type Env = Record<string, string>

/** A scratch HOME with its XDG dirs, a bin dir of fakes first on PATH, and no CLAUDE_CONFIG_DIR. */
function scratch(o: { os?: string; arch?: string } = {}): { dir: string; env: Env; data: string; config: string; curlLog: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "beacons-"))
  const fake = path.join(dir, "fakebin")
  mkdirSync(fake)
  const curlLog = path.join(dir, "curl.log")
  writeFileSync(path.join(fake, "uname"), `#!/bin/sh\ncase "$1" in -m) echo ${o.arch ?? "arm64"} ;; *) echo ${o.os ?? "Darwin"} ;; esac\n`, { mode: 0o755 })
  writeFileSync(path.join(fake, "curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${curlLog}'\nexec '${REAL_CURL}' "$@"\n`, { mode: 0o755 })
  const env: Env = {
    HOME: dir,
    XDG_CONFIG_HOME: path.join(dir, "config"),
    XDG_DATA_HOME: path.join(dir, "data"),
    PATH: `${fake}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  }
  return { dir, env, data: path.join(dir, "data", "beacons"), config: path.join(dir, "config", "beacons"), curlLog }
}

/** Fixture Node archives for every platform, in one folder: each holds more than bin/node. */
function nodeDist(): { dist: string; sha: Record<string, string> } {
  const dist = mkdtempSync(path.join(tmpdir(), "beacons-dist-"))
  const src = mkdtempSync(path.join(tmpdir(), "beacons-src-"))
  const sha: Record<string, string> = {}
  for (const plat of PLATFORMS) {
    const name = `node-v${NODE}-${plat}`
    mkdirSync(path.join(src, name, "bin"), { recursive: true })
    mkdirSync(path.join(src, name, "include", "node"), { recursive: true })
    writeFileSync(path.join(src, name, "bin", "node"), `#!/bin/sh\nprintf '%s\\n' "${plat}" "$@"\n`, { mode: 0o755 })
    writeFileSync(path.join(src, name, "bin", "npm"), "#!/bin/sh\n", { mode: 0o755 })
    writeFileSync(path.join(src, name, "include", "node", "node.h"), "")
    writeFileSync(path.join(src, name, "README.md"), "")
    const file = path.join(dist, `${name}.tar.gz`)
    const r = spawnSync("tar", ["-czf", file, "-C", src, name], { env: { ...process.env, COPYFILE_DISABLE: "1" } })
    assert.equal(r.status, 0, String(r.stderr))
    sha[plat] = createHash("sha256").update(readFileSync(file)).digest("hex")
  }
  return { dist, sha }
}

const sumsFor = (sha: Record<string, string>) => `v${NODE}\n` + PLATFORMS.map((p) => `${sha[p]}  node-v${NODE}-${p}.tar.gz\n`).join("")

/** A temp copy of the plugin: the real bin/beacons, a given node-sha256.txt, a src/cli.ts. Real path. */
function pluginCopy(sums: string): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "beacons-plugin-")))
  mkdirSync(path.join(root, "bin"))
  mkdirSync(path.join(root, "src"))
  copyFileSync(BOOT, path.join(root, "bin", "beacons"))
  writeFileSync(path.join(root, "node-sha256.txt"), sums)
  writeFileSync(path.join(root, "src", "cli.ts"), "")
  return root
}

const boot = (script: string, args: string[], env: Env, input = "") =>
  spawnSync("sh", [script, ...args], { env, input, encoding: "utf8", timeout: 30_000 })

/** Every file under `dir`, relative, sorted. */
function files(dir: string, rel = ""): string[] {
  const out: string[] = []
  for (const n of readdirSync(path.join(dir, rel))) {
    const r = path.join(rel, n)
    if (lstatSync(path.join(dir, r)).isDirectory()) out.push(...files(dir, r))
    else out.push(r)
  }
  return out.sort()
}

/** A port nothing listens on: taken from the OS, then let go. */
async function closedPort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

/** gateway.json with `port`, as saveGatewayConfig writes it, and a profile whose settings.json is `settings`. */
function configure(s: { dir: string; config: string; env: Env }, port: number | null, settings: Record<string, unknown> | null, profileName = "profile"): string {
  if (port !== null) {
    mkdirSync(s.config, { recursive: true })
    writeFileSync(path.join(s.config, "gateway.json"), JSON.stringify({ port, upstreamUrl: "https://api.anthropic.com", chainFallback: "wait" }, null, 2) + "\n")
  }
  const profile = path.join(s.dir, profileName)
  mkdirSync(profile, { recursive: true })
  if (settings !== null) writeFileSync(path.join(profile, "settings.json"), JSON.stringify(settings, null, 2) + "\n")
  return profile
}

/** Run `sh bin/beacons status --line` without blocking this process's event loop, timing it. */
function statusLineAsync(env: Env, input: string): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn("sh", [BOOT, "status", "--line"], { env, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c))
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c))
    const killer = setTimeout(() => child.kill("SIGKILL"), 10_000)
    child.on("close", (code) => {
      clearTimeout(killer)
      resolve({ code, stdout, stderr, ms: Date.now() - t0 })
    })
    child.stdin.end(input)
  })
}

const STATUS_IN = (sid: string) => JSON.stringify({ session_id: sid, transcript_path: "/x/y.jsonl", cwd: "/x", model: { id: "m", display_name: "M" } })

// --- the Node install ------------------------------------------------------

test("bootstrap: a checksum mismatch refuses and leaves no node", () => {
  const { dist, sha } = nodeDist()
  const root = pluginCopy(sumsFor({ ...sha, "darwin-arm64": "0".repeat(64) }))
  const s = scratch()
  const r = boot(path.join(root, "bin", "beacons"), ["status"], { ...s.env, BEACONS_NODE_DIST: pathToFileURL(dist).href })
  assert.equal(r.status, 1, r.stderr)
  assert.match(r.stderr, new RegExp(`node-v${NODE}-darwin-arm64\\.tar\\.gz`))
  assert.match(r.stderr, /SHA-256/)
  assert.equal(r.stdout, "")
  assert.equal(existsSync(path.join(s.data, "node", NODE)), false)
  assert.equal(existsSync(path.join(s.data, "node", "current")), false)
  // No download left behind.
  assert.deepEqual(existsSync(path.join(s.data, "node")) ? readdirSync(path.join(s.data, "node")) : [], [])
})

test("bootstrap: a good archive installs only bin/node", () => {
  const { dist, sha } = nodeDist()
  const root = pluginCopy(sumsFor(sha))
  const s = scratch()
  const env = { ...s.env, BEACONS_NODE_DIST: pathToFileURL(dist).href }
  const r = boot(path.join(root, "bin", "beacons"), ["status", "a b"], env)
  assert.equal(r.status, 0, r.stderr)
  // The CLI ran on the installed Node, with strip-types, from this copy's src.
  assert.deepEqual(r.stdout.split("\n"), ["darwin-arm64", "--experimental-strip-types", "--no-warnings", path.join(root, "src", "cli.ts"), "status", "a b", ""])
  assert.deepEqual(readdirSync(path.join(s.data, "node")).sort(), [NODE, "current"])
  assert.deepEqual(files(path.join(s.data, "node", NODE)), [path.join("bin", "node")])
  assert.equal(statSync(path.join(s.data, "node", NODE, "bin", "node")).mode & 0o777, 0o755)
  assert.equal(readlinkSync(path.join(s.data, "node", "current")), NODE)
  assert.equal(statSync(s.data).mode & 0o777, 0o700)
  assert.equal(statSync(path.join(s.data, "node")).mode & 0o777, 0o700)
  const log = readFileSync(s.curlLog, "utf8")
  assert.ok(log.includes(`${pathToFileURL(dist).href}/node-v${NODE}-darwin-arm64.tar.gz`), log)
  assert.ok(log.startsWith("-q "), log)

  // A second run uses the Node it has: no download.
  const again = boot(path.join(root, "bin", "beacons"), ["x"], env)
  assert.equal(again.status, 0, again.stderr)
  assert.equal(again.stdout.split("\n").at(-2), "x")
  assert.equal(readFileSync(s.curlLog, "utf8"), log)
})

test("bootstrap: a backslash in the data folder's path does not upset the check", () => {
  // GNU sha256sum escapes a file name with a backslash, and marks its line with one: the archive is hashed on stdin.
  const { dist, sha } = nodeDist()
  const root = pluginCopy(sumsFor(sha))
  const s = scratch()
  const env = { ...s.env, XDG_DATA_HOME: path.join(s.dir, "da\\ta"), BEACONS_NODE_DIST: pathToFileURL(dist).href }
  const r = boot(path.join(root, "bin", "beacons"), ["x"], env)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(path.join(s.dir, "da\\ta", "beacons", "node", NODE, "bin", "node")))
})

test("bootstrap: an existing node/current is left for switchTo to move", () => {
  const { dist, sha } = nodeDist()
  const root = pluginCopy(sumsFor(sha))
  const s = scratch()
  mkdirSync(path.join(s.data, "node", "27.0.0", "bin"), { recursive: true })
  symlinkSync(path.join(s.data, "node", "27.0.0"), path.join(s.data, "node", "current"))
  const r = boot(path.join(root, "bin", "beacons"), ["x"], { ...s.env, BEACONS_NODE_DIST: pathToFileURL(dist).href })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readlinkSync(path.join(s.data, "node", "current")), path.join(s.data, "node", "27.0.0"))
  assert.ok(existsSync(path.join(s.data, "node", NODE, "bin", "node")))
  // It runs its own Node, by version, not node/current.
  assert.equal(r.stdout.split("\n")[0], "darwin-arm64")
})

test("bootstrap: each platform fetches its own archive", () => {
  const { dist, sha } = nodeDist()
  const root = pluginCopy(sumsFor(sha))
  for (const [os, arch, plat] of [
    ["Darwin", "arm64", "darwin-arm64"],
    ["Darwin", "x86_64", "darwin-x64"],
    ["Linux", "x86_64", "linux-x64"],
    ["Linux", "aarch64", "linux-arm64"],
    ["Linux", "arm64", "linux-arm64"],
  ]) {
    const s = scratch({ os, arch })
    const r = boot(path.join(root, "bin", "beacons"), ["x"], { ...s.env, BEACONS_NODE_DIST: pathToFileURL(dist).href })
    assert.equal(r.status, 0, `${os} ${arch}: ${r.stderr}`)
    assert.equal(r.stdout.split("\n")[0], plat, `${os} ${arch}`)
    assert.ok(readFileSync(s.curlLog, "utf8").includes(`/node-v${NODE}-${plat}.tar.gz`), `${os} ${arch}`)
  }
})

test("bootstrap: an unsupported os or arch is refused before any download", () => {
  const { dist, sha } = nodeDist()
  const root = pluginCopy(sumsFor(sha))
  for (const [os, arch, named] of [["FreeBSD", "amd64", "FreeBSD"], ["Linux", "riscv64", "riscv64"], ["Darwin", "i386", "i386"]]) {
    const s = scratch({ os, arch })
    const r = boot(path.join(root, "bin", "beacons"), ["x"], { ...s.env, BEACONS_NODE_DIST: pathToFileURL(dist).href })
    assert.equal(r.status, 1, `${os} ${arch}`)
    assert.ok(r.stderr.includes(named), r.stderr)
    assert.equal(existsSync(s.curlLog), false, `${os} ${arch} downloaded`)
    assert.equal(existsSync(path.join(s.data, "node", NODE)), false)
  }
})

test("bootstrap: a symlinked launcher finds its own root", () => {
  const { dist, sha } = nodeDist()
  const root = pluginCopy(sumsFor(sha))
  const s = scratch()
  // ~/.local/bin/beacons → ../../links/beacons (relative) → <root>/bin/beacons (absolute)
  mkdirSync(path.join(s.dir, ".local", "bin"), { recursive: true })
  mkdirSync(path.join(s.dir, "links"))
  symlinkSync(path.join(root, "bin", "beacons"), path.join(s.dir, "links", "beacons"))
  symlinkSync(path.join("..", "..", "links", "beacons"), path.join(s.dir, ".local", "bin", "beacons"))
  const r = boot(path.join(s.dir, ".local", "bin", "beacons"), ["x"], { ...s.env, BEACONS_NODE_DIST: pathToFileURL(dist).href })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.split("\n")[3], path.join(root, "src", "cli.ts"))
})

test("bootstrap: the CLI runs with BEACONS_ROOT naming the plugin copy it came from", () => {
  const root = pluginCopy(`v${NODE}\n`)
  const s = scratch()
  // An installed Node that prints what it was given: no download.
  const node = path.join(s.data, "node", NODE, "bin", "node")
  mkdirSync(path.dirname(node), { recursive: true })
  writeFileSync(node, `#!/bin/sh\nprintf '%s\\n' "$BEACONS_ROOT"\n`, { mode: 0o755 })
  // Through a link, as the launcher is, and over a BEACONS_ROOT already set.
  mkdirSync(path.join(s.dir, ".local", "bin"), { recursive: true })
  symlinkSync(path.join(root, "bin", "beacons"), path.join(s.dir, ".local", "bin", "beacons"))
  const r = boot(path.join(s.dir, ".local", "bin", "beacons"), ["upgrade"], { ...s.env, BEACONS_ROOT: "/elsewhere" })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, root + "\n")
})

// --- the status-line fast path ---------------------------------------------

test("bootstrap: status --line answers within 2 s from a hung daemon", async () => {
  const sockets: net.Socket[] = []
  // Accepts, reads, never writes.
  const server = net.createServer((sock) => {
    sockets.push(sock)
    sock.resume()
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as net.AddressInfo).port
  try {
    const s = scratch()
    const profile = configure(s, port, { env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/pool/a%40b.com` } })
    // The real curl: no fake on PATH.
    const env = { ...s.env, PATH: process.env.PATH ?? "/usr/bin:/bin", CLAUDE_CONFIG_DIR: profile }
    const r = await statusLineAsync(env, STATUS_IN("sess-1"))
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, "◕ beacons down\n")
    assert.ok(r.ms < 2000, `took ${r.ms} ms`)
    assert.ok(sockets.length >= 1, "curl never connected")
    // No Node was looked for or fetched.
    assert.equal(existsSync(path.join(s.data, "node")), false)
  } finally {
    for (const sock of sockets) sock.destroy()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test("bootstrap: the user's .curlrc changes neither the status line nor the download", async () => {
  const curlrc = "retry = 2\ninclude\nrange = 0-0\n"
  // Hung daemon: retries would take it past 2 s.
  const sockets: net.Socket[] = []
  const hung = net.createServer((sock) => {
    sockets.push(sock)
    sock.resume()
  })
  await new Promise<void>((r) => hung.listen(0, "127.0.0.1", r))
  // Answering daemon: `include` would put its headers in the line.
  const ok = http.createServer((_req, res) => res.end("◔ beacons pool"))
  await new Promise<void>((r) => ok.listen(0, "127.0.0.1", r))
  try {
    const s = scratch()
    writeFileSync(path.join(s.dir, ".curlrc"), curlrc)
    const hungPort = (hung.address() as net.AddressInfo).port
    const profile = configure(s, hungPort, { env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${hungPort}/pool/a` } })
    const env = { ...s.env, PATH: process.env.PATH ?? "/usr/bin:/bin", CLAUDE_CONFIG_DIR: profile }
    const r = await statusLineAsync(env, STATUS_IN("sess-1"))
    assert.equal(r.stdout, "◕ beacons down\n")
    assert.ok(r.ms < 2000, `took ${r.ms} ms`)

    configure(s, (ok.address() as net.AddressInfo).port, null)
    assert.equal((await statusLineAsync(env, STATUS_IN("sess-1"))).stdout, "◔ beacons pool\n")
  } finally {
    for (const sock of sockets) sock.destroy()
    await new Promise<void>((r) => hung.close(() => r()))
    await new Promise<void>((r) => ok.close(() => r()))
  }

  // `range = 0-0` would fetch one byte of the archive, and fail its check.
  const { dist, sha } = nodeDist()
  const root = pluginCopy(sumsFor(sha))
  const s = scratch()
  writeFileSync(path.join(s.dir, ".curlrc"), curlrc)
  const r = boot(path.join(root, "bin", "beacons"), ["x"], { ...s.env, BEACONS_NODE_DIST: pathToFileURL(dist).href })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(path.join(s.data, "node", NODE, "bin", "node")))
})

test("bootstrap: status --line says direct for an unrouted profile with no daemon", async () => {
  const port = await closedPort()
  const s = scratch()
  // Routed somewhere else entirely: not this gateway.
  const profile = configure(s, port, { env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port + 1}/pool/a` } })
  const r = await statusLineAsync({ ...s.env, CLAUDE_CONFIG_DIR: profile }, STATUS_IN("sess-1"))
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, "◔ beacons direct\n")
  assert.equal(existsSync(path.join(s.data, "node")), false)
  // A profile with no settings.json at all is direct too.
  const bare = configure(s, port, null, "bare")
  assert.equal((await statusLineAsync({ ...s.env, CLAUDE_CONFIG_DIR: bare }, STATUS_IN("sess-1"))).stdout, "◔ beacons direct\n")
})

test("bootstrap: status --line prints the daemon's line for this session and profile", async () => {
  const seen: string[] = []
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? "")
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
    res.end("◑ beacons a@b.com")
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as net.AddressInfo).port
  try {
    const s = scratch()
    const profile = configure(s, port, {}, "my profile@home")
    const r = await statusLineAsync({ ...s.env, CLAUDE_CONFIG_DIR: profile }, STATUS_IN("abc-123_x.y"))
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, "◑ beacons a@b.com\n")
    assert.equal(seen.length, 1)
    const u = new URL(seen[0], "http://x")
    assert.equal(u.pathname, "/beacons/v1/sessions/abc-123_x.y")
    assert.equal(u.searchParams.get("profile"), profile)
    assert.equal(u.searchParams.get("format"), "line")

    // CLAUDE_CONFIG_DIR unset: the profile is ~/.claude. A trailing slash is not part of the name.
    const home = configure(s, port, {}, ".claude")
    await statusLineAsync(s.env, STATUS_IN("abc"))
    await statusLineAsync({ ...s.env, CLAUDE_CONFIG_DIR: home + "/" }, STATUS_IN("abc"))
    assert.deepEqual(seen.slice(1).map((x) => new URL(x, "http://x").searchParams.get("profile")), [home, home])
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test("bootstrap: status --line with no usable session id asks for the profile's line alone", async () => {
  const seen: string[] = []
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? "")
    res.end("◔ beacons pool")
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as net.AddressInfo).port
  try {
    const s = scratch()
    const profile = configure(s, port, {})
    const env = { ...s.env, CLAUDE_CONFIG_DIR: profile }
    const inputs = [STATUS_IN("../../etc/passwd"), STATUS_IN(".."), STATUS_IN("."), STATUS_IN(".hidden"), STATUS_IN("a b"), STATUS_IN("x".repeat(129)), JSON.stringify({ cwd: "/x" }), "", "not json"]
    for (const input of inputs) {
      const r = await statusLineAsync(env, input)
      assert.equal(r.stdout, "◔ beacons pool\n", input)
    }
    for (const u of seen) assert.equal(new URL(u, "http://x").pathname, "/beacons/v1/sessions/-", u)
    assert.equal(seen.length, inputs.length)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test("bootstrap: status --line defaults to port 4774 and ~/.claude", async () => {
  // A fake curl that never connects: no test reaches the real default port.
  const s = scratch()
  writeFileSync(path.join(s.dir, "fakebin", "curl"), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${s.curlLog}'\nexit 7\n`, { mode: 0o755 })
  const home = configure(s, null, { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4774/pin/work" } }, ".claude")
  const r = await statusLineAsync(s.env, STATUS_IN("sess-9"))
  assert.equal(r.stdout, "◕ beacons down\n")
  const args = readFileSync(s.curlLog, "utf8").split("\n")
  // -q only works as the first argument.
  assert.equal(args[0], "-q")
  assert.ok(args.includes("-sf") && args.includes("--max-time") && args[args.indexOf("--max-time") + 1] === "1", args.join(" "))
  const url = new URL(args.find((a) => a.startsWith("http://"))!)
  assert.equal(url.host, "127.0.0.1:4774")
  assert.equal(url.pathname, "/beacons/v1/sessions/sess-9")
  assert.equal(url.searchParams.get("profile"), home)
})
