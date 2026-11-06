// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// `beacons setup`: the one command that ties the rest together. With no flags
// it is a wizard in the terminal; with flags it is the guided form that
// `/beacons:setup` drives (`--plan` to show, `--yes` to apply), since the Bash
// tool has no TTY.
//
// `planSetup` only reads: the profiles, the accounts, the upstream proxy and
// the port. `applySetup` checks the plan against what it finds before its
// first change (an upgrade holding its lock, a foreign process on the port, an
// unknown account, a new chain with no proxy to answer it), then, in order:
//
//   1. snapshot the plugin copy into a release. On a re-run (a release is
//      already current) boot the snapshot once on its own first, as an
//      upgrade does: a build that cannot start stops setup there, with the
//      running build, the routes and the settings untouched. Then switch
//   2. on Linux, report when lingering is off (never change it)
//   3. write gateway.json: the port, the upstream (the proxy's URL when the
//      chain is on), and what to do when the proxy stops answering
//   4. the account order, then the service (installed, started, and waited
//      for), then each profile's route. The daemon restarts onto the new
//      build (launchd's bootout and bootstrap do that; on systemd a daemon
//      already up is restarted), and setup waits until health reports the new
//      version. On a re-run that never comes, it switches back to the build
//      before, puts gateway.json back, and starts the service again on the
//      old build
//   5. the beacons plugin under each routed profile, the launcher link (with
//      the PATH line when it is needed; a launcher that is another program's
//      is left alone), then each status line, which runs the launcher only
//      when it is beacons' link and the release's bootstrap otherwise
//      (printed instead where a profile has its own)
//   6. with a profile routed, one real request through it; then `beacons status`
//
// Every effect goes through SetupDeps and its Run, so tests use fakes only.
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, type Stats } from "node:fs"
import path from "node:path"
import { createInterface, type Interface } from "node:readline/promises"
import { accountNames, login, notifyReload, order, type LoginDeps } from "./accounts.ts"
import { proxyAnswers } from "./chain.ts"
import { ANTHROPIC, ensurePrivateDirs, loadGatewayConfig, readRoutes, saveGatewayConfig, writeAtomic, writeRoutes, type RoutesFile } from "./config.ts"
import { daemonHealth, loopbackUrl, post } from "./loopback.ts"
import { beaconsPaths, linksInto, type Paths } from "./paths.ts"
import { discoverProfiles, resolveProfile, tilde } from "./profiles.ts"
import { readReleaseState, snapshot, switchTo } from "./release.ts"
import { isOurs, routeBase } from "./route.ts"
import { baseUrlOf, onChain, route, setStatusLine, shellWord } from "./routes.ts"
import { installService, kickstart, LABEL, lingerOn, serviceKind, uninstallService, UNIT, type Run } from "./service.ts"
import { bootCheck, lockHeld } from "./upgrade.ts"

export const MODES_NOTE = "A pooled profile can run on any of these accounts, under that account's plan and data settings."
const PROBE_MODEL = "claude-haiku-5-5"
const MARKETPLACE = "OrodruinLabs/beacons"
const PLUGIN = "beacons@beacons"
const PROBE_TIMEOUT_MS = 60_000
/** A kickstart's 3 s drain, then a boot. */
const START_BUDGET_MS = 15_000
const POLL_MS = 250
const LINGER_OFF = "lingering is off for this user, so systemd stops beacons when you log out and starts it again at your next login. `loginctl enable-linger` keeps it running; setup leaves that setting to you."
const STOPPED = "Setup stopped. No profile, setting or service was changed."
/** As uninstall says it. */
const UPGRADING = "an upgrade is running; try again in a minute"
const USAGE = [
  "usage: beacons setup                  set up in this terminal, step by step",
  "       beacons setup [--profiles <profile,...>] [--order <account,...>]",
  "                     [--mode <profile>=pool:<account>|pin:<account>]...",
  "                     [--upstream <url>|off] [--chain-fallback wait|direct] [--replace <profile>]...",
  "                     (--plan | --yes)",
].join("\n")

type Mode = { mode: "pool" | "pin"; account: string }
type Fallback = "wait" | "direct"
type ProxySource = "upstream" | "gateway" | "profiles"

export type SetupPlan = {
  profiles: string[]
  order: string[]
  modes: Record<string, Mode>
  /** `url`: the upstream proxy traffic goes on through, or null for straight to Anthropic. */
  chain: { url: string | null; fallback: Fallback }
  replace: string[]
}

export type SetupDeps = {
  run: Run
  pluginRoot: string
  /** The process listening on 127.0.0.1:<port> ("node 1234"), or null when none. */
  portHolder(port: number): Promise<string | null>
  /** Whether that holder runs from beacons' own data folder: a beacons daemon that did not answer. Default: never. */
  isBeacons?(holder: string): Promise<boolean>
  /** Whether the upstream proxy at `url` answers: a connection to it opens (chain.ts's `proxyAnswers`). */
  proxyAnswers(url: string): Promise<boolean>
  /** beacons' health on its configured port, or null when nothing answers. Each call times out by itself. */
  health(): Promise<{ version: string } | null>
  /** One POST /v1/messages through `base` (a route); the HTTP status. The one paid call setup makes. */
  probeRequest(base: string): Promise<number>
  log(line: string): void
  /**
   * Boot the release in `dir` once, away from the real data (upgrade.ts's
   * `bootCheck`): resolves when it answers health, rejects with why when not.
   */
  bootCheck?: (dir: string) => Promise<unknown>
  /** Defaults: process.env, process.platform, setTimeout, notifyReload, the real sign-in. */
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  sleep?: (ms: number) => Promise<void>
  reload?: (port: number) => Promise<boolean>
  loginDeps?: LoginDeps
  /** How long setup waits, by the clock, for the new build to report its version. Default 15 s. */
  startBudgetMs?: number
}

