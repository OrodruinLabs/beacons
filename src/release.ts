// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// Releases. Each build lives in `releases/<version>/`, with a `release.json`
// naming the Node it runs on, installed in `node/<node>/`. The service runs
// `node/current` on `releases/current`. Both are symlinks, repointed by
// renaming a fresh link over the old one, so at every instant each names a
// whole build. `releases/state.json` remembers the current version, the one
// before it, and the one a manual rollback left (`held`), which the session
// hook does not upgrade to.
//
// A release is made once, by `snapshot`, from a plugin copy, and never
// changed after: it is copied into a temp folder beside the others and renamed
// into place whole. `prune` keeps the newest few.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { writeAtomic } from "./config.ts"
import type { Paths } from "./paths.ts"

export type ReleaseState = { current: string | null; previous: string | null; held: string | null }

/** A version or Node name is one plain path segment: never empty, never "." or "..", never a slash. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

/** A plugin version is semver, so it is never "current" or "state.json", the names beside the releases. */
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/

/** What a snapshot takes from a plugin copy. The rest (tests, docs, hooks) stays with the plugin. */
const SNAPSHOT_PARTS = ["bin", "src", "package.json", "node-sha256.txt", ".claude-plugin/plugin.json"]
/** Without these a plugin copy cannot run as a daemon. */
const REQUIRED_PARTS = ["src", "package.json", ".claude-plugin/plugin.json"]

const name = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null)

/** Something is at `p`, a dangling link included. */
const present = (p: string): boolean => {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** A real folder, not a link to one. */
const isDir = (p: string): boolean => {
  try {
    return lstatSync(p).isDirectory()
  } catch {
    return false
  }
}

/** The last path segment a symlink names, or null when there is no link. */
const linkName = (link: string): string | null => {
  try {
    return path.basename(readlinkSync(link))
  } catch {
    return null
  }
}

export function readReleaseState(p: Paths): ReleaseState {
  let text: string
  try {
    text = readFileSync(p.releaseState, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { current: null, previous: null, held: null }
    throw err
  }
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error(`${p.releaseState} is not valid JSON`)
  }
  if (j === null || typeof j !== "object" || Array.isArray(j)) throw new Error(`${p.releaseState} must be a JSON object`)
  const r = j as Record<string, unknown>
  return { current: name(r.current), previous: name(r.previous), held: name(r.held) }
}

/** Point `link` at `target`: a new link beside it, renamed over the old one. */
function repoint(link: string, target: string): void {
  const tmp = `${link}.${process.pid}.${Date.now()}.tmp`
  symlinkSync(target, tmp)
  try {
    renameSync(tmp, link)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // Already gone.
    }
    throw err
  }
}

/**
 * Make `version` the current release: `node/current` to the Node its
 * `release.json` names, `releases/current` to it, then `state.json` with
 * previous ← current. Everything is checked before anything moves: a release
 * folder or `release.json` that is missing, or a Node that is not installed,
 * throws and changes nothing. Switching to the current version again keeps the
 * real previous. `hold` sets `held` to the version left, in the same write (a
 * crash-loop switch, a rollback); otherwise `held` is kept as it is.
 */
