// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// The credential plane: the vendored engine (./engine/) booted against beacons'
// own accounts file. What lives here is the glue around it (boot, persistence,
// reload) and one function, `serve`, that hands a request to the engine's
// retry-switch loop and reports what it did. Nothing in this file decides which
// account serves or when to rotate; that is the engine's job, and its tests'.
//
// OWNERSHIP. Whoever refreshes an OAuth token owns the grant: a refresh rotates
// the refresh token, and every other holder's copy dies with `invalid_grant`.
// So this engine refreshes only what is in ITS file (`accountsFile`). A login
// copied here from anywhere else must stop being refreshed there first.
import type { IncomingMessage, ServerResponse } from "node:http"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { AccountManager, parseAdvisorModel, parseRequestModel } from "./engine/account-manager.js"
import { atomicConfigUpdate, loadConfig as readAccountsFile, loadState, saveState } from "./engine/config.js"
import { sameIdentity } from "./engine/identity.js"
import { importCredentials, refreshAccessToken } from "./engine/oauth.js"
import { Prober } from "./engine/prober.js"
import type { ProbeStatus } from "./engine/prober.js"
import { resolveAccounts } from "./engine/resolve-accounts.js"
import { forwardRequest, resolveAccountPin } from "./engine/server.js"
import type { ForwardCtx } from "./engine/server.js"
import type { AccountRecord, AccountsFile, ManagedAccount, ManagerStatus, Tokens } from "./engine/types.d.ts"

/**
 * How often the quota prober reads every account's buckets when neither the
 * accounts file nor the caller says. The usage API spends no quota; without it
 * an account nobody is using keeps the numbers it had when traffic last left it.
 */
export const DEFAULT_PROBE_SECONDS = 300

/**
 * The serving org's billing state: whether extra usage is on, why not, what
 * upgrade it could buy (teamclaude b5be7fa, #478). Claude Code caches it as its
 * OWN org's, so behind a pool of two orgs it can show the wrong one's. The
 * engine reads every header for quota before the reply is written; only the
 * client's copy loses these.
 */
export const isOverageHeader = (name: string): boolean => {
  const lk = name.toLowerCase()
  return lk.startsWith("anthropic-ratelimit-unified-overage-") || lk === "anthropic-ratelimit-unified-upgrade-paths"
}

/** On unless the file says `stripOverageHeaders: false`: a pool is the normal case. */
const stripsOverage = (doc: { stripOverageHeaders?: unknown }) => doc.stripOverageHeaders !== false

export type ServeResult = {
  /** The status the client got; null when no reply head was sent. */
  status: number | null
  account: string | null
  /** Why upstream failed this request (a reset before any reply, a cut stream); null otherwise. */
  error: string | null
}

export type Engine = {
  /** The engine's status, without accounts that left the file. */
  status(): ManagerStatus
  /** Re-sync from the file: new rows added, rows gone taken out, credentials and toggles applied. */
  reload(): Promise<{ added: number; removed: number }>
  /** Hand one request to the retry-switch loop. Resolves when the response is done. */
  serve(a: {
    req: IncomingMessage
    res: ServerResponse
    /** The path to send upstream, with the /pool/ or /pin/ prefix already stripped. */
    url: string
    body: Buffer
    reqId: string
    sessionId: string | null
    pin: { account: string | null; mode: "pool" | "pin" }
    /** This request's upstream base; the engine appends `url` to it as a string. */
    upstream: string
  }): Promise<ServeResult>
  /** Ask Anthropic's usage API for every enabled OAuth account's buckets now. */
  probe(): Promise<ProbeStatus>
  /** Write quota state now (an interval does it every minute anyway). */
  persist(): Promise<void>
  stop(): Promise<void>
}

/** A file with no accounts is a valid start; `login` fills it. Never replaces one that exists. */
export function ensureAccountsFile(file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const empty: AccountsFile = { accounts: [], switchThreshold: 0.98, holdSeconds: 0 }
  try {
    writeFileSync(file, `${JSON.stringify(empty, null, 2)}\n`, { mode: 0o600, flag: "wx" })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
  }
}