export type SetupFound = {
  /** Every profile setup could route: `~/.claude`, each `~/.claude*` with a settings.json, CLAUDE_CONFIG_DIR, and each one routes.json records. */
  profiles: string[]
  /** Account names, first choice first. */
  accounts: string[]
  /**
   * The upstream proxy, whether it answers now, and where setup found it:
   * "upstream", a new URL `--upstream` named; "gateway", the chain gateway.json
   * already has, which the plan keeps; "profiles", the one loopback http URL
   * the routable profiles share, which is only a suggestion: the plan leaves
   * the chain off, and those profiles stay in `elsewhere`, until the user says
   * yes (`--upstream <url>`). null when there is none.
   */
  proxy: { url: string; answers: boolean; source: ProxySource } | null
  /** A process other than beacons on beacons' port; null when the port is free or beacons holds it. */
  portHolder: string | null
  port: number
  /** beacons answers health now: a re-run, whose daemon setup restarts onto the new build. */
  beaconsUp: boolean
  /** beacons' own daemon holds the port but did not answer health: setup restarts it by force. */
  beaconsHung: boolean
  /** Profiles routed to another gateway, with its URL: left alone unless `replace` names them. */
  elsewhere: Record<string, string>
  /** Profiles whose settings.json cannot be read, with why: left alone. */
  unreadable: Record<string, string>
  /** An upgrade (or rollback) holds upgrade.lock: setup waits for it, since both switch the release and restart the service. */
  upgrading: boolean
}

