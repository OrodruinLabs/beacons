# Limits

## Single-user machines only

The gateway listens on `127.0.0.1` and refuses requests from web pages. Even so, any process on the machine can reach that port and spend your accounts, whichever user runs it. Use beacons only on a machine no one else uses.

## A pooled profile runs under the serving account's settings

A pooled profile can be served by any of your accounts. Each request runs under the plan and the data settings of the account that serves it, not those of the profile's own login.

If some work must stay under one account's settings, pin that profile to that account.

## What stays direct

These never go through beacons:

- **The Claude desktop app.** It reads its own inference settings, not `ANTHROPIC_BASE_URL` or `settings.json`.
- **Cloud sessions.** They run on Anthropic's machines, not yours.
- **Profiles you have not routed.** They use their own login, as before.

A routed profile also loses Remote Control.

## Calls that bypass the gateway

`ANTHROPIC_BASE_URL` covers Claude Code's model calls. Some other calls never reach beacons:

- Claude Code's start-up calls and some of its telemetry go straight to Anthropic, with the profile's own login.

Some calls do reach beacons but are not pooled:

- The profile's own token refresh, its file uploads and a few other account calls go through unchanged, with the profile's own credential.
- Claude Code's event logging sent to the gateway is answered by beacons and never forwarded.

beacons itself talks only to `api.anthropic.com`, `platform.claude.com` and loopback.
