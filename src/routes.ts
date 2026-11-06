// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
import { existsSync } from "node:fs"
import path from "node:path"
import { readRoutes, writeRoutes, type ProfileRoute } from "./config.ts"
import type { Paths } from "./paths.ts"
import { isOurs, routeBase } from "./route.ts"
import { readSettings, writeSettings, SettingsError } from "./settings.ts"

const KEY = "ANTHROPIC_BASE_URL"
const settingsFile = (profile: string) => path.join(profile, "settings.json")
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)

/** A path as one shell word: as is when it is plain, else single-quoted (a data dir may hold a space). */
export const shellWord = (s: string): string => (/^[A-Za-z0-9_./+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/** A settings document's ANTHROPIC_BASE_URL: null when it has none, an empty one, or no `env` object to hold one. */
export function baseUrlIn(doc: Record<string, unknown>): string | null {
  const v = isObj(doc.env) ? doc.env[KEY] : undefined
  return typeof v === "string" && v !== "" ? v : null
}

/** A profile's ANTHROPIC_BASE_URL, or null. Throws SettingsError for a settings.json route() would refuse. */
export function baseUrlOf(profile: string): string | null {
  const file = settingsFile(profile)
  const doc = readSettings(file)
  if (doc.env !== undefined && !isObj(doc.env)) throw new SettingsError(file, '"env" is not an object')
  return baseUrlIn(doc)
}

/**
 * Whether `value` is a route to the upstream proxy at `chainUrl`: that URL, or
 * a path under it. Another path on the same host and port is not.
 */
export function onChain(value: string, chainUrl: string): boolean {
  const base = chainUrl.replace(/\/+$/, "")
  return value === base || value.startsWith(base + "/")
}

/** Whether a record's replaced route was a proxy's: any kind but "other", so a kind an older build wrote counts too. */
export const replacedProxy = (rec: ProfileRoute): boolean => rec.replaced !== null && rec.replacedKind !== null && rec.replacedKind !== "other"

export type RouteResult = { ok: true; others: string[] } | { ok: false; reason: "routed-elsewhere"; current: string }

/**
 * Route `profile` through beacons. A value already there is replaced when it is
 * beacons' own or a route to the proxy at `chainUrl` (kind "proxy"), or when
 * `replace` is set (kind "other"); any other value refuses.
 */
export function route(p: Paths, profile: string, o: { mode: "pool" | "pin"; account: string; port: number; replace?: boolean; chainUrl?: string | null }): RouteResult {
  profile = path.resolve(profile)
  const file = settingsFile(profile)
  const doc = readSettings(file)
  if (doc.env !== undefined && !isObj(doc.env)) throw new SettingsError(file, '"env" is not an object')
  const env: Record<string, unknown> = isObj(doc.env) ? doc.env : {}
  const routes = readRoutes(p)
  // A profile `off` parked: its record carries on (the value it replaced, which off put back, and its status line and plugin).
  const prior = routes.profiles[profile] ?? routes.off?.[profile]
  const current = env[KEY]
  let replaced: string | null = prior?.replaced ?? null
  let replacedKind: ProfileRoute["replacedKind"] = prior?.replacedKind ?? null
  if (typeof current === "string" && current !== "" && !isOurs(current, o.port) && current !== prior?.wrote.ANTHROPIC_BASE_URL && current !== prior?.replaced) {
    if (o.chainUrl && onChain(current, o.chainUrl)) { replaced = current; replacedKind = "proxy" }
    else if (o.replace) { replaced = current; replacedKind = "other" }
    else return { ok: false, reason: "routed-elsewhere", current }
  }
  const value = routeBase(o.port, o.mode, o.account)
  routes.profiles[profile] = {
    mode: o.mode, account: o.account, wrote: { ANTHROPIC_BASE_URL: value },
    replaced, replacedKind, statusLine: prior?.statusLine ?? null, plugin: prior?.plugin ?? false,
  }
  // Routed again, so no longer parked.
  if (routes.off) delete routes.off[profile]
  // Record first: a crash before the settings write leaves settings unchanged and the replaced value on file.
  writeRoutes(p, routes)
  env[KEY] = value
  doc.env = env
  writeSettings(file, doc)
  return { ok: true, others: Object.keys(env).filter((k) => k !== KEY) }
}

export function unroute(p: Paths, profile: string, o: { proxyUp: boolean }): { note?: string } {
  profile = path.resolve(profile)
  const routes = readRoutes(p)
  const rec = routes.profiles[profile]
  if (!rec) return {}
  const drop = () => { delete routes.profiles[profile]; writeRoutes(p, routes) }
  if (!existsSync(profile)) { drop(); return { note: `${profile} no longer exists; skipped` } }
  const file = settingsFile(profile)
  const doc = readSettings(file)
  const env: Record<string, unknown> | undefined = isObj(doc.env) ? doc.env : undefined
  if (!env || env[KEY] !== rec.wrote.ANTHROPIC_BASE_URL) {
    drop()
    return { note: `${profile}: ${KEY} was changed after setup; left as is` }
  }
  delete env[KEY]
  let note: string | undefined
  if (rec.replaced !== null) {
    if (replacedProxy(rec) && !o.proxyUp) note = `${profile}: the upstream proxy is not answering; its route was not restored and the profile now goes direct`
    else env[KEY] = rec.replaced
  }
  if (Object.keys(env).length === 0) delete doc.env
  writeSettings(file, doc)
  drop()
  return note ? { note } : {}
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Give a routed profile the status line that runs `beacons` (the launcher, or
 * the release's own bootstrap). "written" where it had none. "ours" where it
 * shows the line beacons wrote last time, which follows a `beacons` that
 * changed. "kept" where the line is the profile's own, or the profile is not
 * routed: left alone.
 */
export function setStatusLine(p: Paths, profile: string, beacons: string): "written" | "ours" | "kept" {
  profile = path.resolve(profile)
  const routes = readRoutes(p)
  const rec = routes.profiles[profile]
  if (!rec) return "kept"
  const file = settingsFile(profile)
  const doc = readSettings(file)
  const ours = doc.statusLine !== undefined && rec.statusLine !== null && rec.statusLine !== undefined && sameJson(doc.statusLine, rec.statusLine)
  if (doc.statusLine !== undefined && !ours) return "kept"
  const line = { type: "command", command: `${shellWord(beacons)} status --line`, refreshInterval: 30 }
  if (ours && sameJson(doc.statusLine, line)) return "ours"
  // Record first, as route() does.
  rec.statusLine = line
  writeRoutes(p, routes)
  doc.statusLine = line
  writeSettings(file, doc)
  return ours ? "ours" : "written"
}

/** Remove the status line beacons wrote, for a routed profile or one `off` parked. */
export function removeStatusLine(p: Paths, profile: string): void {
  profile = path.resolve(profile)
  const routes = readRoutes(p)
  const rec = routes.profiles[profile] ?? routes.off?.[profile]
  if (!rec || rec.statusLine === null || rec.statusLine === undefined) return
  if (existsSync(profile)) {
    const file = settingsFile(profile)
    const doc = readSettings(file)
    if (sameJson(doc.statusLine, rec.statusLine)) { delete doc.statusLine; writeSettings(file, doc) }
  }
  rec.statusLine = null
  writeRoutes(p, routes)
}