type Io = { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; deps: SetupDeps }

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const unique = <T>(xs: T[]): T[] => [...new Set(xs)]
const quoted = (names: string[]) => names.map((n) => `"${n}"`).join(", ")
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** `url` parsed, when it is an http URL on a loopback host (loopback.ts's); else null. */
function proxyUrl(url: string): URL | null {
  const u = loopbackUrl(url)
  return u?.protocol === "http:" ? u : null
}
/** The port an http URL names, or http's own. */
const portOf = (u: URL) => Number(u.port || 80)
/** Whether `url` can be an upstream proxy for beacons on `port`: a loopback http URL, not on that port. */
const canProxy = (url: string, port: number) => {
  const u = proxyUrl(url)
  return u !== null && portOf(u) !== port
}

/** What routes.json recorded for the profile (routed, or parked by `off`), while its account still exists; else pool on `first`. */
function defaultMode(profile: string, routes: RoutesFile, accounts: string[], first: string): Mode {
  const rec = routes.profiles[profile] ?? routes.off?.[profile]
  if (rec && accounts.includes(rec.account)) return { mode: rec.mode, account: rec.account }
  return { mode: "pool", account: first }
}

/**
 * Read everything setup needs, change nothing, and propose a plan. The chain
 * goes on through `o.upstream` (setup's `--upstream`; null is `--upstream
 * off`), else through gateway.json's upstreamUrl when it already is a loopback
 * http URL, so a re-run keeps it; the profiles routed to it are in the plan,
 * since beacons takes their place. Otherwise the chain stays off. The one
 * loopback http URL the routable profiles share (not beacons', and not one
 * routes.json records as a gateway the user replaced) is only suggested, in
 * `found.proxy`: it may be another gateway, not a proxy, so setup asks first.
 */
export async function planSetup(p: Paths, env: NodeJS.ProcessEnv, deps: SetupDeps, o: { upstream?: string | null } = {}): Promise<{ plan: SetupPlan; found: SetupFound }> {
  const cfg = loadGatewayConfig(p)
  const routes = readRoutes(p)
  const profiles = unique([...discoverProfiles(p.home, env), ...Object.keys(routes.profiles).filter((prof) => existsSync(prof))])
  const accounts = accountNames(p.accountsFile)

  // Each readable profile's ANTHROPIC_BASE_URL, in the order of `profiles`.
  const current = new Map<string, string | null>()
  const unreadable: Record<string, string> = {}
  for (const prof of profiles) {
    try {
      current.set(prof, baseUrlOf(prof))
    } catch (err) {
      unreadable[prof] = message(err)
    }
  }
  const ours = (prof: string, cur: string | null) => cur === null || isOurs(cur, cfg.port) || cur === routes.profiles[prof]?.wrote.ANTHROPIC_BASE_URL

  // The proxy: the one named, else the chain already kept, else a suggestion from the profiles.
  const kept = canProxy(cfg.upstreamUrl, cfg.port) ? cfg.upstreamUrl : null
  let named: { url: string; source: ProxySource } | null
  if (o.upstream !== undefined) named = o.upstream === null ? null : { url: o.upstream, source: o.upstream === kept ? "gateway" : "upstream" }
  else if (kept !== null) named = { url: kept, source: "gateway" }
  else {
    const replacedOther = new Set([...Object.values(routes.profiles), ...Object.values(routes.off ?? {})].flatMap((r) => (r.replacedKind === "other" && r.replaced !== null ? [r.replaced] : [])))
    const shared = unique([...current].flatMap(([prof, cur]) => (cur !== null && !ours(prof, cur) && canProxy(cur, cfg.port) && !replacedOther.has(cur) ? [cur] : [])))
    named = shared.length === 1 ? { url: shared[0], source: "profiles" } : null
  }
  const proxy = named === null ? null : { ...named, answers: canProxy(named.url, cfg.port) && (await deps.proxyAnswers(named.url).catch(() => false)) }
  // Only a proxy the user named or already has turns the chain on.
  const url = named !== null && named.source !== "profiles" ? named.url : null

  const beaconsUp = (await deps.health().catch(() => null)) !== null
  // A beacons daemon already on the port is ours: setup restarts it, it is not in the way. So is one that holds
  // the port and missed its health call (its process runs from beacons' data folder), which setup restarts by force.
  let holder = beaconsUp ? null : await deps.portHolder(cfg.port).catch(() => null)
  const beaconsHung = holder !== null && (await (deps.isBeacons?.(holder) ?? Promise.resolve(false)).catch(() => false))
  if (beaconsHung) holder = null

  const include: string[] = []
  const elsewhere: Record<string, string> = {}
  for (const [prof, cur] of current) {
    if (ours(prof, cur) || (url !== null && cur !== null && onChain(cur, url))) include.push(prof)
    else elsewhere[prof] = cur!
  }
  const first = accounts[0] ?? ""
  const plan: SetupPlan = {
    profiles: include,
    order: [...accounts],
    modes: Object.fromEntries(include.map((prof) => [prof, defaultMode(prof, routes, accounts, first)])),
    chain: { url, fallback: cfg.chainFallback },
    replace: [],
  }
  const found: SetupFound = {
    profiles, accounts, proxy, portHolder: holder, port: cfg.port, beaconsUp, beaconsHung,
    elsewhere, unreadable, upgrading: lockHeld(p),
  }
  return { plan, found }
}

/** What stops this plan before anything changes. Empty when it can be applied. */
function checkPlan(plan: SetupPlan, found: SetupFound): string[] {
  const out: string[] = []
  if (found.upgrading) out.push(UPGRADING)
  if (found.portHolder !== null) out.push(`port ${found.port} is held by ${found.portHolder}; free it or set port in gateway.json`)
  if (found.accounts.length === 0) {
    out.push("no account is signed in yet: run `beacons login` once per account (each opens a browser sign-in), then setup again")
  } else {
    const known = quoted(found.accounts)
    for (const prof of plan.profiles) {
      const m = plan.modes[prof]
      if (!m) out.push(`${prof}: no mode; give --mode ${prof}=pool:<account> or pin:<account>`)
      else if (!found.accounts.includes(m.account)) out.push(`${prof}: no account named "${m.account}"; known: ${known}`)
    }
    const seen = new Set<string>()
    for (const a of plan.order) {
      if (!found.accounts.includes(a)) out.push(`order: no account named "${a}"; known: ${known}`)
      else if (seen.has(a)) out.push(`order: "${a}" is named twice`)
      seen.add(a)
    }
  }
  for (const prof of plan.profiles) if (found.unreadable[prof] !== undefined) out.push(found.unreadable[prof])
  const url = plan.chain.url
  if (url !== null) {
    const u = proxyUrl(url)
    const seen = found.proxy?.url === url ? found.proxy : null
    if (u === null) out.push(`the upstream proxy must be a loopback http URL, like http://127.0.0.1:<port>, not ${url}`)
    else if (portOf(u) === found.port) out.push(`the upstream proxy ${url} is on beacons' own port ${found.port}; give the proxy's own URL, or leave the chain off (--upstream off)`)
    // A new chain waits for its proxy. One gateway.json already has is kept with a warning (chainWarnings): the fallback covers it.
    else if (seen === null || (!seen.answers && seen.source !== "gateway")) out.push(`the upstream proxy at ${url} does not answer; start it first, or leave the chain off (--upstream off)`)
  }
  return out
}

/** What applying this plan should say first, without stopping it: a kept chain whose proxy does not answer now. */
function chainWarnings(plan: SetupPlan, found: SetupFound): string[] {
  const url = plan.chain.url
  if (url === null || found.proxy?.url !== url || found.proxy.source !== "gateway" || found.proxy.answers) return []
  const meanwhile = plan.chain.fallback === "wait" ? "requests wait for it" : "requests go direct to Anthropic"
  return [`warning: the upstream proxy at ${url} does not answer now; the chain is kept, and until the proxy answers, ${meanwhile}`]
}

/**
 * The build setup switched from (null on a first install), the one it
 * switched to, whether a daemon answered before, whether beacons' daemon held
 * the port without answering, and gateway.json's text before setup wrote it
 * (null: there was none).
 */
type Build = { from: string | null; to: string; wasUp: boolean; hung: boolean; gateway: string | null }

/** Put a file's earlier text back, or remove it when there was none. */
function putBack(file: string, text: string | null): void {
  if (text !== null) return writeAtomic(file, text, 0o600)
  try {
    unlinkSync(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
}

/**
 * Start the service again on the build just switched back to, and say how
 * that went. On launchd, by installing the unit again: its bootout and
 * bootstrap restart a loaded service, and load one that a failed bootstrap
 * left unloaded, which `kickstart` cannot reach. On systemd, `reset-failed`
 * first (best effort), so a start limit hit by the new build cannot block it,
 * then a restart; when that fails too, the unit is installed again.
 */
async function restartOn(p: Paths, run: Run, platform: NodeJS.Platform, version: string): Promise<string> {
  const reinstall = () => installService(p, run, LABEL, platform)
  if (serviceKind(platform) === "launchd") {
    try {
      await reinstall()
      return `its unit was installed again and started on ${version}`
    } catch (err) {
      return `starting it again on ${version} failed (${message(err)})`
    }
  }
  await run("systemctl", ["--user", "reset-failed", UNIT]).catch(() => undefined)
  try {
    await kickstart(p, run, LABEL, platform)
    return `the service was restarted on ${version}`
  } catch (restartErr) {
    try {
      await reinstall()
      return `its restart failed (${message(restartErr)}), so its unit was installed again and started on ${version}`
    } catch (installErr) {
      return `restarting it on ${version} failed (${message(restartErr)}), and so did installing its unit again (${message(installErr)})`
    }
  }
}

/**
 * Install and start the unit so the service runs `b.to`, and wait, by the
 * clock, until health reports that version, not just any answer. On launchd
 * that install is a restart already (bootout, then bootstrap). systemd's
 * `enable --now` leaves a running daemon running, so one that was up is
 * restarted there.
 *
 * When the new build never reports in: on a re-run, switch back to `b.from`
 * (held, as a failed upgrade is), put gateway.json back as it was, and start
 * the service again on the old build, so profiles already routed keep a
 * gateway. On a first install with no profile routed, take the unit away
 * again, so nothing restarts it in a loop.
 */
async function serveBuild(p: Paths, deps: SetupDeps, platform: NodeJS.Platform, sleep: (ms: number) => Promise<void>, b: Build): Promise<void> {
  const failed = async (why: string): Promise<Error> => {
    const done: string[] = []
    if (b.from !== null) {
      if (b.from !== b.to) {
        try {
          switchTo(p, b.from, { hold: true })
          done.push(`switched back to ${b.from}, and ${b.to} is held`)
        } catch (err) {
          done.push(`switching back to ${b.from} failed: ${message(err)}`)
        }
      }
      try {
        putBack(p.gatewayFile, b.gateway)
        done.push("gateway.json is as it was, while the accounts, their order and any sign-ins are kept")
      } catch (err) {
        done.push(`gateway.json could not be put back (${message(err)})`)
      }
      done.push(await restartOn(p, deps.run, platform, b.from))
    } else if (Object.keys(readRoutes(p).profiles).length === 0) {
      try {
        await uninstallService(p, deps.run, LABEL, platform)
        done.push("its service was removed again, so nothing restarts it in a loop")
      } catch (err) {
        done.push(`its service could not be removed (${message(err)})`)
      }
    } else {
      done.push("its service stays installed, because profiles are routed to it")
    }
    return new Error(`${why}; ${done.join("; ")}. No profile was changed. Logs: ${path.join(p.logsDir, "daemon.log")}. Fix the cause and run setup again.`)
  }
  if (b.hung) {
    // Killed and started again on the build just switched to, before the unit goes in: a launchd bootout would
    // wait out a process that does not answer its signal. Best effort: the wait for health below decides.
    try {
      await kickstart(p, deps.run, LABEL, platform)
    } catch (err) {
      deps.log(`restarting the beacons that was not answering failed (${message(err)})`)
    }
  }
  try {
    await installService(p, deps.run, LABEL, platform)
  } catch (err) {
    throw await failed(`beacons could not be started: ${message(err)}`)
  }
  if (b.wasUp && serviceKind(platform) === "systemd") {
    try {
      await kickstart(p, deps.run, LABEL, platform)
    } catch (err) {
      throw await failed(`beacons could not be restarted onto ${b.to}: ${message(err)}`)
    }
  }
  // A deadline, not a count of polls: each health call can take up to its own timeout.
  const budget = deps.startBudgetMs ?? START_BUDGET_MS
  const deadline = Date.now() + budget
  for (;;) {
    const h = await deps.health().catch(() => null)
    if (h?.version === b.to) return
    if (Date.now() >= deadline) {
      const s = budget / 1000
      throw await failed(h === null ? `beacons did not answer within ${s} s` : `the service reports ${h.version}, not ${b.to}, after ${s} s`)
    }
    await sleep(POLL_MS)
  }
}

/** `claude plugin marketplace add`, then `claude plugin install`, under the profile. Marks routes.json when it installs. */
async function installPlugin(p: Paths, profile: string, run: Run, log: (line: string) => void): Promise<void> {
  const claude = (...args: string[]) =>
    run("env", [`CLAUDE_CONFIG_DIR=${profile}`, "claude", "plugin", ...args]).catch((err) => ({ code: -1, stdout: "", stderr: message(err) }))
  // A marketplace already added fails here harmlessly; the install says whether the plugin is there.
  await claude("marketplace", "add", MARKETPLACE)
  const r = await claude("install", PLUGIN)
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).trim() || `exit ${r.code}`
    log(`${tilde(p.home, profile)}: the beacons plugin did not install (${why}). To install it by hand: CLAUDE_CONFIG_DIR=${profile} claude plugin install ${PLUGIN}`)
    return
  }
  const routes = readRoutes(p)
  const rec = routes.profiles[path.resolve(profile)]
  if (rec && !rec.plugin) {
    rec.plugin = true
    writeRoutes(p, routes)
  }
}

/**
 * `~/.local/bin/beacons` → the current release's bootstrap. What is there
 * already is replaced only when it is beacons' own link, one into its data
 * folder: a file, or a link to anything else, is another program's and is left
 * alone. True when the launcher is beacons' link once this returns.
 */
function linkLauncher(p: Paths, env: NodeJS.ProcessEnv, log: (line: string) => void): boolean {
  const target = path.join(p.currentRelease, "bin", "beacons")
  const dir = path.dirname(p.launcher)
  let st: Stats | null = null
  try {
    st = lstatSync(p.launcher)
  } catch {
    // Not there yet.
  }
  if (st && !st.isSymbolicLink()) {
    log(`${p.launcher} is not a link beacons made, so it was left alone; beacons runs from ${target}`)
    return false
  }
  if (st && !linksInto(p.launcher, p.dataDir)) {
    log(`${p.launcher} links to ${readlinkSync(p.launcher)}, not into beacons' data folder, so it was left alone; beacons runs from ${target}`)
    return false
  }
  if (!st || readlinkSync(p.launcher) !== target) {
    mkdirSync(dir, { recursive: true })
    const tmp = `${p.launcher}.${process.pid}.${Date.now()}.tmp`
    symlinkSync(target, tmp)
    try {
      renameSync(tmp, p.launcher)
    } catch (err) {
      try {
        unlinkSync(tmp)
      } catch {
        // Already gone.
      }
      throw err
    }
  }
  const onPath = (env.PATH ?? "").split(path.delimiter).some((d) => d !== "" && path.resolve(d) === dir)
  if (!onPath) log(`${dir} is not on your PATH. To run beacons by name, add this line to your shell's startup file: export PATH="${dir}:$PATH"`)
  return true
}

/** Apply a plan. Everything that can refuse it is checked first, and a refusal changes nothing. */
export async function applySetup(plan: SetupPlan, p: Paths, deps: SetupDeps): Promise<void> {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const sleep = deps.sleep ?? realSleep
  const reload = deps.reload ?? notifyReload
  const log = (line: string) => deps.log(line)
  const short = (prof: string) => tilde(p.home, prof)
  const skipped = (prof: string, url: string) =>
    log(`${short(prof)}: skipped; it is routed to ${url}. To route it through beacons instead, run setup with --replace ${prof} (\`beacons off\` puts ${url} back).`)

  // Checks. A foreign process on the port stops setup here, before the release or the service.
  const { found } = await planSetup(p, env, deps, { upstream: plan.chain.url })
  const problems = checkPlan(plan, found)
  if (problems.length > 0) throw new Error(problems.join("\n"))

  // 1. The release. On a re-run the new build boots once on its own before anything moves, as an upgrade's does:
  // one that cannot start stops setup here, with the running build, the routes and the settings as they were.
  const from = readReleaseState(p).current
  const rel = snapshot(deps.pluginRoot, p)
  if (from !== null) {
    try {
      await (deps.bootCheck ?? ((dir: string) => bootCheck(dir, p)))(rel.dir)
    } catch (err) {
      throw new Error(`release ${rel.version} did not boot (${message(err)}). Setup stopped before switching to it: the running build, the routes and the settings are as they were.`)
    }
  }
  ensurePrivateDirs(p)
  switchTo(p, rel.version)
  log(`release ${rel.version}, on Node ${rel.node}`)

  // 2. Lingering, on Linux: reported, never changed.
  if (serviceKind(platform) === "systemd" && !(await lingerOn(deps.run).catch(() => false))) log(LINGER_OFF)

  // 3. gateway.json. Its bytes before (or its absence) go back with the old build if the new one never reports in.
  const build: Build = { from, to: rel.version, wasUp: found.beaconsUp, hung: found.beaconsHung, gateway: existsSync(p.gatewayFile) ? readFileSync(p.gatewayFile, "utf8") : null }
  const cfg = loadGatewayConfig(p)
  const proxy = plan.chain.url
  saveGatewayConfig(p, { port: cfg.port, upstreamUrl: proxy ?? ANTHROPIC, chainFallback: plan.chain.fallback })
  log(proxy !== null
    ? `gateway.json: port ${cfg.port}, on through the upstream proxy at ${proxy}; if it stops answering: ${plan.chain.fallback === "wait" ? "wait for it" : "go direct to Anthropic"}`
    : `gateway.json: port ${cfg.port}, straight to Anthropic`)
  for (const w of chainWarnings(plan, found)) log(w)

  // 4. The accounts, the service and the routes.
  const routed: string[] = []
  if (plan.order.length > 0) await order(p.accountsFile, plan.order)
  await serveBuild(p, deps, platform, sleep, build)
  await reload(cfg.port)
  for (const prof of plan.profiles) {
    const m = plan.modes[prof]
    try {
      const r = route(p, prof, { mode: m.mode, account: m.account, port: cfg.port, replace: plan.replace.includes(prof), chainUrl: proxy })
      if (!r.ok) {
        skipped(prof, r.current)
        continue
      }
      routed.push(prof)
      log(`${short(prof)}: ${routeBase(cfg.port, m.mode, m.account)}`)
      if (r.others.length > 0) log(`${short(prof)}: other env keys left in place: ${r.others.join(", ")}`)
    } catch (err) {
      log(`${short(prof)}: not routed: ${message(err)}`)
    }
  }

  // 5. The plugin, the launcher, then the status line, which runs the launcher only when that is beacons' own link
  // (else the release's bootstrap, so it never runs another program).
  for (const prof of routed) await installPlugin(p, prof, deps.run, log)
  const bootstrap = path.join(p.currentRelease, "bin", "beacons")
  let linked = false
  try {
    linked = linkLauncher(p, env, log)
  } catch (err) {
    log(`${p.launcher} was not linked (${message(err)}); beacons runs from ${bootstrap}`)
  }
  const beacons = linked ? p.launcher : bootstrap
  for (const prof of routed) {
    try {
      if (setStatusLine(p, prof, beacons) === "kept") {
        log(`${short(prof)} keeps its own statusLine. To show beacons in it, add the output of this command: ${shellWord(beacons)} status --line`)
      }
    } catch (err) {
      log(`${short(prof)}: statusLine not set: ${message(err)}`)
    }
  }

  // 6. One real request through a routed profile's route (none routed: none sent, since it would test nothing), then the status.
  const first = routed[0]
  if (first === undefined) {
    log("no profile is routed, so setup sent no test request")
  } else {
    const base = routeBase(cfg.port, plan.modes[first].mode, plan.modes[first].account)
    try {
      const status = await deps.probeRequest(base)
      log(status === 200 ? `a test request through ${base} answered 200` : `a test request through ${base} answered HTTP ${status}; the status below shows each account`)
    } catch (err) {
      log(`a test request through ${base} did not finish: ${message(err)}`)
    }
  }
  try {
    const r = await deps.run(path.join(p.currentRelease, "bin", "beacons"), ["status"])
    const out = (r.stdout || r.stderr).trimEnd()
    if (out !== "") log(out)
  } catch (err) {
    log(`beacons status: ${message(err)}`)
  }
}

// --- the real deps --------------------------------------------------------

/** The one paid call: a one-token message through `base`, a route on beacons' port. The gateway supplies the account's credential. */
export async function probeRequest(base: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<number> {
  const u = new URL(base)
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1") throw new Error(`${base} is not a route on 127.0.0.1`)
  const r = await post(Number(u.port || 80), `${u.pathname}/v1/messages`, timeoutMs, {
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" },
    body: JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, messages: [{ role: "user", content: "Say ok." }] }),
  })
  return r.status
}

