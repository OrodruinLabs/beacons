// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT

export type SessionEntry = { id: string; account: string; mode: "pool" | "pin"; first: string | null; lastSeen: number }

const DAY_MS = 24 * 60 * 60 * 1000

/** Which account last served each Claude Code session. Memory only: a restart forgets it, and the status line falls back to the route. */
export class SessionMap {
  #m = new Map<string, SessionEntry>()

  record(id: string, e: Omit<SessionEntry, "id" | "lastSeen">, now: number = Date.now()): void {
    this.#m.set(id, { id, account: e.account, mode: e.mode, first: e.first, lastSeen: now })
  }
  get(id: string): SessionEntry | null {
    return this.#m.get(id) ?? null
  }
  list(): SessionEntry[] {
    return [...this.#m.values()]
  }
  prune(now: number, maxAgeMs: number = DAY_MS): void {
    for (const [id, e] of this.#m) if (now - e.lastSeen > maxAgeMs) this.#m.delete(id)
  }
}
