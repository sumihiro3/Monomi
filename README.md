# Monomi

[日本語版 README はこちら](./README.ja.md)

A CLI dashboard for running Claude Code across multiple devices and projects in parallel, giving you a cross-project overview of each project's status (working / waiting for permission / waiting for next instruction / waiting for PR review / idle).

Pair a hub running on a Mac mini with children on MacBooks and other machines, and the child-side session status is also shown in the hub's `monomi` dashboard (falls back to Tailscale automatically when the LAN is unreachable; see `docs/releases/release-3-multi-device-pairing/requirements.md` for details).

## Requirements

- Verified environment: macOS only
- The reporter (a bash script that reports status from Claude Code hooks to the hub) assumes bash and runs on macOS / Linux / WSL2
- Required Node.js version: `>=22.5.0` (matches `engines.node` in `package.json`. Both `npx` and `monomi` check this version at startup and exit with an error if it is not satisfied)
- Note: with older npm releases such as npm 10.8.2, `npm install -g monomi-cli` can fail with `Exit handler never called!` (a known npm bug). If this happens, update npm to the latest version and retry.

## Quick start

You can try it out on the spot without a global install.

```sh
npx monomi-cli
```

This single command does everything:

1. Starts the hub automatically if it isn't running yet (generates `~/.monomi/` — config.yml, SQLite DB, and token — on first run, and issues a hostname-based `device_id` plus a local token. Does nothing if the hub is already running)
2. If the Claude Code hooks aren't registered yet, asks "Run `install-hooks`? [Y/n]" (accepting registers the hooks and deploys the reporter; declining just shows guidance without asking again on subsequent runs; on a non-interactive terminal it skips the prompt and shows guidance only)
3. Displays the `monomi` dashboard