/** Who listens on <port>: `lsof` on macOS, `ss` on Linux. "node 1234", or null when nothing does or the tool cannot say. */
export async function findPortHolder(run: Run, port: number, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  try {
    if (serviceKind(platform) === "launchd") {
      const r = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"])
      const row = r.stdout.split("\n").slice(1).find((l) => l.trim() !== "")
      if (!row) return null
      const [cmd, pid] = row.trim().split(/\s+/)
      return pid ? `${cmd} ${pid}` : cmd
    }
    const r = await run("ss", ["-ltnp"])
    for (const line of r.stdout.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 5 || !cols[3].endsWith(`:${port}`)) continue
      const m = /users:\(\("([^"]*)",pid=(\d+)/.exec(line)
      return m ? `${m[1]} ${m[2]}` : "another process"
    }
    return null
  } catch {
    return null
  }
}

/**
 * Whether the port holder findPortHolder named ("node 1234") runs from
 * `dataDir`: beacons' own daemon, whose program and script both live there.
 * `ps` gives its command line; anything it cannot say is not beacons.
 */
export async function holderIsBeacons(run: Run, holder: string, dataDir: string): Promise<boolean> {
  const pid = /\s(\d+)$/.exec(holder)?.[1]
  if (pid === undefined) return false
  try {
    const r = await run("ps", ["-o", "command=", "-p", pid])
    return r.code === 0 && r.stdout.includes(dataDir + path.sep)
  } catch {
    return false
  }
}