export function switchTo(p: Paths, version: string, o: { hold?: boolean } = {}): void {
  if (!SEGMENT.test(version)) throw new Error(`"${version}" is not a release version`)
  const dir = path.join(p.releasesDir, version)
  if (!existsSync(dir)) throw new Error(`release ${version} is not installed (${dir})`)
  const manifest = path.join(dir, "release.json")
  let rel: { node?: unknown } | null
  try {
    rel = JSON.parse(readFileSync(manifest, "utf8")) as { node?: unknown } | null
  } catch {
    throw new Error(`release ${version} has no readable release.json (${manifest})`)
  }
  const node = typeof rel?.node === "string" ? rel.node : ""
  if (!SEGMENT.test(node)) throw new Error(`release ${version}'s release.json names no Node version`)
  const nodeDir = path.join(p.nodeDir, node)
  if (!existsSync(nodeDir)) throw new Error(`release ${version} runs on Node ${node}, which is not installed (${nodeDir})`)
  // Read before anything moves: a state file that cannot be read stops the switch.
  const state = readReleaseState(p)

  // Node first: the new build may need it, and an older build runs on a newer Node.
  repoint(p.currentNode, nodeDir)
  repoint(p.currentRelease, dir)
  const next: ReleaseState =
    state.current === version
      ? state
      : { current: version, previous: state.current, held: o.hold && state.current !== null ? state.current : state.held }
  writeAtomic(p.releaseState, JSON.stringify(next, null, 2) + "\n", 0o600)
}

/**
 * Hold `version` without switching anything: current and previous stay as they
 * are. For a build that failed before it was ever current (its boot check); its
 * snapshot is reused as it is, so trying it again could only fail again.
 */
export function hold(p: Paths, version: string): void {
  if (!SEGMENT.test(version)) throw new Error(`"${version}" is not a release version`)
  const state = readReleaseState(p)
  if (state.held === version) return
  writeAtomic(p.releaseState, JSON.stringify({ ...state, held: version }, null, 2) + "\n", 0o600)
}

/**
 * Throw at the first symlink at `part` in `root`, at a folder on the way to
 * it, or anywhere under it. A copied link either dangles (relative, out of the
 * tree) or keeps pointing into the plugin copy (absolute), and a release must
 * stand on its own once the plugin cache moves on.
 */
function refuseLinks(root: string, part: string): void {
  const segments = part.split("/")
  const check = (p: string): boolean => {
    let st
    try {
      st = lstatSync(p)
    } catch {
      return false
    }
    if (st.isSymbolicLink()) throw new Error(`${p} is a symbolic link; a release copies real files only, so it is refused`)
    return st.isDirectory()
  }
  for (let i = 1; i < segments.length; i++) if (!check(path.join(root, ...segments.slice(0, i)))) return
  const walk = (p: string): void => {
    if (check(p)) for (const e of readdirSync(p)) walk(path.join(p, e))
  }
  walk(path.join(root, part))
}

/** A plugin copy's version, from its `.claude-plugin/plugin.json`. Throws when there is none. */
export function pluginVersion(pluginRoot: string): string {
  const file = path.join(pluginRoot, ".claude-plugin", "plugin.json")
  let j: { version?: unknown } | null
  try {
    j = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown } | null
  } catch {
    throw new Error(`${file} is missing or not valid JSON`)
  }
  const v = j?.version
  if (typeof v !== "string" || !VERSION.test(v)) throw new Error(`${file} names no version (want semver, like 1.2.3)`)
  return v
}

/**
 * The Node a plugin copy runs on: the first line of its `node-sha256.txt`
 * (`v26.13.0` names 26.13.0). A copy without that file (a checkout) runs on
 * the Node running this.
 */
function pluginNode(pluginRoot: string): string {
  let text: string
  try {
    text = readFileSync(path.join(pluginRoot, "node-sha256.txt"), "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return process.versions.node
    throw err
  }
  const m = /^v?(\d+\.\d+\.\d+)\s*$/.exec(text.split("\n", 1)[0])
  if (!m) throw new Error(`${path.join(pluginRoot, "node-sha256.txt")}'s first line names no Node version`)
  return m[1]
}

/** A release's `release.json`: its version and the Node it runs on. Throws when it is missing or names neither. */
export function readRelease(dir: string): { version: string; node: string } {
  const file = path.join(dir, "release.json")
  let j: { version?: unknown; node?: unknown } | null
  try {
    j = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; node?: unknown } | null
  } catch {
    throw new Error(`${file} is missing or not valid JSON`)
  }
  const version = typeof j?.version === "string" ? j.version : ""
  const node = typeof j?.node === "string" ? j.node : ""
  if (!SEGMENT.test(version) || !SEGMENT.test(node)) throw new Error(`${file} must name a version and a Node`)
  return { version, node }
}

