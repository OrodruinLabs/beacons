// SPDX-FileCopyrightText: 2026 Orodruin Labs
// SPDX-License-Identifier: MIT
//
// Who may knock at all. The gateway takes no key: being on this machine is the
// credential, and a web page in the owner's browser is on this machine too. So
// two more conditions hold every request to what a local client looks like:
//
//   cross-origin   a page's fetch carries Sec-Fetch-Site or Origin; curl, the CLI,
//                  Claude Code and Node's fetch send neither
//   rebinding      a page whose name flips to 127.0.0.1 is same-origin to its
//                  browser, but the Host it sends still names the page
import type { IncomingHttpHeaders } from "node:http"

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1"])
// A wildcard bind says nothing about the name that reached us.
const WILDCARD_BINDS = new Set(["0.0.0.0", "::", ""])

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)

/** A Host value's name: port and IPv6 brackets off, lowercased. Null when it cannot be one. */
function hostnameOf(host: string): string | null {
  const h = host.trim().toLowerCase()
  if (h.startsWith("[")) {
    const end = h.indexOf("]")
    return end < 0 ? null : h.slice(1, end)
  }
  // A bare IPv6 address has several colons and no port; `name:port` has one.
  const colon = h.indexOf(":")
  if (colon >= 0 && h.indexOf(":", colon + 1) >= 0) return h
  return colon >= 0 ? h.slice(0, colon) : h
}

/** Browser-set headers only: a same-origin or typed-in request is fine, anything else is a page. */
function isSameOrigin(headers: IncomingHttpHeaders): boolean {
  const site = first(headers["sec-fetch-site"])
  if (site) return site === "same-origin" || site === "none"
  return !first(headers.origin)
}

/** Whether Host names this machine. A missing Host passes: only HTTP/1.0 may omit it, and no browser speaks it. */
function isLocalHost(host: string | undefined, bindHost: string): boolean {
  if (host == null || host === "") return true
  const name = hostnameOf(host)
  if (name == null) return false
  if (LOCAL_HOSTNAMES.has(name)) return true
  const bound = hostnameOf(bindHost)
  return bound != null && !WILDCARD_BINDS.has(bound) && bound === name
}

/** Why this request is refused at the door, or null to let it in. */
export function browserRefusal(headers: IncomingHttpHeaders, bindHost: string): string | null {
  if (!isSameOrigin(headers)) return "cross-origin request refused: a web page cannot use the gateway"
  if (!isLocalHost(first(headers.host), bindHost)) return "request refused: the Host header does not name this gateway"
  return null
}
