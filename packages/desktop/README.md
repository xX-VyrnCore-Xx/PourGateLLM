# PourGateLLM desktop (experimental)

A thin [Tauri 2](https://tauri.app) wrapper: it starts the gateway as a child process and shows the dashboard in a native window.

> **Status: compiles on Linux, macOS and Windows (CI); not yet exercised by hand.** The Windows installers (`.msi`, `.exe`) ship their own Node.js runtime, so nothing else has to be installed.

## Requirements
- Windows installers: nothing (Node.js is bundled). Other platforms / source builds: Node ≥ 22.13 on `PATH`
- Rust toolchain and `cargo install tauri-cli --version "^2"`

## Build
```bash
pnpm install && pnpm build
pnpm --filter @pourgate/desktop prepare:server            # uses `node` from PATH at run time
# or: pnpm --filter @pourgate/desktop prepare:server:standalone   # bundles the Node.js running this command
cd packages/desktop/src-tauri && cargo tauri build   # or `cargo tauri dev`
```

## First launch
A welcome screen shows your generated dashboard password and API token (copy them: the password is also in the settings file). The app creates `.env` in its app-data directory (Linux: `~/.local/share/dev.pourgatellm.desktop/`) with a random admin password and API token. Edit it to add provider keys, then restart.
The gateway listens on `127.0.0.1:43117` only, so it is not reachable from other machines; other `POURGATE_*` variables in that `.env` work as documented in the main README.

## Tray icon
The app lives in the system tray (next to the clock). Closing the window only hides it; the gateway keeps serving your other apps. Right-click the tray icon for: open the app, open the dashboard in the browser, open the data folder or the log, **restart the gateway** (re-reads `.env`), start with the system, and **Quit and stop the gateway**. Left-click the icon to bring the window back. Starting a second copy just brings the running one forward.

Quitting stops the gateway. On Windows the gateway is also tied to the app by a job object, so it ends even if the app is killed from Task Manager. If port 43117 is taken, the app picks a free port and shows it in the window.

## Uninstall
Quit from the tray menu (the installer and uninstaller also stop PourGateLLM and its gateway themselves), then remove it from *Settings → Apps*. If an older version (0.6.1 or earlier) was left running, end `PourGateLLM.exe` and the `node.exe` that belongs to it in Task Manager first. The installer keeps your data: delete `%APPDATA%\dev.pourgatellm.desktop` (Windows) or `~/.local/share/dev.pourgatellm.desktop` (Linux) to remove the config, database and keys as well. The NSIS uninstaller may offer to delete app data; this is untested.
