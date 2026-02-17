# oc-codex-multi-account

[![npm version](https://img.shields.io/npm/v/oc-codex-multi-account)](https://www.npmjs.com/package/oc-codex-multi-account)

Multi-account OAuth rotation for OpenAI Codex with sticky threshold switching.

> **Based on [opencode-openai-codex-auth](https://github.com/numman-ali/opencode-openai-codex-auth) by [@nummanali](https://x.com/nummanali)**. Forked and modified to add multi-account rotation support.

## Patched Build (Codex Backend Compatible)

This fork patches the plugin to talk to **ChatGPT Codex backend** (`chatgpt.com/backend-api`) with the same headers and request shape as the official Codex OAuth plugin.

**Install from npm (recommended):**

```bash
bun add oc-codex-multi-account --cwd ~/.config/opencode
```

Then set the plugin entry in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["oc-codex-multi-account@latest"]
}
```

If you already installed an older build, re-run the GitHub install command above to override it.

## Installation

### Via npm (Recommended)

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["oc-codex-multi-account@latest"]
}
```

OpenCode will auto-install on first run.

### Manual Install

If auto-install fails, install manually:

```bash
bun add oc-codex-multi-account --cwd ~/.config/opencode
```

### From Source

```bash
git clone https://github.com/gaboe/oc-codex-multi-account.git
cd oc-codex-multi-account
bun install
bun run build
bun link
```

## Add Your Accounts

```bash
# Add each account (opens browser for OAuth)
opencode-multi-auth add personal
opencode-multi-auth add work  
opencode-multi-auth add backup

# Each command opens your browser - log in with a different ChatGPT account each time
```

## Verify Setup

```bash
opencode-multi-auth status
```

Output:
```
[multi-auth] Account Status

Strategy: round-robin
Accounts: 3
Active: personal

  personal (active)
    Email: you@personal.com
    Uses: 12
    Token expires: 12/25/2025, 3:00:00 PM

  work
    Email: you@work.com
    Uses: 10
    Token expires: 12/25/2025, 3:00:00 PM

  backup
    Email: you@backup.com
    Uses: 8
    Token expires: 12/25/2025, 3:00:00 PM
```

## Web Dashboard (Local Only)

Launch the local dashboard:

```bash
opencode-multi-auth web --port 3434 --host 127.0.0.1
```

Or from the repo:

```bash
npm run web
```

Open `http://127.0.0.1:3434` to manage Codex CLI tokens from `~/.codex/auth.json`:
- Sync current auth.json token into your local list
- See which token is active on the device
- Switch auth.json to a stored token
- Refresh OAuth tokens (per-token or all)
- Refresh 5-hour and weekly limits manually (probe-run per alias)
- Search/filter by alias/email/tags/notes
- Sort by remaining limits, expiry, or alias; recommended token badge
- Tag and annotate tokens (notes)
- Queue-based refresh with progress + stop
- Limit history sparklines and trend rate
- Built-in log view

The dashboard watches `~/.codex/auth.json` and will add new tokens as you log in via Codex CLI.

Limit refresh runs `codex exec` in a per-alias sandbox (`~/.codex-multi/<alias>`) so you can
update limits for any stored token without switching the active device token.

### Optional Store Encryption

Set `CODEX_SOFT_STORE_PASSPHRASE` to encrypt `~/.config/opencode-multi-auth/accounts.json` at rest:

```bash
export CODEX_SOFT_STORE_PASSPHRASE="your-passphrase"
```

If the store is encrypted and the passphrase is missing, the UI will show a locked status and refuse to overwrite.

### Systemd Autostart (user service)

Install and enable the user service:

```bash
opencode-multi-auth service install --port 3434 --host 127.0.0.1
```

Check status or disable:

```bash
opencode-multi-auth service status
opencode-multi-auth service disable
```

### Logs

The dashboard writes logs to `~/.config/opencode-multi-auth/logs/codex-soft.log` by default.
Override with `CODEX_SOFT_LOG_PATH` if you want a custom path.

## Configure OpenCode

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["oc-codex-multi-account@latest"]
}
```

Or with other plugins:

```json
{
  "plugin": [
    "oh-my-opencode",
    "oc-codex-multi-account@latest"
  ]
}
```


## Background Notifications (macOS)


### iPhone notifications via ntfy (click to open session)

If you want push notifications on iOS (with a clickable link to the OpenCode web session), use `ntfy`.

1) Install the **ntfy** app on iPhone and subscribe to a topic.

2) Set these env vars on the Mac where OpenCode runs:

- `OPENCODE_MULTI_AUTH_NOTIFY_NTFY_URL`
  Example: `https://ntfy.sh/<your-topic>` (or your self-hosted ntfy URL)
- `OPENCODE_MULTI_AUTH_NOTIFY_UI_BASE_URL`
  Base URL of your OpenCode web UI reachable from iPhone.
  Example (Tailscale): `http://100.x.y.z:4096`
- Optional: `OPENCODE_MULTI_AUTH_NOTIFY_NTFY_TOKEN` (Bearer token)

The plugin sends notifications for:

- `session.idle` (finished): priority `3`
- `session.status` with `retry`: priority `4`
- `session.error`: priority `5`

When possible, the notification body includes `Project` + session `Title`, plus the `sessionID`.
It also attaches a `Click:` URL like `<base>/session/<sessionID>` so tapping the push opens the session.

This plugin can send a **macOS notification + sound** when a session finishes work.
It listens for OpenCode events (`session.status` and `session.idle`).

Defaults:
- Enabled by default
- Sound: `/System/Library/Sounds/Glass.aiff`

Environment variables:
- `OPENCODE_MULTI_AUTH_NOTIFY=0` disables notifications
- `OPENCODE_MULTI_AUTH_NOTIFY_SOUND=/path/to/sound.aiff` overrides the sound
- `OPENCODE_MULTI_AUTH_NOTIFY_MAC_OPEN=0` disables click-to-open on macOS (when available)

Clickable macOS notifications require `terminal-notifier` (optional). If installed, clicking the banner opens the session URL.

If OpenCode seems to only make progress when the window is focused, macOS may be throttling it.
Try disabling App Nap for OpenCode.app (Finder -> Get Info -> Prevent App Nap),
or run the server from a terminal under `caffeinate`.

## Codex Latest Model Mapping

OpenCode may not list the newest Codex model yet (it keeps an internal allowlist).
This plugin can still use the newest model by **mapping** the selected Codex model
to the latest backend model on ChatGPT.

Default behavior:
- If you select `openai/gpt-5.2-codex` (or `openai/gpt-5-codex`), the plugin will send requests as `gpt-5.3-codex`.

Environment variables:
- `OPENCODE_MULTI_AUTH_PREFER_CODEX_LATEST=0` disables the mapping (use exact model).
- `OPENCODE_MULTI_AUTH_CODEX_LATEST_MODEL=gpt-5.3-codex` overrides the target model.
- `OPENCODE_MULTI_AUTH_DEBUG=1` prints mapping logs like: `model map: gpt-5.2-codex -> gpt-5.3-codex`.

## Troubleshooting

### BunInstallFailedError (DependencyLoop)

If OpenCode fails to boot with:

```
BunInstallFailedError
{ "pkg": "oc-codex-multi-account", "version": "latest" }
```

It usually means an older `@a3fckx/opencode-multi-auth` dependency is still present.

Fix:

1) Remove the old dependency from `~/.config/opencode/package.json`:

