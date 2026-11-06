---
# SPDX-FileCopyrightText: 2026 Orodruin Labs
# SPDX-License-Identifier: MIT
description: "Put profiles back as they were before beacons; the gateway keeps running"
argument-hint: "[profile...] | all"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/bin/beacons off:*)"]
---

Take profiles off beacons. Each goes back to the route it had before beacons, or direct to Anthropic on its own login. The gateway keeps running, and the accounts stay signed in.

The user's arguments: $ARGUMENTS

Run one of these with the Bash tool:

- **No arguments:** this session's profile only.

  ```
  "${CLAUDE_PLUGIN_ROOT}/bin/beacons" off "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  ```

- **`all`:** every profile routed through beacons.

  ```
  "${CLAUDE_PLUGIN_ROOT}/bin/beacons" off
  ```

- **Profile folders:** those profiles, each in single quotes.

  ```
  "${CLAUDE_PLUGIN_ROOT}/bin/beacons" off '<profile>' '<profile>'
  ```

Then show the user what it printed: where each profile goes now, and any profile it could not change, with why. Tell them:

- A session whose route came out stays on beacons until it restarts. One whose earlier route came back moves within seconds.
- `beacons on` routes these profiles again, as they were.
