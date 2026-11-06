// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
import { copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import { writeAtomic } from "./config.ts"

export class SettingsError extends Error {
  file: string
  constructor(file: string, why: string) {
    super(`${file}: ${why}; left untouched`)
    this.name = "SettingsError"
    this.file = file
  }
}

/** A missing file reads as `{}`. Anything that is not a JSON object throws SettingsError and nothing is written. */
export function readSettings(file: string): Record<string, unknown> {
  let text: string
  try { text = readFileSync(file, "utf8") } catch (e: any) {
    if (e?.code === "ENOENT") return {}
    throw new SettingsError(file, `cannot be read (${e?.code ?? "error"})`)
  }
  let doc: unknown
  try { doc = JSON.parse(text) } catch { throw new SettingsError(file, "is not valid JSON") }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new SettingsError(file, "is not a JSON object")
  return doc as Record<string, unknown>
}

/** Write through a symlink to its target, atomically. Keeps `<file>.beacons.bak` from the first write and never replaces it. */
export function writeSettings(file: string, doc: Record<string, unknown>): void {
  let target = file
  try { target = realpathSync(file) } catch (e: any) {
    if (e?.code !== "ENOENT") throw e
    let isLink = false
    try { isLink = lstatSync(file).isSymbolicLink() } catch { /* not there at all */ }
    if (isLink) throw new SettingsError(file, "is a symlink that points nowhere")
  }
  const exists = existsSync(target)
  const bak = `${file}.beacons.bak`
  if (exists && !existsSync(bak)) copyFileSync(target, bak)
  const mode = exists ? statSync(target).mode & 0o777 : 0o600
  writeAtomic(target, JSON.stringify(doc, null, 2) + "\n", mode)
}
