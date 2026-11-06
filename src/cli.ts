// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The beacons CLI: one verb for each piece the earlier modules build.
//
//   setup ...                  src/setup.ts owns the whole verb: its flags, its wizard, --plan
//   login, logout, order       the accounts file; then the running daemon re-reads it
//   route                      one profile through beacons, pooled or pinned
//   off [profile...]           each profile back to what it had before beacons, its record
//                              parked in routes.json; the service keeps running
//   on [profile...]            the parked profiles routed again, as they were
//   status [--line]            the daemon's own account of itself; --line is the status bar's
//   upgrade, rollback          the patient upgrade, and one step back
//   uninstall [--purge]        undo setup
//   hook session-start         the plugin's SessionStart hook
//
// The plugin copy (setup, upgrade, the hook) is CLAUDE_PLUGIN_ROOT, else
// BEACONS_ROOT, which bin/beacons sets to the folder it runs from. Exit codes:
// 0 done, 1 failed, 2 an unknown verb or bad usage; `status` exits 1 when the
// daemon does not answer (its report still goes to stdout). Errors go to stderr.
// Every external effect goes through a `Run` (the real one has no shell and a
// timeout) and loopback HTTP, so tests drive `main` with fakes.
import { execFile, type ExecFileException } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { accountNames, login, logout, notifyReload, order, readPool, type LoginDeps } from "./accounts.ts"
import { proxyAnswers } from "./chain.ts"
import { DEFAULT_PORT, loadGatewayConfig, readRoutes, writeRoutes, type ProfileRoute, type RoutesFile } from "./config.ts"
import { hookDeps, sessionStartHook } from "./hook.ts"
import { daemonHealth, loopbackUrl, post, whyNoAnswer } from "./loopback.ts"
import { beaconsPaths, type Paths } from "./paths.ts"
import { resolveProfile, tilde } from "./profiles.ts"
import { pluginVersion, readReleaseState } from "./release.ts"
import { routeBase } from "./route.ts"
import { baseUrlIn, replacedProxy, route, unroute } from "./routes.ts"
import { kickstart, LABEL, serviceInstalled, type Run } from "./service.ts"
import { readSettings } from "./settings.ts"
import { setupCommand, setupDeps } from "./setup.ts"
import { fetchStatus, profileLines, renderDown, renderStatus, statusLineSlow } from "./status.ts"
import { uninstall } from "./uninstall.ts"
import { bootCheck, rollback, upgrade, type UpgradeDeps } from "./upgrade.ts"

/** What `main` reads from and writes to, and how it runs things. Each defaults to the real one. */
export type CliIo = {
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  run?: Run
  platform?: NodeJS.Platform
  /** Ends the process. The hook verb calls it once its answer is written. */
  exit?: (code: number) => void
  loginDeps?: LoginDeps
}

const USAGE = [
  "usage: beacons <command>",
  "",
  "  setup                                set beacons up: step by step, or with flags and --plan / --yes",
  "  login [--name <name>]                sign in to one more account, in the browser",
  "  logout <account>                     remove an account",
  "  order <account> <account>...         the order accounts are tried in, first choice first",
  "  route <profile> pool:<account>|pin:<account> [--replace]",
  "                                       route a profile through beacons",
  "  off [<profile>...]                   put profiles back as they were before beacons; the service keeps running",
  "  on [<profile>...]                    route the profiles off took out again",
  "  status [--line]                      the gateway, its accounts and its open sessions",
  "  upgrade [--now]                      move the gateway onto this plugin copy's version",
  "  rollback                             step back one release",
  "  uninstall [--purge]                  undo setup; --purge removes the accounts too",
  "  hook session-start                   the plugin's SessionStart hook",
].join("\n")