/**
 * The deps the CLI runs setup with: the real tools through `run`, health and
 * the probe over loopback, for the setup at `p` with `env` (the same Paths and
 * env the command plans with).
 */
export function setupDeps(p: Paths, o: { run: Run; pluginRoot: string; env: NodeJS.ProcessEnv; platform?: NodeJS.Platform; log?: (line: string) => void }): SetupDeps {
  const platform = o.platform ?? process.platform
  return {
    run: o.run,
    pluginRoot: o.pluginRoot,
    env: o.env,
    platform,
    portHolder: (port) => findPortHolder(o.run, port, platform),
    isBeacons: (holder) => holderIsBeacons(o.run, holder, p.dataDir),
    proxyAnswers: (url) => proxyAnswers(url),
    bootCheck: (dir) => bootCheck(dir, p),
    // The port is read at each call: setup writes gateway.json on the way.
    health: async () => {
      let port: number
      try {
        port = loadGatewayConfig(p).port
      } catch {
        return null
      }
      return daemonHealth(port)
    },
    probeRequest: (base) => probeRequest(base),
    log: o.log ?? ((line) => console.log(line)),
    reload: (port) => notifyReload(port),
  }
}

// --- the command: flags, --plan, and the wizard ---------------------------

type Flags = {
  profiles?: string[]
  order?: string[]
  modes: Record<string, Mode>
  /** `--upstream`: the proxy's URL, or null for off. */
  upstream?: string | null
  fallback?: Fallback
  replace: string[]
  plan: boolean
  yes: boolean
}

