// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
import { lstatSync, readlinkSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type Paths = {
  home: string; configDir: string; dataDir: string
  accountsFile: string; gatewayFile: string; routesFile: string
  releasesDir: string; currentRelease: string; releaseState: string
  nodeDir: string; currentNode: string; logsDir: string
  upgradeLock: string; bootCount: string; envFailures: string; lastUpgrade: string; launcher: string
}

/** An XDG base dir, or null when unset or relative (the spec says a relative one is invalid and must be ignored). */
const xdg = (v: string | undefined): string | null => (v && path.isAbsolute(v) ? v : null)

export function beaconsPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.HOME || homedir()
  const configDir = path.join(xdg(env.XDG_CONFIG_HOME) || path.join(home, ".config"), "beacons")
  const dataDir = path.join(xdg(env.XDG_DATA_HOME) || path.join(home, ".local", "share"), "beacons")
  const releasesDir = path.join(dataDir, "releases")
  const nodeDir = path.join(dataDir, "node")
  return {
    home, configDir, dataDir,
    accountsFile: path.join(configDir, "accounts.json"),
    gatewayFile: path.join(configDir, "gateway.json"),
    routesFile: path.join(configDir, "routes.json"),
    releasesDir, currentRelease: path.join(releasesDir, "current"), releaseState: path.join(releasesDir, "state.json"),
    nodeDir, currentNode: path.join(nodeDir, "current"),
    logsDir: path.join(dataDir, "logs"),
    upgradeLock: path.join(dataDir, "upgrade.lock"),
    bootCount: path.join(dataDir, "boot-count.json"),
    envFailures: path.join(dataDir, "env-failures.json"),
    lastUpgrade: path.join(dataDir, "last-upgrade.json"),
    launcher: path.join(home, ".local", "bin", "beacons"),
  }
}

/**
 * Whether `link` is a symlink whose target lies inside `dir`: beacons' own
 * launcher links into its data folder. False for a plain file, a missing path,
 * or a link anywhere else, which is another program's.
 */
export function linksInto(link: string, dir: string): boolean {
  try {
    if (!lstatSync(link).isSymbolicLink()) return false
    const rel = path.relative(dir, path.resolve(path.dirname(link), readlinkSync(link)))
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
  } catch {
    return false
  }
}