/** How long one command run may take: setup installs plugins, upgrade and uninstall talk to the service manager. */
const SETUP_RUN_MS = 10 * 60_000
const SERVICE_RUN_MS = 2 * 60_000
/** Inside the hook's 5 s: a service manager that hangs is given up on. */
const HOOK_RUN_MS = 3000
/** The hook JSON is drained so its writer never blocks; the drain stops listening after this. Nothing waits for it. */
const HOOK_STDIN_MS = 250
const CONTROL_TIMEOUT_MS = 2000
/** The most a command run may print, on each of stdout and stderr. */
const MAX_OUTPUT = 16 * 1024 * 1024
const OFF_NOTE =
  "The service keeps running, so open sessions keep working. A session whose route key was removed stays on beacons until it restarts; one whose earlier route came back moves within seconds. `beacons on` routes these profiles again."
/** The folder this CLI runs from: the plugin copy, or the release, it belongs to. */
const OWN_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)))

class UsageError extends Error {}

type Ctx = {
  env: NodeJS.ProcessEnv
  p: Paths
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout: NodeJS.WritableStream
  platform: NodeJS.Platform
  say(line: string): void
  warn(line: string): void
  exit(code: number): void
  /** The Run for a verb, with that verb's timeout (a fake ignores it). */
  run(timeoutMs: number): Run
  loginDeps?: LoginDeps
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const quoted = (names: string[]) => names.map((n) => `"${n}"`).join(", ")
/** A word as a shell would need it typed. */
const shq = (s: string) => (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
const write = (stream: NodeJS.WritableStream, text: string) => new Promise<void>((resolve) => void stream.write(text, () => resolve()))

/**
 * The real Run: `execFile`, no shell, with `env` and a timeout. It never
 * throws: a non-zero exit is its code, a command not found is 127, one cut off
 * at the timeout is 124, and one stopped for printing more than `maxBuffer` is
 * 1, each with why in stderr.
 */
export function realRun(env: NodeJS.ProcessEnv, timeoutMs: number, maxBuffer = MAX_OUTPUT): Run {
  return (cmd, args) =>
    new Promise((resolve) => {
      const done = (err: ExecFileException | null, stdout: string, stderr: string) => {
        if (!err) return resolve({ code: 0, stdout, stderr })
        const exited = typeof err.code === "number"
        // First: a child stopped for its output is killed too, so it also reads as killed.
        const tooBig = err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        const code = exited ? (err.code as number) : tooBig ? 1 : err.code === "ENOENT" ? 127 : err.killed ? 124 : 1
        const why = exited
          ? ""
          : tooBig
            ? `${cmd}'s output was too large (over ${maxBuffer} bytes), so it was stopped`
            : err.killed
              ? `${cmd} did not finish within ${timeoutMs / 1000} s`
              : err.message
        resolve({ code, stdout: stdout ?? "", stderr: [stderr, why].filter((x) => x).join("\n") })
      }
      try {
        const child = execFile(cmd, args, { env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer, encoding: "utf8" }, done)
        child.stdin?.end()
      } catch (err) {
        resolve({ code: 127, stdout: "", stderr: message(err) })
      }
    })
}

/** All of stdin, or what came within `capMs`. Nothing from a terminal. */
function readStdin(stdin: NodeJS.ReadableStream & { isTTY?: boolean }, capMs?: number): Promise<string> {
  if (stdin.isTTY) return Promise.resolve("")
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let timer: NodeJS.Timeout | undefined
    const onData = (c: Buffer | string) => void chunks.push(typeof c === "string" ? Buffer.from(c, "utf8") : c)
    const done = () => {
      clearTimeout(timer)
      stdin.off("data", onData)
      stdin.off("end", done)
      stdin.off("error", done)
      stdin.pause()
      resolve(Buffer.concat(chunks).toString("utf8"))
    }
    if (capMs !== undefined) timer = setTimeout(done, capMs)
    stdin.on("data", onData)
    stdin.on("end", done)
    stdin.on("error", done)
  })
}

