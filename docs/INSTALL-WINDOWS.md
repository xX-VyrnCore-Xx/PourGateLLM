# Installing PourGateLLM on Windows

Two ways: the **app** (installer with its own Node.js, window, nothing else to install) or the **CLI** (needs Node.js 22.13+). The app was built by CI but **never launched on a real Windows machine by the author**: if something misbehaves, `gateway.log` (below) is the first place to look, and please report it.

## A. The app (recommended)

1. **Download** from the [latest release](https://github.com/xX-VyrnCore-Xx/PourGateLLM/releases/latest) one of:
   - `PourGateLLM-<version>-windows-…-setup.exe` (installs for your user only, no administrator rights, English or Italian), or
   - `PourGateLLM-<version>-windows-….msi` (standard Windows Installer, handy for IT deployment).
2. **Optional: verify the file.** Download `SHA256SUMS-windows-app.txt` from the same release, then in PowerShell:
   ```powershell
   Get-FileHash .\PourGateLLM-*-setup.exe -Algorithm SHA256
   ```
   The hash must equal the line for that file in the checksum list.
3. **Run the installer.** The app is **not code-signed**, so Windows SmartScreen shows *"Windows protected your PC"*: click **More info → Run anyway**. (This appears because the author has no paid signing certificate, not because the file is flagged; the checksum above is how you check it.)
4. **Start PourGateLLM** from the Start menu. A welcome window appears and starts the gateway in the background (no console window). On the **first launch only** it shows an **admin password** and a **client token**: copy both now (buttons next to them). They are also stored in `%APPDATA%\dev.pourgatellm.desktop\.env`.
5. Click **Open the dashboard** and sign in with the admin password.
6. **Add providers:** the Providers page links to each provider's key page. Paste keys there (or use *Paste many keys*). Kilo, OVHcloud, LLM7 and Pollinations work with **no key at all**, so you can try a message in the Playground right away.
7. **Use it from other programs:** base URL `http://localhost:43117/v1`, API key = the client token from step 4 (create more under *Tokens*). Check [README](../README.md) for Codex CLI, Claude Code (MCP), Gemini CLI and editor setups.

The gateway listens on this computer only (`127.0.0.1`), port **43117**.

### Where things are

| What | Where |
|---|---|
| Settings, admin password, token | `%APPDATA%\dev.pourgatellm.desktop\.env` |
| Database (keys are encrypted) | `%APPDATA%\dev.pourgatellm.desktop\pourgate.db` |
| Log | `%APPDATA%\dev.pourgatellm.desktop\gateway.log` |

Press `Win + R` and paste `%APPDATA%\dev.pourgatellm.desktop` to open the folder. After editing `.env`, close and reopen the app.

### Updating and removing

- **Update:** download the new installer and run it over the old one; your data stays.
- **Quit:** right-click the PourGateLLM icon in the tray (next to the clock) → **Quit and stop the gateway**. Closing the window only hides it to the tray.
- **Remove:** quit from the tray, then *Settings → Apps → PourGateLLM → Uninstall* (the uninstaller also stops PourGateLLM and its gateway). Version 0.6.1 and earlier have no tray: if the uninstall fails, end `PourGateLLM.exe` and its `node.exe` in Task Manager first. Delete the data folder above as well if you want everything gone (this erases stored keys and tokens).

### If it does not start

- The window says the gateway did not start: open `gateway.log` (path above). A *port already in use* message means another program uses 43117.
- Antivirus quarantined `node.exe` inside the install folder: restore it and allow the folder (the app ships Node.js as a normal file, which some tools distrust because the installer is unsigned).
- Corporate machines can block unsigned installers: use the CLI route below.

## B. The CLI (needs Node.js 22.13 or newer)

```powershell
irm https://raw.githubusercontent.com/xX-VyrnCore-Xx/PourGateLLM/main/install/install.ps1 | iex
pourgate setup            # paste keys step by step (optional: keyless providers work without)
pourgate service install  # start at logon (scheduled task)
pourgate start            # or run it once in this window
```

The installer checks the release checksum before installing. Dashboard: `http://localhost:3000`. Remove it with `install\uninstall.ps1` (it shows what it will delete and asks first).