function parseFlags(argv: string[], home: string): Flags {
  const f: Flags = { modes: {}, replace: [], plan: false, yes: false }
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter((x) => x !== "")
  const where = (s: string) => resolveProfile(s, home)
  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i]
    let value: string | undefined
    const eq = flag.indexOf("=")
    if (flag.startsWith("--") && eq > 0) {
      value = flag.slice(eq + 1)
      flag = flag.slice(0, eq)
    }
    const need = (): string => {
      if (value !== undefined) return value
      const v = argv[++i]
      if (v === undefined) throw new Error(`${flag} needs a value`)
      return v
    }
    const bare = () => {
      if (value !== undefined) throw new Error(`${flag} takes no value`)
    }
    switch (flag) {
      case "--profiles":
        f.profiles = list(need()).map(where)
        break
      case "--order":
        f.order = list(need())
        break
      case "--mode": {
        const v = need()
        const m = /^(.+?)=(pool|pin):(.+)$/.exec(v)
        if (!m) throw new Error(`--mode ${v}: want <profile>=pool:<account> or <profile>=pin:<account>`)
        f.modes[where(m[1])] = { mode: m[2] as Mode["mode"], account: m[3] }
        break
      }
      case "--upstream": {
        const v = need()
        if (v !== "off" && proxyUrl(v) === null) throw new Error(`--upstream ${v}: want a loopback http URL, like http://127.0.0.1:<port>, or off`)
        f.upstream = v === "off" ? null : v
        break
      }
      case "--chain-fallback": {
        const v = need()
        if (v !== "wait" && v !== "direct") throw new Error(`--chain-fallback ${v}: want wait or direct`)
        f.fallback = v
        break
      }
      case "--replace":
        f.replace.push(where(need()))
        break
      case "--plan":
        bare()
        f.plan = true
        break
      case "--yes":
        bare()
        f.yes = true
        break
      default:
        throw new Error(`unknown option ${argv[i]}`)
    }
  }
  return f
}

/** The proposed plan with the flags laid over it. Profiles a mode or a replace names are included. */
function withFlags(base: SetupPlan, found: SetupFound, f: Flags, p: Paths): SetupPlan {
  const routes = readRoutes(p)
  const profiles = unique([...(f.profiles ?? base.profiles), ...Object.keys(f.modes), ...f.replace])
  const order = f.order ?? base.order
  const first = order[0] ?? found.accounts[0] ?? ""
  const modes: Record<string, Mode> = {}
  for (const prof of profiles) modes[prof] = f.modes[prof] ?? defaultMode(prof, routes, found.accounts, first)
  return {
    profiles,
    order,
    modes,
    chain: { url: f.upstream !== undefined ? f.upstream : base.chain.url, fallback: f.fallback ?? base.chain.fallback },
    replace: unique([...base.replace, ...f.replace]),
  }
}

function summary(plan: SetupPlan, found: SetupFound, home: string): string {
  const lines = ["Setup will:"]
  if (plan.order.length > 0) lines.push(`  - try the accounts in this order: ${quoted(plan.order)}`)
  for (const prof of plan.profiles) {
    const m = plan.modes[prof]
    const how = m ? (m.mode === "pool" ? `pool, first choice "${m.account}"` : `pin to "${m.account}"`) : "no mode"
    const was = found.elsewhere[prof] !== undefined && plan.replace.includes(prof) ? ` (replaces ${found.elsewhere[prof]})` : ""
    lines.push(`  - route ${tilde(home, prof)}: ${how}${was}`)
  }
  lines.push(plan.chain.url !== null
    ? `  - send on through the upstream proxy at ${plan.chain.url}; if it stops answering, ${plan.chain.fallback === "wait" ? "wait for it" : "go direct to Anthropic"}`
    : "  - send straight to Anthropic")
  if (found.beaconsHung) lines.push(`  - restart beacons, which holds port ${found.port} but is not answering`)
  lines.push(`  - run the beacons service on 127.0.0.1:${found.port}, install the beacons plugin in each routed profile, and send one test request`)
  return lines.join("\n")
}

