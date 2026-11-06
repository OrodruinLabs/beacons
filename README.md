<!--
SPDX-FileCopyrightText: 2026 Orodruin Labs
SPDX-License-Identifier: MIT
-->

<p align="center">
  <img src="assets/banner.png" alt="beacons — one local gateway for all your Claude accounts" width="100%" />
</p>

<h1 align="center">beacons</h1>

<p align="center"><em>Pool your Claude subscription accounts behind one local gateway.</em></p>

<p align="center">
  <a href="https://github.com/OrodruinLabs/beacons/actions/workflows/ci.yml"><img src="https://github.com/OrodruinLabs/beacons/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/Claude_Code-plugin-7c3aed" alt="Claude Code plugin" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey" alt="macOS | Linux" />
</p>

---

You sign each of your own Claude subscription accounts in to beacons once, and rank them. Then each Claude Code profile is routed through a gateway on `127.0.0.1:4774`, in one of two modes:

- **pool**: any of your accounts can serve the profile, starting with a first choice. When the serving account hits a usage limit or fails, beacons retries the request in flight on the next account in your order, so the session keeps its history.
- **pin**: one account serves the profile, and its requests never move to another account.

beacons runs on your machine only. In each routed profile's `settings.json` it writes one key, `ANTHROPIC_BASE_URL`, plus a status line where the profile has none. It keeps the account tokens in one file only you can read, and never writes a request body to disk. Its pooling engine comes from [teamclaude](https://github.com/KarpelesLab/teamclaude) (MIT); credits are in [NOTICE](NOTICE).

> [!WARNING]
> Any account you add to beacons can be suspended without notice. Read [Terms and account risk](#terms-and-account-risk) before you use it.

## Install

```
/plugin marketplace add OrodruinLabs/beacons
/plugin install beacons@beacons
```

Then run `/beacons:setup` in Claude Code. It asks its questions in the conversation, shows you the plan, and changes nothing until you say yes. [Getting started](docs/getting-started.md) says what it does, step by step.

## Commands

| In Claude Code | What it does |
|---|---|
| `/beacons:setup` | Set up, or change the setup. |
| `/beacons:status` | Show the gateway, the accounts with their use, and the open sessions. |
| `/beacons:prefer <account> [profile]` | Pool a profile, starting with `<account>`. |
| `/beacons:pin <account> [profile]` | Pin a profile to `<account>`. |
| `/beacons:off [profile...] \| all` | Put profiles back as they were before beacons. |
| `/beacons:uninstall [--purge]` | Undo setup. |

Each has a terminal form, and a few commands run only in a terminal: see [Using beacons](docs/usage.md). If something goes wrong, `beacons off` in a terminal, or `! beacons off` in a session, takes every profile off beacons. It needs no model.

## Terms and account risk

Claude Code's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) says "developers may not collect, store, or intermediate Claude.ai credentials or session tokens". beacons signs each of your accounts in, keeps its tokens on your machine, and puts them on your requests.

The same page lets you sign in to Claude Code with your own subscription. It also says the usage limits "assume ordinary, individual usage".

- Any account you add to beacons can be suspended without notice.
- Anthropic has suspended accounts without notice before.
- Use beacons only if you accept it.
- None of this is legal advice.

beacons is for single-user machines, and a pooled request runs under the plan and data settings of the account that serves it. [Limits](docs/limits.md) has these and what never goes through beacons.

## Documentation

| Guide | Description |
|---|---|
| [Getting started](docs/getting-started.md) | Install, what setup does, the settings backup, platforms |
| [Using beacons](docs/usage.md) | Every command, updates, recovery, uninstall |
| [Works with](docs/integrations.md) | The Claude Code status line, an upstream proxy |
| [Limits](docs/limits.md) | Single-user machines, serving-account settings, what stays direct, calls that bypass the gateway |
| [Contributing](docs/contributing.md) | Requests we decline, branches and releases, the checks |
| [Engine patches](docs/engine-patches.md) | beacons' changes to the vendored teamclaude engine |

## License

MIT. See [LICENSE](LICENSE). The engine in `src/engine/` is teamclaude's, under [its MIT license](src/engine/LICENSE); the notice for the code adapted from cc-gateway is in [NOTICE](NOTICE).

---

Built by [Orodruin Labs](https://github.com/OrodruinLabs).