/** Positional words and the flags out of `allowed`; any other flag is bad usage. */
function parseArgs(args: string[], allowed: string[]): { positional: string[]; flags: Set<string> } {
  const positional: string[] = []
  const flags = new Set<string>()
  for (const a of args) {
    if (a.startsWith("-") && a !== "-") {
      if (!allowed.includes(a)) throw new UsageError(`unknown option ${a}`)
      flags.add(a)
    } else positional.push(a)
  }
  return { positional, flags }
}

/** The plugin copy this command acts for: CLAUDE_PLUGIN_ROOT (a hook), else BEACONS_ROOT (bin/beacons). */
function pluginRootOf(env: NodeJS.ProcessEnv): string | null {
  return env.CLAUDE_PLUGIN_ROOT || env.BEACONS_ROOT || null
}

/** The configured port, or the default when gateway.json cannot be read: for the calls that only ask the daemon. */
function portOr(p: Paths): number {
  try {
    return loadGatewayConfig(p).port
  } catch {
    return DEFAULT_PORT
  }
}

/** The upstream proxy's URL when the upstream is a loopback chain; else null. */
function chainUrlOf(upstreamUrl: string): string | null {
  return loopbackUrl(upstreamUrl) !== null ? upstreamUrl : null
}

/**
 * Whether the upstream proxy answers, asked once and only when a record's
 * replaced route is the proxy's (no other answer changes what unroute does):
 * at the configured chain, or else at the route the record kept.
 */
function proxyProbe(p: Paths, routes: RoutesFile | null): () => Promise<boolean> {
  const recs = routes ? [...Object.values(routes.profiles), ...Object.values(routes.off ?? {})] : []
  const kept = recs.find(replacedProxy)
  if (!kept) return async () => false
  let upstream = ""
  try {
    upstream = loadGatewayConfig(p).upstreamUrl
  } catch {
    // The kept route says where the proxy was.
  }
  const url = chainUrlOf(upstream) ?? (kept.replaced as string)
  let asked: Promise<boolean> | null = null
  return () => (asked ??= proxyAnswers(url).catch(() => false))
}

/** Where a profile's requests go now, from its settings.json. */
function goesTo(profile: string): string {
  try {
    const v = baseUrlIn(readSettings(path.join(profile, "settings.json")))
    return v !== null ? `it goes to ${v}` : "it goes direct"
  } catch {
    return "its settings.json cannot be read back"
  }
}

async function reload(c: Ctx): Promise<void> {
  if (await notifyReload(portOr(c.p))) c.say("the running gateway has the change")
  else c.say("beacons is not running; it reads the accounts when it starts")
}

// --- the verbs -----------------------------------------------------------

async function setupVerb(args: string[], c: Ctx): Promise<number> {
  const deps = setupDeps(c.p, { run: c.run(SETUP_RUN_MS), pluginRoot: pluginRootOf(c.env) ?? OWN_ROOT, env: c.env, platform: c.platform, log: c.say })
  return setupCommand(args, c.env, { input: c.stdin, output: c.stdout, deps: { ...deps, loginDeps: c.loginDeps } })
}

async function loginVerb(args: string[], c: Ctx): Promise<number> {
  let name: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--name") name = args[++i]
    else if (a.startsWith("--name=")) name = a.slice("--name=".length)
    else throw new UsageError(`login takes only --name <name>, not ${a}`)
    if (!name) throw new UsageError("--name needs a value")
  }
  await login(c.p.accountsFile, { name }, c.say, c.loginDeps)
  await reload(c)
  return 0
}

async function logoutVerb(args: string[], c: Ctx): Promise<number> {
  if (args.length !== 1) throw new UsageError("logout takes one account name")
  const gone = await logout(c.p.accountsFile, args[0])
  c.say(`removed "${gone.name}"`)
  try {
    const routes = readRoutes(c.p)
    const named = [...Object.entries(routes.profiles), ...Object.entries(routes.off ?? {})].filter(([, r]) => r.account === gone.name)
    for (const [dir, r] of named) {
      c.say(`${tilde(c.p.home, dir)} still names "${gone.name}" (${r.mode}); give it another account with: beacons route ${shq(dir)} pool:<account>`)
    }
  } catch {
    // The accounts changed; the routes can say nothing more.
  }
  await reload(c)
  return 0
}