/**
 * The wizard's questions, through readline on the injected streams. Each
 * question ends "> " on its own line. The interface is closed while a
 * sign-in runs, since the sign-in reads a pasted code from the terminal itself.
 */
class Prompter {
  #input: NodeJS.ReadableStream
  #output: NodeJS.WritableStream
  #rl: Interface | null = null
  #lines: AsyncIterator<string> | null = null

  constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
    this.#input = input
    this.#output = output
  }

  async ask(question: string, def: string): Promise<string> {
    if (!this.#rl) {
      this.#rl = createInterface({ input: this.#input, crlfDelay: Infinity })
      this.#lines = this.#rl[Symbol.asyncIterator]()
    }
    this.#output.write(`${question}${def !== "" ? ` [${def}]` : ""}\n> `)
    const next = await this.#lines!.next()
    if (next.done) throw new Error("the input ended before setup had all its answers")
    return next.value.trim() || def
  }

  close(): void {
    this.#rl?.close()
    this.#rl = null
    this.#lines = null
  }
}

async function askValid<T>(ask: Prompter, say: (s: string) => void, question: string, def: string, parse: (answer: string) => T): Promise<T> {
  for (let tries = 1; ; tries++) {
    const answer = await ask.ask(question, def)
    try {
      return parse(answer)
    } catch (err) {
      if (tries >= 5) throw err
      say(message(err))
    }
  }
}

const count = (a: string): number => {
  if (!/^\d{1,2}$/.test(a)) throw new Error("answer with a number, like 1")
  return Number(a)
}
const yesNo = (a: string): boolean => {
  if (/^y(es)?$/i.test(a)) return true
  if (/^no?$/i.test(a)) return false
  throw new Error("answer y or n")
}
const fallback = (a: string): Fallback => {
  if (a === "wait" || a === "direct") return a
  throw new Error("answer wait or direct")
}

/** An account by its number in the list, or by its exact name. */
function accountIn(token: string, accounts: string[]): string | null {
  if (/^\d+$/.test(token)) return accounts[Number(token) - 1] ?? null
  return accounts.includes(token) ? token : null
}

async function signInMany(n: number, file: string, say: (s: string) => void, loginDeps: LoginDeps | undefined): Promise<void> {
  for (let i = 1; i <= n; i++) {
    say(`Sign-in ${i} of ${n}: a browser opens. Sign in with the account to add.`)
    try {
      const r = await login(file, {}, say, loginDeps)
      if (r.existed) {
        say(`warning: that sign-in is "${r.account.name}" again, which is already signed in, so no account was added. A browser still signed in to claude.ai signs in as the same account: sign out there, or use a private window, before the next sign-in.`)
      }
    } catch (err) {
      say(`sign-in ${i} did not finish: ${message(err)}`)
    }
  }
}

