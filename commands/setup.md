---
# SPDX-FileCopyrightText: 2026 Orodruin Labs
# SPDX-License-Identifier: MIT
description: "Set beacons up: accounts, their order, and how each profile is routed"
disable-model-invocation: true
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/bin/beacons setup:*)"]
---

Set beacons up for the user. Nothing on the machine changes until step 5, and step 5 waits for the user's yes.

The CLI is `"${CLAUDE_PLUGIN_ROOT}/bin/beacons"`. Run it with the Bash tool, never interactively, and give each run the longest timeout the tool allows: the first run fetches beacons' own Node (about 60 MB), and `--yes` installs a service. Put each flag value in single quotes.

The user's notes, if any: $ARGUMENTS

## 1. Read the machine

Run `"${CLAUDE_PLUGIN_ROOT}/bin/beacons" setup --plan`. It changes nothing. It prints JSON `{plan, found, problems}`; it exits 0 when `problems` is empty, and 2 when it is not. On any other output, show it to the user and stop.

- `found.accounts`: the accounts already signed in, first choice first.
- `found.profiles`: every profile setup could route. `plan.profiles` is the ones it proposes.
- `found.elsewhere`: profiles routed to another gateway. They are left alone unless the user asks to replace them.
- `found.unreadable`: profiles whose `settings.json` cannot be read. They are left alone; say why.
- `found.proxy`: a local upstream proxy, as `{url, answers, source}`, or null when there is none. `answers` is false when nothing takes a connection there.
  - `source` `"gateway"`: gateway.json already sends on through it, and the plan keeps that (`plan.chain.url`). The profiles routed to it are in `plan.profiles`.
  - `source` `"profiles"`: the one loopback URL the profiles are routed to. This is only a suggestion. It may be another gateway rather than a proxy, so `plan.chain.url` stays null and those profiles stay in `found.elsewhere` until the user says yes.
  - `source` `"upstream"`: a URL `--upstream` named.
- `found.port` and `found.portHolder`: the port beacons uses, and the process holding it, if there is one.
- `found.beaconsHung`: beacons itself holds the port but is not answering. Setup restarts it; tell the user it will.

## 2. Sign-ins

When `found.accounts` is empty, or the user wants to add accounts, they sign in themselves. Each sign-in opens a browser and waits for it, so it cannot run here. Give them the command to run once per account, in a terminal:

```
"${CLAUDE_PLUGIN_ROOT}/bin/beacons" login
```

or in this session, as a shell line:

```
! "${CLAUDE_PLUGIN_ROOT}/bin/beacons" login
```

- `--name <name>` names the account. By default its name is its email.
- If a sign-in prints `updated` instead of `added`, the browser signed in an account that was already there. Sign the browser out of claude.ai, then run it again.

Wait until they say they are done, then run step 1 again.

## 3. Ask

**The upstream proxy first**, only when `found.proxy` is not null, as a message of its own:

- Ask "Send traffic on through the local proxy at `<found.proxy.url>`? It will see every pooled account's token. (yes/no)". When `found.proxy.answers` is false, add that it does not answer now.
- The default is no. It is yes only when `source` is `"gateway"`, since that keeps the chain the user already has.
- If yes, also ask: when the proxy stops answering, wait for it or go direct to Anthropic?
  - Wait is the default. Requests get an error naming the proxy, and Claude Code retries until it is back.
  - Direct keeps requests working, without the proxy, until it is back.
- Then run step 1 again with the answer, and keep that flag for steps 4 and 5:
  - a yes is `--upstream '<found.proxy.url>'`, which puts the proxy's profiles in the plan;
  - a no to a `"gateway"` proxy is `--upstream off`;
  - a no to a `"profiles"` suggestion needs no flag.
- With no `found.proxy`, do not ask. The user can name a proxy with `--upstream`.

Then ask everything else in one message, with the plan's proposal as the default, so a single "yes" accepts it.

- **Profiles:** which of `found.profiles` to route. Name any in `found.elsewhere`, with their current URL; route one only if the user says so (`--replace`). `beacons off` puts the old URL back.
- **Order:** with more than one account, the order to try them in, first choice first.
- **Each profile's mode:**
  - **pool:** any account can serve it, starting with a first choice. When that account hits a limit or fails, the request in flight moves to the next one, and the session keeps its history.
  - **pin:** one account only. It never moves, so the profile's requests fail while that account is at its limit.
  - Say this plainly: a pooled profile can run on any of these accounts, under that account's plan and data settings.

## 4. Show the plan

Build the flags from the answers, and leave out any that keep the proposal:

- `--profiles '<profile>,<profile>'`
- `--order '<account>,<account>'`
- `--mode '<profile>=pool:<account>'` or `--mode '<profile>=pin:<account>'`, once for each profile
- the proxy's answer: `--upstream '<url>'` to send on through a local proxy (a loopback `http:` URL), or `--upstream off` to send straight to Anthropic; and `--chain-fallback wait` or `--chain-fallback direct`
- `--replace '<profile>'`, once for each profile the user chose to replace

Run `"${CLAUDE_PLUGIN_ROOT}/bin/beacons" setup <flags> --plan`. Tell the user, in plain words and not as JSON:

- the order of the accounts;
- each profile and its mode, and any route it replaces;
- whether traffic goes on through the upstream proxy (`plan.chain.url`), and what happens when the proxy stops answering. If that proxy does not answer now (a kept chain), say so;
- that beacons runs as a service on `127.0.0.1:<port>`, installs this plugin in each routed profile, and sends one small real request through a routed profile to check it;
- each entry in `problems`, in plain words, with what would fix it.

If there are problems, sort them out with the user and go back to the top of this step.

## 5. Apply

Ask for a clear yes. Without one, change nothing.

On a yes, run `"${CLAUDE_PLUGIN_ROOT}/bin/beacons" setup <the same flags> --yes`. Then tell the user what it printed that needs them:

- a status line to add, where a profile keeps its own;
- the line that puts `~/.local/bin` on their PATH;
- the test request's result and the status.

New sessions in the routed profiles go through beacons. Running sessions in a profile whose route changed move over within seconds.