async function orderVerb(args: string[], c: Ctx): Promise<number> {
  if (args.length === 0) throw new UsageError("order takes the account names, first choice first")
  await order(c.p.accountsFile, args)
  c.say(`accounts are tried in this order: ${quoted(accountNames(c.p.accountsFile))}`)
  await reload(c)
  return 0
}

/**
 * Whether a release is current and its service is installed, so a route has a
 * gateway behind it. Before setup, after a first setup that failed or stopped
 * before the service started, or after an uninstall that kept the accounts, a
 * route would point the profile at a port nothing serves. Says so.
 */
function isSetUp(c: Ctx, verb: string): boolean {
  if (readReleaseState(c.p).current !== null && serviceInstalled(c.p, LABEL, c.platform)) return true
  c.warn(`beacons ${verb}: beacons is not set up on this machine; run \`beacons setup\` (nothing was changed)`)
  return false
}

async function routeVerb(args: string[], c: Ctx): Promise<number> {
  const { positional, flags } = parseArgs(args, ["--replace"])
  if (positional.length !== 2) throw new UsageError("route takes a profile and pool:<account> or pin:<account>")
  const m = /^(pool|pin):(.+)$/.exec(positional[1])
  if (!m) throw new UsageError(`${positional[1]}: want pool:<account> or pin:<account>`)
  if (!isSetUp(c, "route")) return 1
  const mode = m[1] as "pool" | "pin"
  const account = m[2]
  const prof = resolveProfile(positional[0], c.p.home)
  const short = tilde(c.p.home, prof)
  if (!existsSync(prof)) {
    c.warn(`beacons route: ${prof} does not exist`)
    return 1
  }
  const known = readPool(c.p.accountsFile).accounts.map((a) => a.name)
  if (!known.includes(account)) {
    c.warn(known.length > 0 ? `beacons route: no account named "${account}"; known: ${quoted(known)}` : "beacons route: no account is signed in yet; run `beacons login` first")
    return 1
  }
  const cfg = loadGatewayConfig(c.p)
  const r = route(c.p, prof, { mode, account, port: cfg.port, replace: flags.has("--replace"), chainUrl: chainUrlOf(cfg.upstreamUrl) })
  if (!r.ok) {
    c.warn(`beacons route: ${short} is ${r.reason}: it is routed to ${r.current}, another gateway, and was left alone. To route it through beacons instead, run it again with --replace (\`beacons off\` puts ${r.current} back).`)
    return 1
  }
  c.say(`${short}: ${routeBase(cfg.port, mode, account)}`)
  if (r.others.length > 0) c.say(`${short}: other env keys left in place: ${r.others.join(", ")}`)
  // Routed, but never set up: no session-start heal there, and no status line.
  if (readRoutes(c.p).profiles[prof]?.plugin === false) c.say(`run \`beacons setup\` to add the plugin and status line to ${short}`)
  return 0
}

/** Put a parked record back as it was before this run parked over it. Best effort: off reports the failure either way. */
function unpark(p: Paths, prof: string, before: ProfileRoute | undefined): void {
  try {
    const routes = readRoutes(p)
    const off = { ...routes.off }
    if (before) off[prof] = before
    else delete off[prof]
    writeRoutes(p, { ...routes, off })
  } catch {
    // Parked and still routed: off and on both mend that on their next run.
  }
}

