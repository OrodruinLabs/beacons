---
# SPDX-FileCopyrightText: 2026 Orodruin Labs
# SPDX-License-Identifier: MIT
description: "Undo beacons setup on this machine"
argument-hint: "[--purge]"
disable-model-invocation: true
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/bin/beacons uninstall:*)"]
---

Uninstall beacons from this machine. Change nothing until the user says yes.

The user's arguments: $ARGUMENTS

First tell the user what uninstall does:

1. Removes the route beacons wrote into each profile, and puts back any route it replaced.
2. Removes the status line, but only where it still holds the line beacons wrote.
3. Lists the sessions that were open on beacons. They need a restart.
4. Removes the beacons service, and its data folder: its releases, its Node and its quota memory.
5. Removes the `beacons` launcher, and this plugin from each profile setup put it in.
6. Keeps the config folder, with the signed-in accounts. With `--purge`, it deletes that too, and using those accounts with beacons again means signing in again.

Use `--purge` only when the arguments include it, or when the user asks to remove the accounts. Ask for a clear yes, naming `--purge` in the question when it is used.

On a yes, run this with the Bash tool and the longest timeout it allows, adding `--purge` when it was agreed:

```
"${CLAUDE_PLUGIN_ROOT}/bin/beacons" uninstall
```

Show the user what it printed, notes included. Tell them to restart the sessions it lists, and that this session keeps running on its current settings until it restarts.