/**
 * Point the vendored config.js at OUR file. It reads `TEAMCLAUDE_CONFIG` on every
 * call rather than caching, so setting it at boot is the whole seam (the quota
 * state file is its sibling, `accounts.state.json`). Process-wide by nature: one
 * live engine per process. A second boot rebinds it, so the engine before must
 * be stopped first or its later writes follow the new path.
 */
function bindAccountsFile(file: string): void {
  process.env.TEAMCLAUDE_CONFIG = file
}

const findRow = (doc: AccountsFile, account: { accountUuid: string | null; orgUuid: string | null; name: string }) =>
  doc.accounts.findIndex((a) => sameIdentity(a, account))

export async function bootEngine(o: {
  accountsFile: string
  log?: (l: string) => void
  refreshFn?: (rt: string) => Promise<Tokens>
  /** The prober's interval when the file has no `quotaProbeSeconds` (0 = off). */
  probeSeconds?: number
}): Promise<Engine> {
  const log = o.log ?? ((line: string) => process.stderr.write(`beacons: ${line}\n`))
  ensureAccountsFile(o.accountsFile)
  bindAccountsFile(o.accountsFile)

  const doc: AccountsFile = (await readAccountsFile()) ?? { accounts: [] }
  const accounts = await resolveAccounts(doc)
  const threshold = typeof doc.switchThreshold === "number" ? doc.switchThreshold : 0.98
  const holdMs = (typeof doc.holdSeconds === "number" ? doc.holdSeconds : 0) * 1000
  // Live: reload() re-reads it, and the next reply follows.
  let stripOverage = stripsOverage(doc)

  const am = new AccountManager(accounts, threshold, {
    ramp: doc.stormRamp,
    distributeSessions: doc.distributeSessions,
    refreshFn: o.refreshFn ?? refreshAccessToken,
  })

  // Quota observed by a previous run, so a restart does not forget which
  // account is nearly spent. Passive: nothing here calls the API to re-learn it.
  const saved = await loadState().catch((err: Error) => {
    log(`could not read quota state: ${err.message}`)
    return null
  })
  if (saved?.quota) am.restoreQuotaState(saved.quota)
  am.selectActiveAccount()

  const persist = () =>
    saveState({ quota: am.exportQuotaState() }).catch((err: Error) => log(`could not save quota state: ${err.message}`))
  const timer = setInterval(() => void persist(), 60_000)
  timer.unref()

  // The quota prober, whatever the upstream: it calls Anthropic's usage API
  // directly, never through the chain. The file's `quotaProbeSeconds` wins, then
  // the caller's, then the default (0 = off). It keeps an idle account's numbers
  // true and is the only way to learn the Sonnet weekly bucket.
  const probeSeconds = typeof doc.quotaProbeSeconds === "number" ? doc.quotaProbeSeconds : (o.probeSeconds ?? DEFAULT_PROBE_SECONDS)
  const prober = new Prober(am, {
    intervalMs: probeSeconds * 1000,
    log: (m) => log(m.replace(/^\[TeamClaude\] /, "")),
  })
  prober.start()

  // Accounts that left the file while serving. The engine knows an account by
  // its POSITION (a refresh under way reports back by index, a request releases
  // its slot by index, sessions remember one), so splicing one out would shift
  // every one after it, and a refresh still running on the gone login would land
  // its token in the neighbour's row. So it stays in place, disabled and hidden
  // from every status, until the next boot reads a file without it. Its row is
  // gone, so nothing it does is written.
  const removed = new Set<ManagedAccount>()
  const shown = <T>(rows: T[]): T[] => rows.filter((_, i) => !removed.has(am.accounts[i]))
  const servesNow = (a: ManagedAccount | undefined): boolean => !!a && !removed.has(a) && !a.disabled

  // A refreshed token goes to disk through the serialized read-modify-write
  // under the file lock: what keeps two accounts refreshing at once from
  // clobbering each other's rotated refresh token. Matched by identity, not
  // index: the file may have been reordered or gained a row since we read it.
  let writes: Promise<unknown> = Promise.resolve()
  am.onTokenRefresh((idx, tokens) => {
    const account = am.accounts[idx]
    if (!account) return
    writes = atomicConfigUpdate((disk) => {
      for (const row of disk.accounts) {
        if (!am.accounts.some((a) => sameIdentity(a, row))) am.addAccount(row)
      }
      const i = findRow(disk, account)
      if (i >= 0) {
        disk.accounts[i].accessToken = tokens.accessToken
        disk.accounts[i].refreshToken = tokens.refreshToken
        disk.accounts[i].expiresAt = tokens.expiresAt
      }
    }).catch((err: Error) => log(`could not save refreshed token for ${account.name}: ${err.message}`))
  })

  /**
   * teamclaude's syncAccountsFromDisk: pair file rows to running accounts by
   * identity (greedy 1:1, so two orgs of one person pair right), add the new
   * ones, pick up renames, priority and disable toggles, and take fresher
   * credentials, never staler ones. Then take out every running account no row
   * paired with: that login left the file.
   */
  const reload = async (): Promise<{ added: number; removed: number }> => {
    const disk = await readAccountsFile()
    if (!disk) return { added: 0, removed: 0 }
    let added = 0
    const claimed = new Set<number>()
    const claim = (row: AccountRecord): number => {
      for (let i = 0; i < am.accounts.length; i++) {
        if (!claimed.has(i) && sameIdentity(am.accounts[i], row)) {
          claimed.add(i)
          return i
        }
      }
      return -1
    }
    for (const row of disk.accounts) {
      const i = claim(row)
      if (i < 0) {
        am.addAccount(row)
        claimed.add(am.accounts.length - 1)
        added += 1
        log(`picked up account "${row.name}"`)
        continue
      }
      const mgr = am.accounts[i]
      // An account that left and logged in again: the same place, back in service.
      removed.delete(mgr)
      if (row.orgUuid && !mgr.orgUuid) mgr.orgUuid = row.orgUuid
      if (row.orgName && !mgr.orgName) mgr.orgName = row.orgName
      if (row.name && mgr.name !== row.name) mgr.name = row.name
      if (row.priority != null && mgr.priority !== row.priority) mgr.priority = row.priority
      const wantDisabled = row.disabled === true
      if (mgr.disabled !== wantDisabled) am.setDisabled(mgr.index, wantDisabled)

      let fresh: { accessToken?: string; refreshToken?: string; expiresAt?: number; apiKey?: string } | null = null
      if (row.type === "oauth" && row.importFrom) {
        try {
          const c = await importCredentials(row.importFrom)
          fresh = { accessToken: c.accessToken, refreshToken: c.refreshToken, expiresAt: c.expiresAt }
        } catch (err) {
          log(`re-import failed for "${row.name}": ${(err as Error).message}`)
        }
      } else if (row.type === "oauth" && row.accessToken) {
        fresh = { accessToken: row.accessToken, refreshToken: row.refreshToken, expiresAt: row.expiresAt }
      } else if (row.type === "apikey" && row.apiKey) {
        fresh = { apiKey: row.apiKey }
      }
      if (!fresh) continue
      if (fresh.accessToken) {
        const changed = mgr.credential !== fresh.accessToken || mgr.refreshToken !== (fresh.refreshToken ?? null)
        const diskIsStaler = !!fresh.expiresAt && !!mgr.expiresAt && fresh.expiresAt < mgr.expiresAt
        if (changed && !diskIsStaler) {
          am.updateAccountTokens(mgr.index, {
            accessToken: fresh.accessToken,
            refreshToken: fresh.refreshToken,
            expiresAt: fresh.expiresAt,
          })
          log(`refreshed credentials for "${mgr.name}" from file`)
        }
      } else if (fresh.apiKey && mgr.credential !== fresh.apiKey) {
        mgr.credential = fresh.apiKey
        if (mgr.status === "error") mgr.status = "active"
      }
    }
    let gone = 0
    for (const mgr of am.accounts) {
      if (claimed.has(mgr.index) || removed.has(mgr)) continue
      am.setDisabled(mgr.index, true)
      removed.add(mgr)
      gone += 1
      log(`took out account "${mgr.name}"`)
    }
    // Move off a current account that is out of service now, where another can serve.
    if (!servesNow(am.accounts[am.currentIndex])) am.selectActiveAccount()
    stripOverage = stripsOverage(disk)
    return { added, removed: gone }
  }

  /**
   * A pin resolves over the accounts still in the file only. A taken-out one
   * keeps its place (and its name) disabled, and the engine serves a hard pin
   * whatever its state, so resolving onto it would send a logged-out token.
   * `resolveAccountPin` reads nothing but `.accounts`, so it gets that view.
   */
  const pinIndex = (name: string | null): number | null => {
    if (!name) return null
    const live = am.accounts.filter((a) => !removed.has(a))
    const i = resolveAccountPin({ accounts: live } as unknown as AccountManager, name)
    return i == null ? null : live[i].index
  }

  const serve: Engine["serve"] = async ({ req, res, url, body, reqId, sessionId, pin, upstream }) => {
    const pinnedIndex = pinIndex(pin.account)
    // A hard pin is one account, never a failover. To an account that is not
    // live (not in the file, taken out, or disabled) it is refused here, before
    // anything goes upstream; the engine would otherwise fall to the pool when
    // the name resolves to nothing, or serve a disabled account's token. A soft
    // pin to an unknown name is just a preference: the pool serves it.
    if (pin.mode === "pin" && (pinnedIndex == null || am.accounts[pinnedIndex].disabled)) {
      const message = `beacons: this profile is pinned to "${pin.account ?? ""}", which is not signed in to beacons; run \`beacons login\` or route the profile elsewhere`
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }))
      return { status: 400, account: null, error: "pinned account not live" }
    }
    // The engine reads req.headers straight through, so hand it a view with the
    // client's own credential already gone; the engine sets the account's.
    const headers: Record<string, string | string[] | undefined> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase()
      if (lk === "authorization" || lk === "x-api-key") continue
      headers[k] = v
    }
    const ctx: ForwardCtx = {
      tried: new Set(),
      reauthed: new Set(),
      model: parseRequestModel(body),
      advisorModel: parseAdvisorModel(body),
      sessionId,
      pinnedIndex,
      pinSoft: pin.mode === "pool",
      holdBudgetMs: holdMs,
    }
    if (stripOverage) stripOverageOnWriteHead(res)
    // `upstream` is this request's base; the engine joins it to `url` by string
    // concatenation, so a base with a path (an upstream proxy's) keeps it.
    await forwardRequest({ method: req.method, url, headers }, res, body, am, upstream, 0, {}, reqId, ctx, null, null, undefined)
    // What reached the client. No head sent: no status; the engine reset the
    // socket (a failure) or the client left first. `res.statusCode` alone
    // defaults to 200. A head sent but the reply never ended, with a failure:
    // the stream was cut. A client hanging up is not an error.
    const sent = res.headersSent
    const failure = ctx.failure ?? null
    return {
      status: sent ? (ctx.status ?? res.statusCode) : null,
      account: ctx.account ?? null,
      error: !sent ? (failure ? `upstream: ${failure}` : null) : !res.writableEnded && failure ? `upstream stream: ${failure}` : null,
    }
  }

  return {
    status: () => {
      const s = am.getStatus()
      // With nothing else available the engine leaves its cursor where it was,
      // so a removed or disabled account can still be "current": name none.
      const currentAccount = servesNow(am.accounts[am.currentIndex]) ? s.currentAccount : undefined
      return { ...s, currentAccount, accounts: shown(s.accounts) }
    },
    reload,
    serve,
    probe: async () => {
      await prober.probeAll()
      await persist()
      const p = prober.getStatus()
      return { ...p, accounts: shown(p.accounts) }
    },
    persist,
    stop: async () => {
      clearInterval(timer)
      prober.stop()
      // Token writes already queued land before we go: the next engine in this
      // process rebinds the accounts path, and a late write would follow it.
      await writes.catch(() => {})
      await persist()
    },
  }
}

/**
 * The engine writes the reply head itself, so the per-org billing headers
 * (isOverageHeader) come off on the way out, after the engine has read them
 * for quota.
 */
function stripOverageOnWriteHead(res: ServerResponse): void {
  const orig = res.writeHead.bind(res)
  res.writeHead = ((status: number, ...rest: unknown[]) => {
    const at = typeof rest[0] === "string" ? 1 : 0
    const headers = rest[at]
    if (headers && typeof headers === "object" && !Array.isArray(headers))
      rest[at] = Object.fromEntries(Object.entries(headers as Record<string, unknown>).filter(([k]) => !isOverageHeader(k)))
    return (orig as (...a: unknown[]) => ServerResponse)(status, ...rest)
  }) as typeof res.writeHead
}
