# Getting started

## Install

```
/plugin marketplace add OrodruinLabs/beacons
/plugin install beacons@beacons
```

Then run `/beacons:setup` in Claude Code. It asks its questions in the conversation, shows you the plan, and changes nothing until you say yes.

## What setup does

1. Fetches beacons' own copy of Node. This is the official build, a download of about 60 MB, checked against a SHA-256 kept in this repo. beacons never uses your system Node.
2. Has you sign in to each account with `beacons login`, which opens Anthropic's own sign-in page in your browser. Setup gives you the exact command. Sign-ins run in your terminal, or in a Claude Code session as a `!` shell line.
3. Asks the order of your accounts, and each profile's mode.
4. Sends traffic on through a local upstream proxy only when you name one with `--upstream`, or say yes when setup asks about one your profiles already route to; the answer defaults to no (see [An upstream proxy](integrations.md#an-upstream-proxy)).
5. Installs and starts a user service (launchd on macOS, `systemd --user` on Linux).
6. Routes the profiles, and installs this plugin in each one.
7. Adds a status line where a profile has none, and ends with the status: each account's use, read at no cost, and each profile's route. It sends no request of its own (see [Only Claude Code's own requests](limits.md#only-claude-codes-own-requests)).

Setup links `beacons` into `~/.local/bin`, and prints the PATH line to add when that folder is not on your PATH. Another program's `beacons` already there is left alone.

## The settings backup

The first time beacons changes a profile's `settings.json`, it keeps a copy of the file as it was, `settings.json.beacons.bak`, beside it (beside the link, when `settings.json` is a link). That copy is made once and never replaced, and uninstall leaves it where it is.

## Platforms

macOS and Linux. On Linux, setup tells you when lingering is off (`loginctl enable-linger`), because systemd then stops beacons when you log out. It leaves that setting to you. WSL is best effort and needs `systemd=true`. Windows is not supported yet.

Next: [Using beacons](usage.md).
