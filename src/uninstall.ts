// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// Undo what setup did, in an order that keeps the user's Claude Code working
// the whole way: put the profiles back first, then stop the service, then take
// away what sat beside it. Every external effect goes through `deps`.
import { existsSync, lstatSync, rmSync, unlinkSync } from "node:fs"
import path from "node:path"
import { readRoutes, writeRoutes } from "./config.ts"
import { linksInto, type Paths } from "./paths.ts"
import { removeStatusLine, unroute } from "./routes.ts"
import { LABEL, serviceKind, UNIT, uninstallService, type Run } from "./service.ts"
import type { SessionEntry } from "./sessions.ts"
import { lockHeld } from "./upgrade.ts"

const PLUGIN = "beacons@beacons"
const HEALTH_BUDGET_MS = 5000
const POLL_MS = 250
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export type UninstallDeps = {
  run: Run
  /** The open sessions, as GET /beacons/v1/status lists them. Called before the service stops. */
  openSessions(): Promise<SessionEntry[]>
  /** Whether the upstream proxy answers: asked before a route that was the proxy's is put back. */
  proxyUp(): Promise<boolean>
  /** beacons' health: non-null while the daemon answers. */
  health(): Promise<unknown | null>
  platform?: NodeJS.Platform
  /** How long to wait for the daemon to stop answering. */
  healthBudgetMs?: number
}

/** What each folder holds once beacons has used it: one of these must be there before the folder is deleted. */
const DATA_MARKERS = ["releases", "node", "state.json", "logs", "upgrade.lock", "boot-count.json", "last-upgrade.json"]
const CONFIG_MARKERS = ["accounts.json", "routes.json", "gateway.json"]

/** Remove `dir` only when it is absolute, named `beacons` and holds a beacons marker; otherwise say why it was kept. Never throws. */
function removeDir(dir: string, what: string, markers: string[], notes: string[]): void {
  if (!path.isAbsolute(dir) || path.basename(dir) !== "beacons") {
    notes.push(`${what} ${dir} is not an absolute folder named beacons, so it was kept`)
    return
  }
  if (!markers.some((m) => existsSync(path.join(dir, m)))) {
    notes.push(`${what} ${dir} holds nothing beacons made, so it was kept`)
    return
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    notes.push(`${what} ${dir} could not be removed (${message(err)})`)
  }
}

export async function uninstall(o: { purge: boolean; p: Paths; deps: UninstallDeps }): Promise<{ sessionsToRestart: string[]; notes: string[] }> {
  const { p, deps } = o
  const platform = deps.platform ?? process.platform
  const notes: string[] = []

  // Refuse before anything changes.
  if (lockHeld(p)) throw new Error("an upgrade is running; try again in a minute")

  // The records first: unroute drops each one, and the plugin step needs the list. A profile
  // `off` parked is not routed, but it still has the status line and the plugin setup gave it.
  const routes = readRoutes(p)
  const routed = Object.entries(routes.profiles).map(([dir, rec]) => ({ dir, plugin: rec.plugin }))
  const parked = Object.entries(routes.off ?? {})
    .filter(([dir]) => !Object.hasOwn(routes.profiles, dir))
    .map(([dir, rec]) => ({ dir, plugin: rec.plugin }))
  const profiles = [...routed, ...parked]
  const failed: string[] = []
  for (const { dir } of routed) {
    try {
      removeStatusLine(p, dir) // before unroute, which drops the record this reads
      const r = unroute(p, dir, { proxyUp: await deps.proxyUp().catch(() => false) })
      if (r.note) notes.push(r.note)
    } catch (err) {
      failed.push(`${dir} still routes to beacons (${message(err)}); fix its settings.json and run uninstall again`)
    }
  }
  for (const { dir } of parked) {
    try {
      removeStatusLine(p, dir)
    } catch (err) {
      // Not routed, so nothing points at beacons: a note, not a stop.
      notes.push(`${dir}: its status line could not be removed (${message(err)})`)
    }
  }
  // A profile left pointing at beacons must not lose its gateway: stop here, with the service running.
  if (failed.length > 0) throw new Error(failed.join("\n"))

  // The sessions, while the daemon still answers.
  let sessionsToRestart: string[] = []
  try {
    sessionsToRestart = (await deps.openSessions()).map((s) => s.id)
  } catch (err) {
    notes.push(`the open sessions could not be listed (${message(err)})`)
  }
  if (profiles.length > 0) {
    notes.push("A profile whose earlier value was restored moves its running sessions within seconds; a profile whose key was removed keeps its running sessions on beacons, so those need a restart.")
  }

  // The service, then a check that it is really gone.
  try {
    await uninstallService(p, deps.run, LABEL, platform)
  } catch (err) {
    notes.push(`the service could not be removed (${message(err)})`)
  }
  const budget = deps.healthBudgetMs ?? HEALTH_BUDGET_MS
  const deadline = Date.now() + budget
  let answering = (await deps.health().catch(() => null)) !== null
  while (answering && Date.now() < deadline) {
    await sleep(Math.min(POLL_MS, Math.max(1, budget / 5)))
    answering = (await deps.health().catch(() => null)) !== null
  }
  if (answering) {
    const stop = serviceKind(platform) === "launchd" ? `launchctl bootout gui/$(id -u)/${LABEL}` : `systemctl --user disable --now ${UNIT}`
    notes.push(`beacons is still answering after its service was removed. To stop it by hand: ${stop}`)
  }

  // The launcher: only a link into beacons' own data dir.
  try {
    if (linksInto(p.launcher, p.dataDir)) unlinkSync(p.launcher)
    else if (lstatSync(p.launcher).isSymbolicLink()) notes.push(`${p.launcher} does not link into ${p.dataDir}, so it was left alone`)
    else notes.push(`${p.launcher} is not a link beacons made, so it was left alone`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") notes.push(`${p.launcher} could not be removed (${message(err)})`)
  }

  // The plugin, per recorded profile whose folder is still there.
  for (const { dir, plugin } of profiles) {
    try {
      lstatSync(dir)
    } catch {
      continue // already noted by unroute
    }
    const r = await deps.run("env", [`CLAUDE_CONFIG_DIR=${dir}`, "claude", "plugin", "uninstall", PLUGIN]).catch((err) => ({ code: -1, stdout: "", stderr: message(err) }))
    if (r.code !== 0 && plugin) {
      notes.push(`${dir}: the beacons plugin did not uninstall (${(r.stderr || r.stdout).trim() || `exit ${r.code}`}). By hand: CLAUDE_CONFIG_DIR=${dir} claude plugin uninstall ${PLUGIN}`)
    }
  }

  // The parked records have nothing left to undo.
  if (routes.off !== undefined) {
    try {
      const now = readRoutes(p)
      delete now.off
      writeRoutes(p, now)
    } catch (err) {
      notes.push(`the profiles beacons off had parked could not be cleared from ${p.routesFile} (${message(err)})`)
    }
  }

  // The data; the config (accounts) only with purge.
  if (profiles.length > 0) notes.push("Each profile keeps the beacons marketplace entry setup added; setup cannot know whether you had it before. To remove it: claude plugin marketplace remove beacons (with CLAUDE_CONFIG_DIR set to the profile)")
  removeDir(p.dataDir, "the data folder", DATA_MARKERS, notes)
  if (o.purge) removeDir(p.configDir, "the config folder", CONFIG_MARKERS, notes)
  else notes.push(`${p.configDir} was kept, with your accounts; run uninstall --purge to remove it too`)

  return { sessionsToRestart, notes }
}