async function offVerb(args: string[], c: Ctx): Promise<number> {
  const { positional } = parseArgs(args, [])
  const routes = readRoutes(c.p)
  const targets = positional.length > 0 ? positional.map((a) => resolveProfile(a, c.p.home)) : Object.keys(routes.profiles)
  if (targets.length === 0) {
    c.say("no profile is routed through beacons; nothing to turn off")
    return 0
  }
  const proxyUp = proxyProbe(c.p, routes)
  let failed = false
  let done = 0
  for (const prof of targets) {
    const short = tilde(c.p.home, prof)
    const now = readRoutes(c.p)
    if (!Object.hasOwn(now.profiles, prof)) {
      if (now.off && Object.hasOwn(now.off, prof)) c.say(`${short}: already off`)
      else {
        c.warn(`${short}: not routed through beacons`)
        failed = true
      }
      continue
    }
    // A vanished folder is only dropped. Any other record is parked before its route comes out:
    // a crash between leaves it parked and still routed, which a second off or on mends.
    const parks = existsSync(prof)
    const before = now.off?.[prof]
    if (parks) writeRoutes(c.p, { ...now, off: { ...now.off, [prof]: now.profiles[prof] } })
    try {
      const r = unroute(c.p, prof, { proxyUp: await proxyUp() })
      done++
      if (parks) c.say(`${short}: off; ${goesTo(prof)}`)
      if (r.note) c.say(r.note)
    } catch (err) {
      if (parks) unpark(c.p, prof, before)
      c.warn(`${short}: still routed through beacons: ${message(err)}`)
      failed = true
    }
  }
  if (done > 0) c.say(OFF_NOTE)
  return failed ? 1 : 0
}

async function onVerb(args: string[], c: Ctx): Promise<number> {
  const { positional } = parseArgs(args, [])
  if (!isSetUp(c, "on")) return 1
  const routes = readRoutes(c.p)
  const targets = positional.length > 0 ? positional.map((a) => resolveProfile(a, c.p.home)) : Object.keys(routes.off ?? {})
  if (targets.length === 0) {
    c.say("no profile is off; nothing to turn on")
    return 0
  }
  const cfg = loadGatewayConfig(c.p)
  const chainUrl = chainUrlOf(cfg.upstreamUrl)
  const known = readPool(c.p.accountsFile).accounts.map((a) => a.name)
  let failed = false
  for (const prof of targets) {
    const short = tilde(c.p.home, prof)
    const now = readRoutes(c.p)
    const rec = now.off && Object.hasOwn(now.off, prof) ? now.off[prof] : undefined
    if (!rec) {
      if (Object.hasOwn(now.profiles, prof)) c.say(`${short}: already on`)
      else {
        c.warn(`${short}: beacons has no route of its own to turn back on. To route it, run \`beacons route ${shq(prof)} pool:<account>\``)
        failed = true
      }
      continue
    }
    if (!existsSync(prof)) {
      delete now.off![prof]
      writeRoutes(c.p, now)
      c.say(`${prof} no longer exists; skipped`)
      continue
    }
    // Logged out since off: a route to it would serve nothing (a pin) or not what was chosen (a pool).
    if (!known.includes(rec.account)) {
      c.warn(`${short}: account "${rec.account}" is no longer signed in; it stays off. Run beacons route ${shq(prof)} pool:<account>`)
      failed = true
      continue
    }
    try {
      // route takes the parked record as its own, and unparks it.
      const r = route(c.p, prof, { mode: rec.mode, account: rec.account, port: cfg.port, chainUrl })
      if (!r.ok) {
        c.warn(`${short}: it is routed to ${r.current} now, so it was left off. To route it through beacons instead: beacons route ${shq(prof)} ${shq(`${rec.mode}:${rec.account}`)} --replace`)
        failed = true
        continue
      }
      c.say(`${short}: on, ${routeBase(cfg.port, rec.mode, rec.account)}`)
    } catch (err) {
      c.warn(`${short}: not routed: ${message(err)}`)
      failed = true
    }
  }
  return failed ? 1 : 0
}

