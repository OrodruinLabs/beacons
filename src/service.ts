// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The service units: a launchd user agent on macOS, a systemd user unit on Linux.
// Both run the current release on beacons' own Node (never the system one), and
// restart it whenever it exits. The renderers are pure; install, uninstall,
// kickstart and ensureStarted shell out through an injected `Run`, so tests
// never touch launchctl.
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { userInfo } from "node:os"
import path from "node:path"
import type { Paths } from "./paths.ts"

export type Run = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

export const LABEL = "com.orodruinlabs.beacons"
export const UNIT = "beacons.service"

export function serviceKind(platform: NodeJS.Platform = process.platform): "launchd" | "systemd" {
  if (platform === "win32") throw new Error("Windows comes in a later version")
  return platform === "darwin" ? "launchd" : "systemd"
}

/** What the unit runs: beacons' own Node, on the current release's daemon. */
function program(p: Paths): string[] {
  return [path.join(p.currentNode, "bin", "node"), "--experimental-strip-types", "--no-warnings", path.join(p.currentRelease, "src", "daemon.ts")]
}

/** The environment the unit sets: resolved now, so it holds whatever the install saw. Never CLAUDE_CONFIG_DIR. */
function unitEnv(p: Paths): [string, string][] {
  return [
    ["HOME", p.home],
    ["PATH", "/usr/bin:/bin"],
    ["XDG_CONFIG_HOME", path.dirname(p.configDir)],
    ["XDG_DATA_HOME", path.dirname(p.dataDir)],
  ]
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function renderLaunchd(p: Paths, label: string = LABEL): string {
  const log = path.join(p.logsDir, "daemon.log")
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key><string>${xml(label)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...program(p).map((a) => `    <string>${xml(a)}</string>`),
    `  </array>`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>KeepAlive</key><true/>`,
    `  <key>ThrottleInterval</key><integer>1</integer>`,
    `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...unitEnv(p).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`),
    `  </dict>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n")
}

/** One ExecStart word: quoted when it must be, `%` and `$` doubled (systemd expands both). */
function execWord(a: string): string {
  const esc = a.replace(/%/g, "%%").replace(/\$/g, "$$$$")
  return /^[A-Za-z0-9_@%$+=:,./-]+$/.test(esc) ? esc : `"${esc.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/** An Environment= value: `KEY=value`, quoted when it holds anything but plain characters. */
function envWord(kv: string): string {
  const esc = kv.replace(/%/g, "%%")
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(esc) ? esc : `"${esc.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

export function renderSystemd(p: Paths): string {
  return [
    `[Unit]`,
    `Description=beacons gateway`,
    ``,
    `[Service]`,
    `Type=simple`,
    `ExecStart=${program(p).map(execWord).join(" ")}`,
    ...unitEnv(p).map(([k, v]) => `Environment=${envWord(`${k}=${v}`)}`),
    `Restart=always`,
    `RestartSec=0.5`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ].join("\n")
}

const domain = () => `gui/${process.getuid!()}`

function unitFile(p: Paths, kind: "launchd" | "systemd", label: string): string {
  return kind === "launchd"
    ? path.join(p.home, "Library", "LaunchAgents", `${label}.plist`)
    : path.join(path.dirname(p.configDir), "systemd", "user", UNIT)
}

/** Whether beacons' unit file is in place, so the service manager can start it. `platform` is for tests. */
export function serviceInstalled(p: Paths, label: string = LABEL, platform: NodeJS.Platform = process.platform): boolean {
  return existsSync(unitFile(p, serviceKind(platform), label))
}

async function must(run: Run, cmd: string, args: string[]): Promise<void> {
  const r = await run(cmd, args)
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`)
}

/** Write the unit (0644), make the logs folder (0700) and load the service. `platform` is for tests. */
export async function installService(p: Paths, run: Run, label: string = LABEL, platform: NodeJS.Platform = process.platform): Promise<void> {
  const kind = serviceKind(platform)
  const file = unitFile(p, kind, label)
  mkdirSync(p.logsDir, { recursive: true, mode: 0o700 })
  chmodSync(p.logsDir, 0o700)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, kind === "launchd" ? renderLaunchd(p, label) : renderSystemd(p), { mode: 0o644 })
  chmodSync(file, 0o644)
  if (kind === "launchd") {
    await run("launchctl", ["bootout", `${domain()}/${label}`]) // "not loaded" is fine
    await must(run, "launchctl", ["bootstrap", domain(), file])
  } else {
    await must(run, "systemctl", ["--user", "daemon-reload"])
    await must(run, "systemctl", ["--user", "enable", "--now", UNIT])
  }
}

/** Stop the service and remove the unit file. The data stays. */
export async function uninstallService(p: Paths, run: Run, label: string = LABEL, platform: NodeJS.Platform = process.platform): Promise<void> {
  const kind = serviceKind(platform)
  const file = unitFile(p, kind, label)
  if (kind === "launchd") await run("launchctl", ["bootout", `${domain()}/${label}`])
  else await run("systemctl", ["--user", "disable", "--now", UNIT])
  try {
    unlinkSync(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
  if (kind === "systemd") await run("systemctl", ["--user", "daemon-reload"])
}

/** Restart now, even when the process is hung. */
export async function kickstart(_p: Paths, run: Run, label: string = LABEL, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (serviceKind(platform) === "launchd") await must(run, "launchctl", ["kickstart", "-k", `${domain()}/${label}`])
  else await must(run, "systemctl", ["--user", "restart", UNIT])
}

/**
 * Start the service if it is not running. One that is running, even slowly, is
 * left alone with its open streams: launchd's `kickstart` without `-k`, and
 * systemd's `start`, do nothing to a running job.
 */
export async function ensureStarted(_p: Paths, run: Run, label: string = LABEL, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (serviceKind(platform) === "launchd") await must(run, "launchctl", ["kickstart", `${domain()}/${label}`])
  else await must(run, "systemctl", ["--user", "start", UNIT])
}

/** Whether the user's units keep running after logout (Linux). */
export async function lingerOn(run: Run): Promise<boolean> {
  const user = process.env.USER || process.env.LOGNAME || userInfo().username
  const r = await run("loginctl", ["show-user", user, "-p", "Linger"])
  return r.code === 0 && /^Linger=yes\s*$/m.test(r.stdout)
}
