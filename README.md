# oc-codex-multi-account

[![npm version](https://img.shields.io/npm/v/oc-codex-multi-account)](https://www.npmjs.com/package/oc-codex-multi-account)

OpenCode plugin for Codex multi-account routing with sticky primary selection and threshold-based fallback.

## Installation

### 1) Add plugin to OpenCode config

Add this to your `~/.config/opencode/opencode.json` (or project-level `opencode.json`):

```json
{
  "plugin": [
    "oc-codex-multi-account@latest"
  ]
}
```

OpenCode installs the package automatically on startup.

### 2) (Optional) Install locally for CLI usage

If you want to manage accounts via terminal commands:

```bash
bun add oc-codex-multi-account --cwd ~/.config/opencode
```

Then use:

```bash
~/.config/opencode/node_modules/.bin/oc-codex-multi-account --help
```

If global bin is available in your PATH, you can use:

```bash
oc-codex-multi-account --help
```

## Add Accounts

```bash
oc-codex-multi-account add primary
oc-codex-multi-account add fallback1
oc-codex-multi-account add fallback2
```

The first account is treated as primary. Additional accounts are fallbacks.

## How Switching Works

- Primary-first (sticky): requests stay on primary while under thresholds.
- Fallback on pressure: switches when primary exceeds configured utilization.
- Recovery checks: while on fallback, periodically checks if primary recovered and switches back.
- Safety skips: temporarily skips accounts that are rate-limited or have auth/model/workspace issues.

## Storage

Credentials and runtime state are stored in:

- `~/.config/oc-codex-multi-account/accounts.json`

Migration is automatic from legacy path:

- `~/.config/opencode-multi-auth/accounts.json`

## CLI Commands

```bash
oc-codex-multi-account add <alias>       # OAuth login flow
oc-codex-multi-account remove <alias>    # remove account
oc-codex-multi-account list              # list accounts
oc-codex-multi-account status            # detailed status
oc-codex-multi-account config            # show current strategy/thresholds
oc-codex-multi-account config --threshold 0.8
oc-codex-multi-account config --thresholds 0.75,0.85
oc-codex-multi-account config --threshold-5h 0.8 --threshold-weekly 0.9
oc-codex-multi-account config --interval 30
oc-codex-multi-account config --strategy sticky-threshold
oc-codex-multi-account config --reset
oc-codex-multi-account path              # print store file path
oc-codex-multi-account web --port 3434 --host 127.0.0.1
oc-codex-multi-account service install --port 3434 --host 127.0.0.1
```

`--interval` is in minutes. Threshold values accept either 0-1 or percentages (for example `0.8` or `80`).

## Release Flow

This repository is configured for tag-based publishing via GitHub Actions.

- Create and push a tag like `v1.0.1`
- Workflow publishes to npm and creates GitHub Release

```bash
git tag v1.0.1
git push origin v1.0.1
```

## Repository

- GitHub: `https://github.com/gaboe/oc-codex-multi-account`
- npm: `https://www.npmjs.com/package/oc-codex-multi-account`

## License

MIT
