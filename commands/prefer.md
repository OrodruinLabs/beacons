---
# SPDX-FileCopyrightText: 2026 Orodruin Labs
# SPDX-License-Identifier: MIT
description: "Pool a profile across your accounts, starting with the one you name"
argument-hint: "<account> [profile]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/bin/beacons route:*)", "Bash(${CLAUDE_PLUGIN_ROOT}/bin/beacons status:*)"]
---

Route a profile through beacons in pool mode: any signed-in account can serve it, starting with the account named here. When that account hits a limit or fails, the request in flight moves to the next account, and the session keeps its history.

The user's arguments: $ARGUMENTS

- The first argument is the account.
- The second, if given, is the profile folder. Without one, use the profile this session runs in, written exactly as `"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"` so the shell fills it in.
- With no account, run `"${CLAUDE_PLUGIN_ROOT}/bin/beacons" status`, show the user the accounts it lists, and ask which one. Then go on.

Run this with the Bash tool. Put the account, and a profile the user named, in single quotes:

```
"${CLAUDE_PLUGIN_ROOT}/bin/beacons" route <profile> 'pool:<account>'
```

Then tell the user what it printed:

- **It worked:** the profile's requests now go through beacons. Sessions already running in that profile move over within seconds. Say once that a pooled profile can run on any of the accounts, under that account's plan and data settings.
- **No such account:** it lists the known ones. Ask which one, and run it again.
- **The profile is routed to another gateway:** it was left alone. Say where it points. Only if the user then says to replace it, run the same command with `--replace` at the end. `beacons off` puts the other route back later.
- **Anything else:** show the message as it is.
