// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The crash-loop guard. Every daemon start records its time. A start that ends
// cleanly (exit 0), or that its environment stops (a taken port, a gateway.json
// or accounts.json it cannot load), takes its own time back out: neither says anything about the
// build. Three that stay inside a minute mean this build cannot stay up, and
// the daemon switches back to the one before it. The file is cleared then, so
// the build switched to starts a fresh count.
//
// Environment failures keep their own count. The service manager starts the
// daemon again at once, so a port another program holds would mean one Node
// start and one log line every second, for as long as it holds it. Each failure
// that follows another waits longer before it exits: 1 s, then twice that each
// time, up to a minute. A start that serves ends the run.
import { readFileSync, unlinkSync } from "node:fs"
import { writeAtomic } from "./config.ts"

const WINDOW_MS = 60_000
const LOOP_STARTS = 3
/** The wait after the second environment failure in a run; it doubles with each one after. */
const ENV_WAIT_FIRST_MS = 1000
const ENV_WAIT_CAP_MS = 60_000
/** Failures further apart than this are not one run: the longest wait, and the restart after it, fit well inside. */
const ENV_RUN_GAP_MS = 5 * 60_000

/** The recorded start times; a missing or unreadable file is none. */
function readStarts(file: string): number[] {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { starts?: unknown } | null
    const starts = j?.starts
    return Array.isArray(starts) ? starts.filter((t): t is number => typeof t === "number" && Number.isFinite(t)) : []
  } catch {
    return []
  }
}

/**
 * Record a start at `now`. Starts more than a minute old are dropped, and so
 * are any later than `now` (a clock set back would keep them forever).
 */
export function recordBoot(file: string, now: number): { crashLoop: boolean } {
  const starts = [...readStarts(file).filter((t) => t <= now && now - t < WINDOW_MS), now]
  const crashLoop = starts.length >= LOOP_STARTS
  writeAtomic(file, JSON.stringify({ starts: crashLoop ? [] : starts }) + "\n", 0o600)
  return { crashLoop }
}

/** Take one start back out of the count: the one recorded at `start`, by this process. Absent, nothing changes. */
export function forgetBoot(file: string, start: number): void {
  const starts = readStarts(file)
  const i = starts.indexOf(start)
  if (i < 0) return
  starts.splice(i, 1)
  writeAtomic(file, JSON.stringify({ starts }) + "\n", 0o600)
}

/**
 * Record an environment failure at `now`, and say how long to wait before
 * exiting: nothing for the first of a run, then 1 s, doubling each time, up to
 * a minute. A failure more than five minutes after the one before (or before
 * it: a clock set back) starts a new run, and so does a file that cannot be read.
 */
export function noteEnvironmentFailure(file: string, now: number): number {
  let count = 0
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { count?: unknown; at?: unknown } | null
    const at = j?.at
    if (typeof j?.count === "number" && Number.isInteger(j.count) && j.count > 0 && typeof at === "number" && at <= now && now - at <= ENV_RUN_GAP_MS) count = j.count
  } catch {
    // None yet, or debris: a new run.
  }
  count++
  writeAtomic(file, JSON.stringify({ count, at: now }) + "\n", 0o600)
  return count === 1 ? 0 : Math.min(ENV_WAIT_CAP_MS, ENV_WAIT_FIRST_MS * 2 ** Math.min(count - 2, 16))
}

/** A start that serves: the run of environment failures is over. */
export function clearEnvironmentFailures(file: string): void {
  try {
    unlinkSync(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
}
