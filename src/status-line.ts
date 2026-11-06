// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT

export type LineInput = {
  daemon: "up" | "down"
  routed: boolean
  mode?: "pool" | "pin"
  first?: string | null
  account?: string | null
  chain?: { on: boolean; state: "up" | "down" | "unknown"; fallback: "wait" | "direct" }
}

/** The one line the status bar shows. Pure: callers gather the inputs. */
export function statusLine(i: LineInput): string {
  if (!i.routed) return "◔ beacons direct"
  if (i.daemon === "down") return "◕ beacons down"
  if (i.chain?.on && i.chain.state === "down") {
    return i.chain.fallback === "direct" ? "◑ beacons proxy down → direct" : "◕ beacons proxy down"
  }
  const first = i.first ?? null
  const account = i.account ?? first
  const failedOver = i.mode === "pool" && account !== first
  return `${failedOver ? "◑" : "◔"} beacons ${account ?? "pool"}`
}