async function statusVerb(args: string[], c: Ctx): Promise<number> {
  if (args.length === 1 && args[0] === "--line") {
    c.say(await statusLineSlow({ input: await readStdin(c.stdin), env: c.env, p: c.p }))
    return 0
  }
  if (args.length > 0) throw new UsageError("status takes only --line")
  const port = loadGatewayConfig(c.p).port
  let profiles: string[]
  try {
    profiles = profileLines(readRoutes(c.p), c.p.home)
  } catch (err) {
    profiles = [`the routed profiles cannot be listed: ${message(err)}`]
  }
  try {
    c.say(renderStatus(await fetchStatus(port, CONTROL_TIMEOUT_MS), port, profiles))
    return 0
  } catch (err) {
    c.say(renderDown(port, whyNoAnswer(err, CONTROL_TIMEOUT_MS), profiles))
    return 1
  }
}

/** The upgrade's real deps: the daemon over loopback (the port read at each call), the service manager through `run`. */
function upgradeDeps(p: Paths, run: Run, platform: NodeJS.Platform): UpgradeDeps {
  return {
    bootCheck: (dir) => bootCheck(dir, p),
    restart: async ({ now }) => {
      const r = await post(portOr(p), "/beacons/v1/restart", CONTROL_TIMEOUT_MS, { headers: { "content-type": "application/json" }, body: JSON.stringify({ now }) })
      if (r.status !== 202) throw new Error(`the daemon answered HTTP ${r.status} to a restart`)
    },
    health: () => daemonHealth(portOr(p)),
    kickstart: () => kickstart(p, run, LABEL, platform),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

async function upgradeVerb(args: string[], c: Ctx): Promise<number> {
  const { positional, flags } = parseArgs(args, ["--now"])
  if (positional.length > 0) throw new UsageError("upgrade takes only --now")
  const root = pluginRootOf(c.env)
  if (root === null) {
    c.warn("beacons upgrade: no plugin copy to upgrade from: neither CLAUDE_PLUGIN_ROOT nor BEACONS_ROOT is set. Run it as <plugin folder>/bin/beacons upgrade.")
    return 1
  }
  const to = pluginVersion(root)
  const { current } = readReleaseState(c.p)
  if (current === null) {
    c.warn("beacons upgrade: beacons is not set up yet; run `beacons setup` first")
    return 1
  }
  if (to === current) {
    c.say(`beacons ${to} is already the current release`)
    return 0
  }
  const now = flags.has("--now")
  c.say(`upgrading beacons from ${current} to ${to}; the daemon moves over ${now ? "now" : "at its next quiet moment (--now does it at once)"}`)
  const r = await upgrade({ pluginRoot: root, now, p: c.p, deps: upgradeDeps(c.p, c.run(SERVICE_RUN_MS), c.platform) })
  if (r.ok) {
    c.say(`beacons ${r.to} is running`)
    return 0
  }
  c.warn(`beacons upgrade: ${r.reason ?? "it did not finish"}`)
  return 1
}

async function rollbackVerb(args: string[], c: Ctx): Promise<number> {
  if (args.length > 0) throw new UsageError("rollback takes no arguments")
  const r = await rollback(c.p, upgradeDeps(c.p, c.run(SERVICE_RUN_MS), c.platform))
  c.say(`switched back to release ${r.to}; the daemon moves over at its next quiet moment. The release it left is held, so a session start does not upgrade straight back to it.`)
  return 0
}

async function uninstallVerb(args: string[], c: Ctx): Promise<number> {
  const { positional, flags } = parseArgs(args, ["--purge"])
  if (positional.length > 0) throw new UsageError("uninstall takes only --purge")
  const purge = flags.has("--purge")
  const port = portOr(c.p)
  let routes: RoutesFile | null = null
  try {
    routes = readRoutes(c.p)
  } catch {
    // uninstall reads it itself, and says why it cannot.
  }
  const r = await uninstall({
    purge,
    p: c.p,
    deps: {
      run: c.run(SERVICE_RUN_MS),
      platform: c.platform,
      health: () => daemonHealth(port),
      openSessions: async () => {
        try {
          return (await fetchStatus(port, CONTROL_TIMEOUT_MS)).sessions
        } catch (err) {
          throw new Error(`beacons did not answer: ${whyNoAnswer(err, CONTROL_TIMEOUT_MS)}`)
        }
      },
      proxyUp: proxyProbe(c.p, routes),
    },
  })
  c.say(purge ? "beacons is uninstalled, and its accounts with it." : "beacons is uninstalled.")
  for (const n of r.notes) c.say(`- ${n}`)
  if (r.sessionsToRestart.length > 0) c.say(`Sessions open on beacons when it stopped: ${r.sessionsToRestart.map((id) => id.slice(0, 8)).join(", ")}`)
  return 0
}

/**
 * The SessionStart hook: its answer as one line of JSON, then the process
 * ends. A service manager call the hook gave up on would otherwise keep Node
 * alive past the hook's 5 s.
 */
async function hookVerb(args: string[], c: Ctx): Promise<number> {
  if (args.length !== 1 || args[0] !== "session-start") throw new UsageError("hook takes session-start")
  let result: { systemMessage?: string }
  try {
    // The hook JSON names no profile (Claude Code runs the hook with the profile's CLAUDE_CONFIG_DIR), so it is
    // only drained, alongside the work and never ahead of it: the hook's own clock starts now, inside the 5 s.
    void readStdin(c.stdin, HOOK_STDIN_MS)
    const profile = c.env.CLAUDE_CONFIG_DIR ? path.resolve(c.env.CLAUDE_CONFIG_DIR) : path.join(c.p.home, ".claude")
    const deps = hookDeps(c.p, { port: portOr(c.p), run: c.run(HOOK_RUN_MS), platform: c.platform })
    result = await sessionStartHook({ pluginRoot: pluginRootOf(c.env) ?? OWN_ROOT, profile, p: c.p, deps })
  } catch (err) {
    result = { systemMessage: `beacons: the session-start hook failed: ${message(err)}` }
  }
  await write(c.stdout, JSON.stringify(result) + "\n")
  c.exit(0)
  return 0
}

const VERBS: Record<string, (args: string[], c: Ctx) => Promise<number>> = {
  setup: setupVerb,
  login: loginVerb,
  logout: logoutVerb,
  order: orderVerb,
  route: routeVerb,
  off: offVerb,
  on: onVerb,
  status: statusVerb,
  upgrade: upgradeVerb,
  rollback: rollbackVerb,
  uninstall: uninstallVerb,
  hook: hookVerb,
}

/** Run one command. Resolves to its exit code: 0 done, 1 failed, 2 an unknown verb or bad usage. */
export async function main(argv: string[], env: NodeJS.ProcessEnv, io: CliIo = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr
  const c: Ctx = {
    env,
    p: beaconsPaths(env),
    stdin: io.stdin ?? process.stdin,
    stdout,
    platform: io.platform ?? process.platform,
    say: (line) => void stdout.write(line + "\n"),
    warn: (line) => void stderr.write(line + "\n"),
    exit: io.exit ?? ((code) => process.exit(code)),
    run: (timeoutMs) => io.run ?? realRun(env, timeoutMs),
    loginDeps: io.loginDeps,
  }
  const [verb, ...args] = argv
  if (verb === "help" || verb === "--help" || verb === "-h") {
    c.say(USAGE)
    return 0
  }
  const fn = verb !== undefined && Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined
  if (!fn) {
    c.warn(verb === undefined ? USAGE : `beacons: unknown command "${verb}"\n${USAGE}`)
    return 2
  }
  try {
    return await fn(args, c)
  } catch (err) {
    if (err instanceof UsageError) {
      c.warn(`beacons ${verb}: ${err.message}\n${USAGE}`)
      return 2
    }
    c.warn(`beacons ${verb}: ${message(err)}`)
    return 1
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), process.env)
  // Written out, then gone: a child a verb gave up on, or an idle socket, must not hold the process.
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)))
}