A hub started automatically keeps running even after you close the dashboard (it's a detached process that keeps running even if you close the terminal). To add a second or later device, just run `monomi pair` on that machine (see "Pairing a device (adding a child)" below).

If you use this machine regularly, a permanent install is recommended to avoid the resolution cost of `npx` every time.

```sh
npm install -g monomi-cli
```

After a global install, you can use the `monomi` command directly instead of `npx monomi-cli` (behavior is identical).

## Starting the hub and keeping it running

Starting the hub is automated by default. Running `monomi` (or `npx monomi-cli`) with no arguments checks connectivity to the default port (`47632`); if it can't connect, it starts the hub bundled in the package as a detached process, then shows the dashboard once connectivity is confirmed (if startup fails, it shows an error pointing you to `~/.monomi/hub.log`). A hub started this way keeps running after the dashboard exits, and subsequent launches skip the auto-start and connect directly.

If a hub is already reachable, `monomi` also compares its version against the running CLI's and keeps them in sync automatically — see "Automatic updates (hub & reporter)" below.

To explicitly start, stop, or check just the hub, use the following commands.

```sh
monomi hub           # Start the hub API server (foreground)
monomi hub status    # Show running status (running (pid/port/version) / stopped / stale pid)
monomi hub stop      # Stop the running hub (SIGTERM; removes the pid file after confirming shutdown)
```

The port can be overridden via `port` in `~/.monomi/config.yml`, and the listen address via `bind` (e.g. to restrict back to `127.0.0.1`). Running `monomi hub` on a device configured with `role: child` exits with an error.

If you want this machine to always listen as the hub even after a reboot (optional; usually unnecessary thanks to auto-start), set up a launchd LaunchAgent manually. First confirm the absolute paths with `which node` and `which monomi` (if globally installed), then create `~/Library/LaunchAgents/com.monomi.hub.plist`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.monomi.hub</string>
  <key>ProgramArguments</key>
  <array>
    <!-- replace with the output of `which node` -->
    <string>/absolute/path/to/node</string>
    <!-- replace with the output of `which monomi` -->
    <string>/absolute/path/to/monomi</string>
    <string>hub</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <!-- ~ is not expanded, so use an absolute path -->
  <key>StandardOutPath</key>
  <string>/Users/YOUR_USERNAME/.monomi/hub.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USERNAME/.monomi/hub.log</string>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/com.monomi.hub.plist    # Enable (auto-starts from next login onward)
launchctl unload ~/Library/LaunchAgents/com.monomi.hub.plist  # Disable
```

`ProgramArguments` spells out the absolute path to node so that resolving the `#!/usr/bin/env node` shebang doesn't depend on launchd's minimal PATH. If launchd has already started the hub, running `monomi`/`npx monomi-cli` won't start a second instance, because the connectivity check against the existing hub succeeds first.

## Registering hooks (reporter integration)

To report status from Claude Code hooks to the hub, run `install-hooks`.

```sh
monomi install-hooks
```

`install-hooks` deploys the bash reporter (`~/.monomi/monomi-report.sh`; overwrites any existing file and grants execute permission), then idempotently registers the seven hooks `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Notification` / `Stop` / `SessionEnd` into `~/.claude/settings.json` (existing hooks from other tools are preserved). If deploying the reporter fails, it exits with an error before registering the hooks. To remove them, run `monomi uninstall-hooks` (removes only the hooks; the reporter itself is left in place).

Once hooks are registered, the deployed reporter is also kept up to date automatically on every `monomi` launch — see "Automatic updates (hub & reporter)" below.

## Pairing a device (adding a child)

To connect a second or later device (a child), such as a MacBook, to the hub, issue a code on the hub side and use it to pair from the child side.

```sh
# On the hub (Mac mini)
monomi hub pair
```

`monomi hub pair` shows a 6-digit code (5-minute TTL, invalidated after 5 failed attempts) along with any reachable candidate URLs it could detect (LAN / Tailscale).

```sh
# On the child (MacBook)
monomi pair --code <code> [--hub <url> ...]
```

`--hub` can be specified multiple times, and the order given is the connection priority order (if omitted, the candidates offered by the hub are used). On success, `~/.monomi/config.yml` stores `role: child` / `hub_endpoints` / an auto-generated `device_id`, and the token file stores the issued token (both `chmod 600`).

Managing registered devices is done from the hub side.

```sh
monomi hub devices list          # List registered devices (id, role, token valid/revoked, last_seen)
monomi hub devices revoke <id>   # Revoke the token for a device (that device gets 401 from then on)
```

## Automatic updates (hub & reporter)

Every `monomi` launch checks whether the running hub and the deployed reporter script are on the same version as the CLI you just ran, and keeps them in sync so an `npm install -g monomi-cli` / `npx monomi-cli@latest` upgrade doesn't leave stale processes or scripts behind:

- **Hub** (hub role only): the autostart connectivity check also reads the hub's version and compares it to the CLI's. If the hub is older (or doesn't report a version at all — an older hub build, treated as outdated), it's stopped gracefully (SIGTERM, same as `monomi hub stop`) and restarted on the current version; a notice reports the update. If the hub is newer than the CLI, the hub is left running as-is and a notice asks you to update the CLI instead (e.g. `npx monomi-cli@latest`). If the graceful stop doesn't finish in time, the hub is not force-killed — a warning notice is shown and the outdated hub keeps running (the update is retried on the next launch).
- **Reporter**: the deployed `~/.monomi/monomi-report.sh` carries a version marker. If it's older than the CLI (or has no marker, from before this feature existed), it's redeployed automatically and a notice reports the update. If the marker already matches the current version, the file is left untouched, so manual edits to an up-to-date reporter are preserved.
- **Child devices**: a child can't restart a remote hub, so instead it watches the hub's version on every poll response and shows a persistent notice asking you to update the hub on that device when it detects the hub is outdated (it does not repeat on every poll).

These notices appear in a persistent banner at the top of the dashboard. To turn off the automatic hub and reporter updates and only see the notices, set `auto_update: false` in `~/.monomi/config.yml` (default: `true`; see the configuration table below).

## Usage

```
monomi                          Show the dashboard for running instances (Ink. auto-starts the hub if absent)
monomi hub                      Start the hub API server (DB init + bootstrap + HTTP)
monomi hub stop                 Stop the running hub (SIGTERM; removes the pid file after confirming shutdown)
monomi hub status               Show hub status (running (pid/port/version) / stopped / stale pid)
monomi hub pair                 Issue a 6-digit pairing code and show candidate URLs (hub side)
monomi hub devices list         List registered devices (with token valid/revoked)
monomi hub devices revoke <id>  Revoke a device's token (that token gets 401 from then on)
monomi pair --code <code> [--hub <url> ...]  Pair with a hub and save the token + config (child side)
monomi install-hooks            Register the 7 Claude Code hooks into ~/.claude/settings.json
monomi uninstall-hooks          Remove only the hooks added by Monomi
monomi --version, -v            Show the version
monomi --help, -h               Show this help
```

Keyboard controls in the dashboard (`monomi` with no arguments):

| Key              | Action                                                                      |
| ---------------- | --------------------------------------------------------------------------- |
| `1`-`6`          | Toggle status filters (multi-select, list view only)                        |
| `j`/`k`, `↑`/`↓` | List: move cursor / Detail: scroll the event history one line               |
| `Enter`          | Select an instance and show its detail view                                 |
| `←`/`→`          | Detail: move to the adjacent instance in list order                         |
| `w`              | Detail: toggle event line wrap vs. truncated display (truncated by default) |
| `f`              | Focus the terminal tab where this session is running (same device only)     |
| `esc`            | Go back (close help / detail view back to list)                             |
| `?`              | Show help                                                                   |
| `q`              | Quit                                                                        |

Each list card also includes a `path` line (the instance's working directory) between the branch and status lines. The home directory is collapsed to `~` (e.g. `/Users/alice/project` → `~/project`); if the path still doesn't fit the card width, it's truncated in the middle (`start…end`) instead of at the end, so the trailing directory name — often what distinguishes similarly named worktrees — stays visible.

The last line of each list card shows the Workflow / Agent / Skill currently running for that instance, as `▶ <name>` (`-` if nothing is running). The detail view's overview box shows the same information as `<name> (workflow|agent|skill)`. When a start time can be obtained, the elapsed time is appended (list card: `▶ <name> (<elapsed>)`; detail view: `<name> (workflow|agent|skill) <elapsed>`).

## Terminal Focus (the `f` key)

Pressing `f` while a session row is selected in the list or detail view brings that session's terminal window to the foreground and focuses the appropriate tab. This only works for sessions on the same machine as the CLI you're running: selecting a row from another device and pressing `f` shows an on-screen message and does nothing (the same applies to closed sessions, sessions with no terminal information, or when the detected terminal app isn't currently running). Terminal.app, Ghostty, and tmux are supported.

When Monomi detects which terminal app a session is running in, it shows the name next to the device on the session's list card (e.g. `device-name (Ghostty)`) and in a `Terminal` field in the detail view, so you can see what `f` will act on before pressing it.

### macOS: Required permissions

Monomi needs accessibility permissions to programmatically bring terminal windows to the foreground. Grant this on macOS:

**System Settings → Privacy & Security → Accessibility**:

- Add `monomi` (the Monomi CLI process)
- Add `System Events` (required for Ghostty and tmux focus)

If you haven't granted these permissions yet, attempting to focus will show a hint message on-screen.

### Ghostty: Manual environment setup

If you use Ghostty, you must manually add a one-time environment variable setting to `~/.claude/settings.json` to enable terminal title manipulation:

```json
{
  "env": {
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1"
  }
}
```

> **Why manual, not automatic?** The title manipulation approach requires disabling dynamic terminal titles globally, which affects all Claude Code sessions. To prevent unexpected side effects, Monomi does not auto-configure this. If you do not add this setting, Ghostty focus attempts will fail gracefully with a hint message.

After adding the setting, restart your Claude Code session.

### Linux / WSL2

- **Native Linux (X11/Wayland)**: Not currently supported.
- **WSL2**: Windows Terminal window foreground is supported on a best-effort basis. Tab-level focus is not available.
- **tmux on any platform**: Supported. If tmux is detached, a message will indicate that the session is unreachable.

## Configuration (`~/.monomi/config.yml`)

The CLI's display language defaults to English. To display in Japanese, either explicitly set `locale: ja`, or let it be auto-detected from the OS language setting (on macOS, the system language setting (`AppleLocale`) is preferred, falling back to the `LANG` environment variable only if that can't be obtained; on non-macOS, only `LANG` is used. Existing users upgrading from an older version need to add this setting to keep the Japanese display).

| Key                                   | Default                  | Description                                                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role`                                | `hub`                    | `hub` (server side) or `child` (client side, set automatically by `monomi pair`)                                                                                                                                                                         |
| `port`                                | `47632`                  | The hub API's listen port                                                                                                                                                                                                                                |
| `bind`                                | `0.0.0.0`                | The hub's listen address. Set to `127.0.0.1` to only accept connections from the same machine                                                                                                                                                            |
| `locale`                              | (auto-detected if unset) | The CLI's display language, `ja` or `en`. If unset, auto-detected from the OS language setting (macOS: `AppleLocale` preferred, falling back to `LANG`; otherwise: `LANG`), falling back to `en` if it can't be determined                               |
| `hub_endpoints`                       | (none)                   | Candidate hub endpoints to try when `role: child` (a priority-ordered block sequence; see example below)                                                                                                                                                 |
| `device_id`                           | (auto-generated)         | Auto-generated from the hostname at hub startup / pairing time if not specified                                                                                                                                                                          |
| `auto_update`                         | `true`                   | Whether to automatically keep the hub and the deployed reporter script in sync with the running CLI's version on each `monomi` launch. Set to `false` to only show update notices without applying them (see "Automatic updates (hub & reporter)" above) |
| `watch_interval`                      | `3s`                     | The dashboard's watch-mode polling interval                                                                                                                                                                                                              |
| `escalation_thresholds.active`        | `2h`                     | Time until an active session is promoted to idle (stale)                                                                                                                                                                                                 |
| `escalation_thresholds.approval_wait` | `6h`                     | Time until waiting-for-permission is promoted to idle                                                                                                                                                                                                    |
| `escalation_thresholds.next_wait`     | `24h`                    | Time until waiting-for-next-instruction is promoted to idle                                                                                                                                                                                              |
| `escalation_thresholds.pr_wait`       | `72h`                    | Time until waiting-for-PR-review is promoted to idle                                                                                                                                                                                                     |

Durations are specified as unit-suffixed strings such as `500ms` / `3s` / `30m` / `2h` / `1d`.

`hub_endpoints` is written automatically when you run `monomi pair`, but if you edit it manually, use block-sequence notation (one URL per line), since the bash reporter reads it line by line.

```yaml
role: child
hub_endpoints:
  - http://192.168.1.100:47632
  - http://100.64.0.1:47632
```

## Updating

```sh
npm update -g monomi-cli
```

## Uninstalling

Follow this order (remove `~/.monomi`, which includes the DB and token, last, all at once).

```sh
monomi uninstall-hooks       # 1. Remove only the Monomi hooks from Claude Code's settings.json
monomi hub stop              # 2. Stop the running hub (also runs launchctl unload if it was kept running via launchd)
npm uninstall -g monomi-cli  # 3. Remove the global package (only if you installed it globally)
rm -rf ~/.monomi             # 4. Delete all data, including config.yml, the SQLite DB, tokens, and the reporter
```

Deleting `~/.monomi` also permanently deletes the SQLite DB holding your run history and the tokens of paired devices. If you share this hub with other devices, check the impact before deleting.

## Documentation

- Authoritative design spec: `docs/ARCHITECTURE.md` (`docs/monomi-handoff.md` is a frozen record of design history and is not the reference for current specs)
- Functional requirements summary: `docs/REQUIREMENTS.md` (current state summarized by feature area; details in each `docs/releases/release-N/requirements.md`)
- Class design: `docs/design/class-diagram.md`
- Development workflow: `docs/development-workflow.md`
- Developer setup: `docs/development.md`
- Release requirements: `docs/releases/` (`release-1-single-machine-wedge/`, `release-2-biome-migration/`, `release-3-multi-device-pairing/`, `release-4-cli-dashboard-ux/`, `release-5-docs-restructure/`, `release-6-detail-view-redesign/`, `release-7-session-status-reliability/`, `release-8-dashboard-freshness/`, `release-9-i18n/`, `release-23-terminal-focus/`)
- E2E verification checklist: `docs/releases/release-N/e2e-verification.md` (manual acceptance test procedure for multi-device / terminal-focus features)
- Known limitations (worth knowing before you try it): `docs/known-limitations.md`
- Internal development backlog (for contributors): `docs/known-issues.md`
