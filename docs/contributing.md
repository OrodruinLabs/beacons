# Contributing

## Requests we decline

beacons is for one person's own accounts on one machine. Requests for sharing modes, team setups or remote access are declined. So is anything meant to hide pooling from Anthropic. Bug reports and questions are welcome.

## Branches and releases

Work happens on `dev`. `main` holds released code only, and it is what the plugin marketplace installs. It moves only by a fast-forward to a `v*` tag that has been released.

A release:

1. Set the new version in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, on `dev`.
2. Tag that commit `v<version>` and push the tag. Only admins can create `v*` tags.
3. `release.yml` checks the tag against `plugin.json` and against `main`, runs the checks, and publishes the GitHub release.
4. It then prints the push that fast-forwards `main` to the tag. Only admins can move `main`, so an admin runs it.

## The checks

`ci.yml` runs on every push and pull request, on macOS and Ubuntu. Before you push, run:

```
npm ci
npm run typecheck
npm test
```

CI also runs `shellcheck` on the shell scripts, `claude plugin validate .`, and `reuse lint`. `LICENSES/MIT.txt` holds the MIT text for the REUSE tooling.
