// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The accounts file, from outside the daemon: login, logout and order.
//
// An account is (accountUuid, orgUuid), so one person in two orgs is two rows and
// a re-login updates rather than duplicates; that rule comes from the vendored
// identity.js, so this file and the engine cannot disagree. Every write holds the
// engine's own lock (`<file>.lock`) across its read and its write and lands the
// way the engine's does (fsync'd temp file, rename, 0600). The daemon rotates
// refresh tokens into this file while it serves; without the lock, an edit that
// read the file before a rotation would write the rotated-away token back.
// Nothing slow runs inside the lock (a login's profile call is made before it),
// because the daemon waits 2 s at most.
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { withConfigLock, writeJsonAtomic } from "./engine/config.js"
import { findUpsertTarget, sameIdentity } from "./engine/identity.js"
import { fetchProfile, loginOAuth } from "./engine/oauth.js"
import type { AccountRecord, AccountsFile, Tokens } from "./engine/types.d.ts"
import { post } from "./loopback.ts"

export type Profile = Awaited<ReturnType<typeof fetchProfile>>

/** The network calls login makes, replaceable in tests. */
export type LoginDeps = {
  loginOAuth?: typeof loginOAuth
  fetchProfile?: typeof fetchProfile
}

export function readPool(file: string): AccountsFile {
  if (!existsSync(file)) return { accounts: [] }
  const doc = JSON.parse(readFileSync(file, "utf8")) as Partial<AccountsFile>
  return { ...doc, accounts: Array.isArray(doc.accounts) ? doc.accounts : [] }
}

/** Account names by priority, then position: the order the engine tries them in. */
export function accountNames(file: string): string[] {
  return readPool(file).accounts
    .map((a, i) => ({ name: a.name, p: a.priority ?? 0, i }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map((x) => x.name)
}

/**
 * Read, edit, write, all under the lock. `edit` must not await anything slow.
 * Binds the engine's config path to `file` the way the daemon's boot does
 * (TEAMCLAUDE_CONFIG), so the engine's own helpers agree on which file this is.
 */
export function updatePool<T>(file: string, edit: (doc: AccountsFile) => T): Promise<T> {
  process.env.TEAMCLAUDE_CONFIG = file
  return withConfigLock(file, async () => {
    const doc = readPool(file)
    const out = edit(doc)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    await writeJsonAtomic(file, doc)
    chmodSync(file, 0o600)
    return out
  })
}

const orgLabel = (a: AccountRecord) => a.orgName || (a.orgUuid ? a.orgUuid.slice(0, 8) : "org")

/**
 * The profile names the account and fixes its identity, then a row with the same
 * identity is updated or one is added. Two orgs for one person get " (org)"
 * suffixes so the names stay distinct. Pure: the profile is fetched by the caller.
 */
function upsertOAuth(
  doc: AccountsFile,
  tokens: Tokens,
  profile: Profile,
  name: string | undefined,
  log: (line: string) => void,
): { account: AccountRecord; existed: boolean } {
  if (!profile || profile.error) log(`warning: could not fetch the account profile (${profile?.error ?? "no token"})`)
  let chosen = name
  if (!chosen && profile?.email) {
    chosen = profile.email
    const tier = profile.hasClaudeMax ? "Max" : profile.hasClaudePro ? "Pro" : null
    if (tier) log(`Claude ${tier} account: ${profile.email}`)
  }
  if (!chosen) chosen = `account-${doc.accounts.filter((a) => a.name.startsWith("account-")).length + 1}`

  const account: AccountRecord = {
    name: chosen,
    type: "oauth",
    source: "login",
    accountUuid: profile?.accountUuid ?? null,
    orgUuid: profile?.orgUuid ?? null,
    orgName: profile?.orgName ?? null,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  }
  const idx = findUpsertTarget(doc.accounts, account)
  if (idx >= 0) {
    const prev = doc.accounts[idx]
    doc.accounts[idx] = { ...prev, ...account, name: prev.name }
    log(`updated "${prev.name}"`)
    return { account: doc.accounts[idx], existed: true }
  }
  if (!name && account.accountUuid) {
    const collisions = doc.accounts.filter((a) => a.accountUuid === account.accountUuid && !sameIdentity(a, account))
    if (collisions.length > 0) {
      for (const c of collisions) if (!c.name.includes(" (")) c.name = `${c.name} (${orgLabel(c)})`
      account.name = `${chosen} (${orgLabel(account)})`
    }
  }
  doc.accounts.push(account)
  log(`added "${account.name}"`)
  return { account, existed: false }
}

/**
 * Browser login, then upsert. Runs in a terminal: it opens a browser. `existed`
 * is true when the sign-in matched a row already in the file.
 */
export async function login(
  file: string,
  o: { name?: string },
  log: (l: string) => void,
  deps: LoginDeps = {},
): Promise<{ account: AccountRecord; existed: boolean }> {
  const tokens = await (deps.loginOAuth ?? loginOAuth)()
  const profile = await (deps.fetchProfile ?? fetchProfile)(tokens.accessToken)
  return updatePool(file, (doc) => upsertOAuth(doc, tokens, profile, o.name, log))
}

const known = (doc: AccountsFile) => (doc.accounts.length ? doc.accounts.map((a) => `"${a.name}"`).join(", ") : "none")

/** The one row named exactly `want`; throws for none, or for a name more than one row holds. */
function exactlyOne(doc: AccountsFile, want: string): number {
  const hits = doc.accounts.flatMap((a, i) => (a.name === want ? [i] : []))
  if (hits.length === 0) throw new Error(`no account named "${want}"; known: ${known(doc)}`)
  if (hits.length > 1) throw new Error(`"${want}" matches ${hits.length} accounts; rename one first`)
  return hits[0]
}

/** Remove the row named exactly `want` and return it. */
export function logout(file: string, want: string): Promise<AccountRecord> {
  return updatePool(file, (doc) => doc.accounts.splice(exactlyOne(doc, want), 1)[0])
}

/**
 * Priority 0..n-1 in the order given; rows not named follow, in the order they
 * had (priority, then position). Every name must match exactly one row, or
 * nothing is written.
 */
export function order(file: string, wanted: string[]): Promise<void> {
  return updatePool(file, (doc) => {
    const picked = new Set<number>()
    for (const w of wanted) {
      const i = exactlyOne(doc, w)
      if (picked.has(i)) throw new Error(`"${w}" is named twice`)
      picked.add(i)
    }
    const rest = doc.accounts
      .map((a, i) => ({ i, p: a.priority ?? 0 }))
      .filter((x) => !picked.has(x.i))
      .sort((a, b) => a.p - b.p || a.i - b.i)
      .map((x) => x.i)
    const sequence = [...[...picked], ...rest]
    sequence.forEach((i, n) => {
      doc.accounts[i].priority = n
    })
  })
}

/** Tell a running daemon to re-read the file. False when nothing answers. */
export async function notifyReload(port: number): Promise<boolean> {
  try {
    const res = await post(port, "/beacons/v1/reload", 2000)
    return res.status >= 200 && res.status < 300
  } catch {
    return false
  }
}
