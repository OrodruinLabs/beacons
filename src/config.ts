// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs"
import path from "node:path"
import type { Paths } from "./paths.ts"

export const DEFAULT_PORT = 4774
export const ANTHROPIC = "https://api.anthropic.com"

export type GatewayConfig = { port: number; upstreamUrl: string; chainFallback: "wait" | "direct" }

export type ProfileRoute = {
  mode: "pool" | "pin"; account: string
  wrote: { ANTHROPIC_BASE_URL: string }
  replaced: string | null; replacedKind: "proxy" | "other" | null
  statusLine: unknown | null; plugin: boolean
}
/**
 * `profiles` are the routed profiles. `off` holds the records `beacons off`
 * parked: their mode and account for `on`, their status line and plugin for
 * `uninstall`. A parked profile is not routed, so every reader of `profiles`
 * (the daemon, the sh status line, setup) passes it by.
 */
export type RoutesFile = { version: 1; profiles: Record<string, ProfileRoute>; off?: Record<string, ProfileRoute> }

function readJsonFile(file: string): unknown {
  let text: string
  try { text = readFileSync(file, "utf8") } catch (e: any) { if (e?.code === "ENOENT") return undefined; throw e }
  try { return JSON.parse(text) } catch { throw new Error(`${file} is not valid JSON`) }
}

/** Write through a temp file in the same folder, fsync, then rename over the target. */
export function writeAtomic(file: string, text: string, mode: number): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  const fd = openSync(tmp, "w", mode)
  try { writeSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, file)
}

export function loadGatewayConfig(p: Paths): GatewayConfig {
  const raw = readJsonFile(p.gatewayFile)
  const out: GatewayConfig = { port: DEFAULT_PORT, upstreamUrl: ANTHROPIC, chainFallback: "wait" }
  if (raw === undefined) return out
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${p.gatewayFile} must be a JSON object`)
  const r = raw as Record<string, unknown>
  // 0 asks the OS for a spare port: the upgrade's boot check and the tests run a daemon that way.
  if (r.port !== undefined) {
    if (typeof r.port !== "number" || !Number.isInteger(r.port) || r.port < 0 || r.port > 65535) throw new Error("gateway.json: port must be an integer from 0 to 65535")
    out.port = r.port
  }
  if (r.upstreamUrl !== undefined) {
    if (typeof r.upstreamUrl !== "string" || r.upstreamUrl === "") throw new Error("gateway.json: upstreamUrl must be a non-empty string")
    out.upstreamUrl = r.upstreamUrl
  }
  if (r.chainFallback !== undefined) {
    if (r.chainFallback !== "wait" && r.chainFallback !== "direct") throw new Error('gateway.json: chainFallback must be "wait" or "direct"')
    out.chainFallback = r.chainFallback
  }
  return out
}

export function saveGatewayConfig(p: Paths, c: GatewayConfig): void {
  const { port, upstreamUrl, chainFallback } = c
  writeAtomic(p.gatewayFile, JSON.stringify({ port, upstreamUrl, chainFallback }, null, 2) + "\n", 0o600)
}

/** Create the config, data and log folders at 0700; tighten accounts.json to 0600 if it exists (never creates it). */
export function ensurePrivateDirs(p: Paths): void {
  for (const d of [p.configDir, p.dataDir, p.logsDir]) {
    mkdirSync(d, { recursive: true, mode: 0o700 })
    chmodSync(d, 0o700)
  }
  if (existsSync(p.accountsFile)) chmodSync(p.accountsFile, 0o600)
}

export function readRoutes(p: Paths): RoutesFile {
  const raw = readJsonFile(p.routesFile)
  if (raw === undefined) return { version: 1, profiles: {} }
  const r = raw as Partial<RoutesFile> | null
  // An array for profiles would take a profile as a named property, which JSON.stringify drops: a route written without its record.
  if (r === null || typeof r !== "object" || r.version !== 1 || r.profiles === null || typeof r.profiles !== "object" || Array.isArray(r.profiles)) throw new Error(`${p.routesFile} is not a version 1 routes file`)
  const out: RoutesFile = { version: 1, profiles: r.profiles }
  // Parked records ride along, so a caller that reads, edits and writes keeps them. Anything else there is not one.
  if (r.off !== null && typeof r.off === "object" && !Array.isArray(r.off)) out.off = r.off
  return out
}

/** An empty `off` is left out. */
export function writeRoutes(p: Paths, r: RoutesFile): void {
  const { off, ...rest } = r
  const doc: RoutesFile = off && Object.keys(off).length > 0 ? { ...rest, off } : rest
  writeAtomic(p.routesFile, JSON.stringify(doc, null, 2) + "\n", 0o600)
}
