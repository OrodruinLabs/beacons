// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT

export type Route = { mode: "pool" | "pin"; account: string | null; url: string }

/** `/pool/<a>/v1/...`, `/pin/<a>/v1/...` or bare `/v1/...`. Anything else, including a malformed account escape, is not ours: pool, no account, url unchanged. */
export function parseRoute(url: string): Route {
  const m = /^\/(pool|pin)\/([^/?#]+)(\/.*|\?.*)?$/.exec(url)
  if (m) {
    try {
      const account = decodeURIComponent(m[2])
      const rest = m[3] ?? ""
      return { mode: m[1] as "pool" | "pin", account, url: rest.startsWith("/") ? rest : "/" + rest }
    } catch {
      // A bad %-escape: not ours.
    }
  }
  return { mode: "pool", account: null, url }
}

export function routeBase(port: number, mode: "pool" | "pin", account: string): string {
  return `http://127.0.0.1:${port}/${mode}/${encodeURIComponent(account)}`
}

/** Whether `value` is a route beacons writes for `port`: pooled or pinned, on any account. */
export function isOurs(value: string, port: number): boolean {
  return value.startsWith(`http://127.0.0.1:${port}/pool/`) || value.startsWith(`http://127.0.0.1:${port}/pin/`)
}