```json
{
  "dependencies": {
    "@a3fckx/opencode-multi-auth": "^1.0.4"
  }
}
```

2) Reinstall:

```bash
bun add oc-codex-multi-account --cwd ~/.config/opencode
```

Optional fallback: use a file path plugin entry if installs are blocked:

```json
{
  "plugin": [
    "file:///Users/<you>/.config/opencode/node_modules/oc-codex-multi-account/dist/index.js"
  ]
}
```

## How It Works

| Feature | Behavior |
|---------|----------|
| **Rotation** | Round-robin across all accounts per API call |
| **Rate Limits** | Auto-skips rate-limited account for 5 min, uses next |
| **Token Refresh** | Auto-refreshes tokens before expiry |
| **Models** | Auto-discovers GPT-5.x models from OpenAI API |
| **Storage** | `~/.config/opencode-multi-auth/accounts.json` |

## CLI Commands

| Command | Description |
|---------|-------------|
| `add <alias>` | Add new account via OAuth (opens browser) |
| `remove <alias>` | Remove an account |
| `list` | List all configured accounts |
| `status` | Detailed status with usage counts |
| `path` | Show config file location |
| `web` | Launch local Codex auth.json dashboard |
| `service` | Install/disable systemd user service |
| `help` | Show help message |

## Requirements

- ChatGPT Plus/Pro subscription(s)
- OpenCode CLI

## Credits

- Original OAuth implementation: [numman-ali/opencode-openai-codex-auth](https://github.com/numman-ali/opencode-openai-codex-auth)
- Multi-account rotation: [@a3fckx](https://github.com/a3fckx)

## License

MIT