async function wizard(p: Paths, env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const deps = io.deps
  const say = (s: string) => void io.output.write(s + "\n")
  const short = (prof: string) => tilde(p.home, prof)
  const ask = new Prompter(io.input, io.output)
  try {
    let { plan, found } = await planSetup(p, env, deps)
    say("beacons setup")
    if (found.upgrading) {
      say(`${UPGRADING}. ${STOPPED}`)
      return 2
    }
    if (found.portHolder !== null) {
      say(`port ${found.port} is held by ${found.portHolder}; free it or set port in gateway.json. ${STOPPED}`)
      return 2
    }
    if (found.beaconsHung) say(`beacons holds port ${found.port} but is not answering; setup restarts it.`)

    // Accounts: sign in now.
    say(found.accounts.length > 0 ? `Signed in: ${quoted(found.accounts)}.` : "No account is signed in yet.")
    const n = await askValid(ask, say, "How many accounts will you sign in to now? Each opens one browser sign-in.", found.accounts.length > 0 ? "0" : "1", count)
    if (n > 0) {
      ask.close()
      await signInMany(n, p.accountsFile, say, deps.loginDeps)
      ;({ plan, found } = await planSetup(p, env, deps))
    }
    if (found.accounts.length === 0) {
      say("No account is signed in, so there is nothing to route yet. Run `beacons login`, then `beacons setup` again.")
      return 1
    }

    // The chain, asked before the profiles, since the answer decides which profiles are beacons' to take: only when
    // setup found a proxy, with "no" as the default unless gateway.json already sends through it. With none, the
    // chain stays off, and `--upstream` turns it on.
    let fallbackChoice = plan.chain.fallback
    if (found.proxy !== null) {
      const { url, answers, source } = found.proxy
      say(source === "gateway"
        ? `beacons sends its traffic on through the local proxy at ${url}: Claude Code, then beacons, then the proxy, then Anthropic.`
        : `A profile here is routed to ${url}. If that is a local proxy, beacons can send its traffic on through it: Claude Code, then beacons, then the proxy, then Anthropic.`)
      const question = `Send traffic on through the local proxy at ${url}? It will see every pooled account's token${answers ? "" : ", and it does not answer now"}. (yes/no)`
      const on = await askValid(ask, say, question, source === "gateway" ? "yes" : "no", yesNo)
      if (on) fallbackChoice = await askValid(ask, say, "If the proxy stops answering: wait for it, or go direct to Anthropic? (wait/direct)", fallbackChoice, fallback)
      ;({ plan, found } = await planSetup(p, env, deps, { upstream: on ? url : null }))
    }

    // Profiles. planSetup put each one in the plan, in `elsewhere` or in `unreadable`; a value in the plan
    // that is neither unset nor beacons' own is the upstream proxy's route, with the chain on.
    const describe = (prof: string): string => {
      if (found.elsewhere[prof] !== undefined) return `routed to ${found.elsewhere[prof]}; replaced only if you pick it`
      const cur = baseUrlOf(prof)
      if (cur === null) return "not routed"
      if (isOurs(cur, found.port) || cur === readRoutes(p).profiles[prof]?.wrote.ANTHROPIC_BASE_URL) return "routed through beacons"
      return `routed to the upstream proxy at ${cur}; beacons takes its place and sends on through it`
    }
    const listed = found.profiles.filter((prof) => found.unreadable[prof] === undefined)
    for (const prof of found.profiles) if (found.unreadable[prof] !== undefined) say(`Left alone: ${found.unreadable[prof]}`)
    say("Profiles:")
    listed.forEach((prof, i) => say(`  ${i + 1}. ${short(prof)}  ${describe(prof)}`))
    const defaultPick = listed.flatMap((prof, i) => (plan.profiles.includes(prof) ? [String(i + 1)] : [])).join(",")
    const profiles = await askValid(ask, say, "Route which profiles through beacons? Numbers, separated by commas.", defaultPick, (a) => {
      if (a === "") return []
      if (a === "all") return listed
      const out: string[] = []
      for (const t of a.split(/[\s,]+/).filter((x) => x !== "")) {
        const prof = /^\d+$/.test(t) ? listed[Number(t) - 1] : undefined
        if (!prof) throw new Error(`no profile numbered ${t}; answer with numbers from the list`)
        if (!out.includes(prof)) out.push(prof)
      }
      return out
    })
    const replace = profiles.filter((prof) => found.elsewhere[prof] !== undefined)
    for (const prof of replace) say(`${short(prof)} is routed to ${found.elsewhere[prof]}; beacons replaces it, and \`beacons off\` puts it back.`)

    // Order.
    let order = plan.order
    if (found.accounts.length > 1) {
      say("Accounts:")
      found.accounts.forEach((a, i) => say(`  ${i + 1}. ${a}`))
      const def = plan.order.map((a) => String(found.accounts.indexOf(a) + 1)).join(",")
      order = await askValid(ask, say, "Account order, first choice first. Numbers or names, separated by commas.", def, (a) => {
        const out: string[] = []
        for (const t of a.split(",").map((x) => x.trim()).filter((x) => x !== "")) {
          const name = accountIn(t, found.accounts)
          if (!name) throw new Error(`no account "${t}"; answer with numbers or names from the list`)
          if (out.includes(name)) throw new Error(`"${name}" is named twice`)
          out.push(name)
        }
        return [...out, ...plan.order.filter((n) => !out.includes(n))]
      })
    }

    // Modes.
    say(MODES_NOTE)
    say("pool:<account> starts there and can move to the others in the order; pin:<account> only ever runs on that account.")
    const modes: Record<string, Mode> = {}
    for (const prof of profiles) {
      const d = plan.modes[prof]
      const account = d && found.accounts.includes(d.account) ? d.account : order[0]
      const mode = d?.mode ?? "pool"
      modes[prof] = await askValid(ask, say, `${short(prof)}: pool or pin, and which account?`, `${mode}:${account}`, (a) => {
        const m = /^(pool|pin)(?::(.+))?$/.exec(a)
        const who = m ? (m[2] ?? order[0]) : a
        const name = accountIn(who.trim(), found.accounts)
        if (!name) throw new Error(`no account "${who}"; answer pool:<account> or pin:<account>, with a number or name from the list`)
        return { mode: m ? (m[1] as Mode["mode"]) : "pool", account: name }
      })
    }

    const full: SetupPlan = { profiles, order, modes, chain: { url: plan.chain.url, fallback: fallbackChoice }, replace }
    say("")
    say(summary(full, found, p.home))
    const problems = checkPlan(full, found)
    if (problems.length > 0) {
      for (const x of problems) say(x)
      say(STOPPED)
      return 2
    }
    if (!(await askValid(ask, say, "Go ahead? (y/n)", "y", yesNo))) {
      say(STOPPED)
      return 1
    }
    ask.close()
    await applySetup(full, p, deps)
    return 0
  } finally {
    ask.close()
  }
}

/**
 * The `setup` verb. No arguments: the wizard. Flags: the guided form, which
 * changes nothing without `--yes`; `--plan` prints `{ plan, found, problems }`
 * as JSON instead. Exit 0 when done (or a plan with no problems), 2 when
 * refused before any change, 1 when setup stopped or failed on the way.
 */
export async function setupCommand(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const say = (s: string) => void io.output.write(s + "\n")
  const p = beaconsPaths(env)
  let flags: Flags
  try {
    flags = parseFlags(argv, p.home)
  } catch (err) {
    say(`beacons setup: ${message(err)}`)
    say(USAGE)
    return 2
  }
  // Apply re-plans with the env and Paths this command planned with, whatever env the deps came with.
  const deps: SetupDeps = { ...io.deps, env }
  try {
    if (argv.length === 0) return await wizard(p, env, { ...io, deps })
    const { plan: base, found } = await planSetup(p, env, deps, { upstream: flags.upstream })
    const plan = withFlags(base, found, flags, p)
    const problems = checkPlan(plan, found)
    if (flags.plan) {
      say(JSON.stringify({ plan, found, problems }, null, 2))
      return problems.length > 0 ? 2 : 0
    }
    if (problems.length > 0) {
      for (const x of problems) say(x)
      say("Nothing was changed.")
      return 2
    }
    if (!flags.yes) {
      say(summary(plan, found, p.home))
      for (const w of chainWarnings(plan, found)) say(w)
      say("Nothing was changed. Run it again with --yes to apply this plan, or with --plan to see it as JSON.")
      return 2
    }
    await applySetup(plan, p, deps)
    return 0
  } catch (err) {
    say(`beacons setup: ${message(err)}`)
    return 1
  }
}
