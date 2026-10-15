# PourGateLLM desktop (experimental)

A thin [Tauri 2](https://tauri.app) wrapper: it starts the gateway as a child process and shows the dashboard in a native window.

> **Status: untested.** It could not be compiled in the environment where it was written. The `Desktop` workflow builds it on Linux, macOS and Windows so build errors surface in CI.

## Requirements
- Node ≥ 22.13 on `PATH` (the server runs as a child process; a bundled runtime is future work)
- Rust toolchain and `cargo install tauri-cli --version "^2"`

## Build
```bash
pnpm install && pnpm build
pnpm --filter @pourgate/desktop prepare:server
cd packages/desktop/src-tauri && cargo tauri build   # or `cargo tauri dev`
```

## First launch
The app creates `.env` in its app-data directory (Linux: `~/.local/share/dev.pourgatellm.desktop/`) with a random admin password and API token. Edit it to add provider keys, then restart.
The gateway listens on port `43117` (it is not bound to loopback only, so keep the port closed in your firewall); other `POURGATE_*` variables in that `.env` work as documented in the main README.

## Uninstall
Remove it from *Settings → Apps*. The installer keeps your data: delete `%APPDATA%\dev.pourgatellm.desktop` (Windows) or `~/.local/share/dev.pourgatellm.desktop` (Linux) to remove the config, database and keys as well. The NSIS uninstaller may offer to delete app data; this is untested.
