# Works with

beacons reports through other tools' documented interfaces, and writes only its own files.

## The Claude Code status line

Setup adds a status line that runs `~/.local/bin/beacons status --line` (the installed release's own `beacons`, when another program's `beacons` holds that name), but only to a profile that has none. A profile with its own status line keeps it; setup prints the command to add to it.

| Token | Meaning |
|---|---|
| `◔ beacons <account>` | served by its first choice, or by its pinned account |
| `◑ beacons <account>` | failed over to another account |
| `◕ beacons down` | the profile is routed, but the gateway does not answer |
| `◔ beacons direct` | the profile is not routed |
| `◕ beacons proxy down` | the upstream proxy does not answer, and beacons waits for it |
| `◑ beacons proxy down → direct` | the upstream proxy does not answer, and beacons goes direct |

The status line's `rate_limits` follow the account that served the session's last response, which is the account the token names.

## An upstream proxy

beacons can send its traffic on through another local proxy, one that listens on this machine.

- **The order** is Claude Code → beacons → the proxy → Anthropic.
- **The URL** must be a loopback `http:` URL, on `127.0.0.1` or `localhost`. The chain is on only through one of these:
  1. `beacons setup --upstream '<url>'`. `--upstream off` turns the chain off.
  2. `upstreamUrl` in beacons' own `gateway.json`, when it already is such a URL, so a re-run keeps it.

  Profiles routed to that URL, or to a path under it, are beacons' to take: it takes the proxy's place in them, and `beacons off` puts it back. Setup writes the URL into `gateway.json`, and never edits the proxy's files.
- **Your profiles.** When the profiles routed to a loopback URL all use one and the same URL, and it is neither beacons' own nor a gateway you replaced with `--replace`, setup suggests it and asks: the wizard before the profile list, and `/beacons:setup` with its other questions. The answer defaults to no, since that URL may be another gateway rather than a proxy. Only a yes (`--upstream '<url>'`) turns the chain on. Setup never turns it on by itself, so a plain `--yes` leaves it off, and those profiles alone. Profiles routed to several different loopback URLs suggest nothing.
- **Answering.** The proxy answers when a connection to its host and port opens within a second. beacons checks every few seconds, and at once when a request cannot connect. Setup does not turn the chain on through a new URL while the proxy does not answer. A chain `gateway.json` already has is kept with a warning, and the fallback below covers the gap.
- **Tokens.** With the chain on, the proxy sees each pooled account's token.
- **When the proxy stops answering**, beacons follows `chainFallback` in `gateway.json`, which setup asks about:
  - `wait` (the default): requests get an error that names the proxy, Claude Code retries, and the status line shows `proxy down`.
  - `direct`: requests go straight to Anthropic until the proxy is back, and the status line shows `proxy down → direct`.
- **Hint labels.** Claude Code sends its hint labels through a custom base URL only when `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` is set, and beacons does not set it. If your proxy reads them, add that key to the profile's `env` yourself.
- **Turning it off.** `beacons off` and `beacons uninstall` put the proxy's route back in a profile only while the proxy answers. Otherwise the profile goes direct, and they say the proxy is not answering.
