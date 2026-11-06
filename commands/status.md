---
# SPDX-FileCopyrightText: 2026 Orodruin Labs
# SPDX-License-Identifier: MIT
description: "Show the beacons gateway, its accounts and its open sessions"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/bin/beacons status:*)"]
---

Run `"${CLAUDE_PLUGIN_ROOT}/bin/beacons" status` with the Bash tool. Run nothing else.

It exits 1 when the gateway does not answer, and still prints its report. Show the user the report as it is. Then add at most two short lines, and only for something that needs them:

- The gateway does not answer: the next session start restarts it. In the meantime, `! beacons off` in this session or `beacons off` in a terminal takes every profile off beacons. Neither needs a model.
- No account is signed in, or no profile is routed: run `/beacons:setup`.
