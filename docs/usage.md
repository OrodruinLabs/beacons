# Using beacons

## Commands

| In Claude Code | In a terminal | What it does |
|---|---|---|
| `/beacons:setup` | `beacons setup` | Set up, or change the setup. |
| `/beacons:status` | `beacons status` | Show the gateway, the accounts with their use, and the open sessions. |
| `/beacons:prefer <account> [profile]` | `beacons route <profile> pool:<account>` | Pool a profile, starting with `<account>`. |
| `/beacons:pin <account> [profile]` | `beacons route <profile> pin:<account>` | Pin a profile to `<account>`. |
| `/beacons:off [profile...] \| all` | `beacons off [profile...]` | Put profiles back as they were before beacons. The service keeps running. |
| `/beacons:uninstall [--purge]` | `beacons uninstall [--purge]` | Undo setup. |

`/beacons:prefer`, `/beacons:pin` and `/beacons:off` act on the current session's profile when you name none. `/beacons:off all`, and `beacons off` with no profile, act on every routed profile.

Only in a terminal:

- `beacons login [--name <name>]` signs in one more account. By default it is named by its email.
- `beacons logout <account>` removes one account.
- `beacons order <account> <account>...` sets the order, first choice first.
- `beacons on [profile...]` routes the profiles `off` took out again.
- `beacons upgrade [--now]` and `beacons rollback` move between builds.

## Updates

beacons updates only when you update the plugin. At the next session start, it moves to the new version in the background. It waits for a moment when no reply is open, for at most 30 minutes, then restarts in a second or two. Claude Code retries any request refused in that gap. `beacons upgrade --now` skips the wait, and `beacons rollback` steps back one build.

## When something goes wrong

- **The service has stopped.** The next session start restarts it.
- **A new build keeps crashing.** Three starts within a minute switch back to the previous build.
- **Nothing else works.** Run `beacons off` in a terminal, or `! beacons off` inside a session; it needs no model. It takes the route out of every profile and leaves the service running.
- **Direct for one session.** Start it with a one-off `claude --settings` override of `ANTHROPIC_BASE_URL`.
- After `off`, a session whose route was removed stays on beacons until it restarts. A session whose earlier route came back (for example an upstream proxy's) moves within seconds.

## Uninstall

Run `beacons uninstall` (or `/beacons:uninstall`). It:

1. removes the route beacons wrote into each profile, and puts back any route it replaced;
2. removes the status line, but only where it still holds the line beacons wrote;
3. lists the sessions that were open on beacons, to restart;
4. removes the service and beacons' data folder;
5. removes the launcher, and the plugin from each profile setup put it in;
6. keeps your accounts. `--purge` deletes them too.

Uninstalling only the plugin leaves the routes and the service in place, so run `beacons uninstall` first.

When you stop using an account, for example at the end of a job, remove its stored sign-in from each machine with `beacons logout <account>` (or `beacons uninstall --purge`), or revoke the sign-in from the account's side.