/**
 * Copy a plugin copy's runnable parts into `releases/<version>/`, with a
 * `release.json` naming its version and Node. The copy is made in a temp
 * folder beside the releases and renamed into place, so a release folder is
 * always whole. A release of that version already there is taken as it is:
 * a release never changes once made.
 */
export function snapshot(pluginRoot: string, p: Paths): { version: string; node: string; dir: string } {
  const version = pluginVersion(pluginRoot)
  const dir = path.join(p.releasesDir, version)
  if (present(dir)) {
    if (!isDir(dir)) throw new Error(`${dir} is in the way of release ${version}, and is not a release`)
    return { version, node: readRelease(dir).node, dir }
  }
  for (const part of SNAPSHOT_PARTS) refuseLinks(pluginRoot, part)
  for (const part of REQUIRED_PARTS) {
    if (!existsSync(path.join(pluginRoot, part))) throw new Error(`${pluginRoot} has no ${part}, so it is not a whole beacons plugin`)
  }
  const node = pluginNode(pluginRoot)
  mkdirSync(p.releasesDir, { recursive: true, mode: 0o700 })
  // A dot first: never a release name, so prune and a reader of releases/ pass it by.
  const tmp = mkdtempSync(path.join(p.releasesDir, `.${version}.`))
  try {
    for (const part of SNAPSHOT_PARTS) {
      const from = path.join(pluginRoot, part)
      if (existsSync(from)) cpSync(from, path.join(tmp, part), { recursive: true })
    }
    writeFileSync(path.join(tmp, "release.json"), JSON.stringify({ version, node }, null, 2) + "\n", { mode: 0o600 })
    renameSync(tmp, dir)
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    // Another snapshot of this version landed first: it is the same build.
    if (isDir(dir)) return { version, node: readRelease(dir).node, dir }
    throw err
  }
  return { version, node, dir }
}

/**
 * Remove the oldest releases (by when their `release.json` was written) until
 * `keep` are left, never the current, previous or held one, nor the one
 * `releases/current` names. Then remove each installed Node no remaining
 * release runs on. A folder without a readable `release.json` is not a
 * release, and is left alone.
 */
export function prune(p: Paths, keep = 5): void {
  const state = readReleaseState(p)
  const pinned = new Set([state.current, state.previous, state.held, linkName(p.currentRelease)])
  let entries: string[]
  try {
    entries = readdirSync(p.releasesDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    throw err
  }
  const releases: { version: string; node: string; at: number }[] = []
  for (const e of entries) {
    const dir = path.join(p.releasesDir, e)
    if (!SEGMENT.test(e) || !isDir(dir)) continue
    try {
      const { node } = readRelease(dir)
      releases.push({ version: e, node, at: statSync(path.join(dir, "release.json")).mtimeMs })
    } catch {
      // Not a release.
    }
  }
  if (releases.length === 0) return
  releases.sort((a, b) => a.at - b.at || (a.version < b.version ? -1 : a.version > b.version ? 1 : 0))

  let left = releases.length
  const kept = new Set<string>()
  for (const r of releases) {
    if (left > keep && !pinned.has(r.version)) {
      rmSync(path.join(p.releasesDir, r.version), { recursive: true, force: true })
      left--
    } else {
      kept.add(r.node)
    }
  }
  const currentNode = linkName(p.currentNode)
  if (currentNode) kept.add(currentNode)
  let nodes: string[]
  try {
    nodes = readdirSync(p.nodeDir)
  } catch {
    return
  }
  for (const n of nodes) {
    const dir = path.join(p.nodeDir, n)
    if (SEGMENT.test(n) && !kept.has(n) && isDir(dir)) rmSync(dir, { recursive: true, force: true })
  }
}
