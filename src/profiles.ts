// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import path from "node:path"

function isDir(p: string): boolean { try { return statSync(p).isDirectory() } catch { return false } }

/** `~/.claude` (always), every `~/.claude*` folder holding a settings.json, and CLAUDE_CONFIG_DIR. Absolute, unique by realpath, `~/.claude` first. */
export function discoverProfiles(home: string, env: NodeJS.ProcessEnv): string[] {
  const main = path.join(home, ".claude")
  const found: string[] = [main]
  let names: string[] = []
  try { names = readdirSync(home).filter((n) => n.startsWith(".claude")).sort() } catch { /* no home */ }
  for (const n of names) {
    const d = path.join(home, n)
    if (d !== main && isDir(d) && existsSync(path.join(d, "settings.json"))) found.push(d)
  }
  if (env.CLAUDE_CONFIG_DIR) found.push(path.resolve(env.CLAUDE_CONFIG_DIR))
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of found) {
    let key = d
    try { key = realpathSync(d) } catch { /* not created yet */ }
    if (seen.has(key)) continue
    seen.add(key); out.push(d)
  }
  return out
}

/** A profile as the user names it: `~`, `~/x`, or a path from the working folder. Absolute. */
export function resolveProfile(s: string, home: string): string {
  if (s === "~") return home
  if (s.startsWith("~/")) return path.join(home, s.slice(2))
  return path.resolve(s)
}

/** `~` for the home folder at the front of `file`, as messages name a profile. */
export function tilde(home: string, file: string): string {
  if (file === home) return "~"
  return file.startsWith(home + path.sep) ? "~" + file.slice(home.length) : file
}
