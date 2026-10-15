#!/bin/sh
# Removes the PourGateLLM CLI installed by install.sh (Linux / macOS).
#   pourgate uninstall            (or)   sh uninstall.sh
#   curl -fsSL https://raw.githubusercontent.com/xX-VyrnCore-Xx/PourGateLLM/main/install/uninstall.sh | sh
# Flags:  --purge   also delete your data and config (database, provider keys, master key, config.env)
#         --yes     do not ask for confirmation
# By default your data and config are KEPT, so a later reinstall picks up where you left off.
# Env: POURGATE_HOME (default ~/.pourgate), POURGATE_BIN (default ~/.local/bin)

main() {
  PURGE=0; YES=0
  for a in "$@"; do
    case "$a" in
      --purge) PURGE=1 ;;
      --yes|-y) YES=1 ;;
      -h|--help) sed -n 2,9p "$0" 2>/dev/null; return 0 ;;
      *) echo "unknown option: $a" >&2; return 2 ;;
    esac
  done

  HOME_DIR="${POURGATE_HOME:-$HOME/.pourgate}"
  # Never operate on something that could be a system or home directory.
  case "$HOME_DIR" in ""|/|"$HOME"|"$HOME/") echo "refusing to use '$HOME_DIR' as the PourGateLLM directory" >&2; return 1 ;; esac
  [ -d "$HOME_DIR" ] || { echo "Nothing to remove: $HOME_DIR does not exist."; return 0; }

  BIN="${POURGATE_BIN:-$HOME/.local/bin}/pourgate"
  if [ -f "$HOME_DIR/install.json" ]; then
    rec=$(sed -n 's/.*"bin"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$HOME_DIR/install.json" | head -n1)
    [ -n "$rec" ] && BIN="$rec"
  fi

  PORT_NUM=3000
  if [ -f "$HOME_DIR/config.env" ]; then
    p=$(sed -n 's/^PORT=\([0-9]*\).*/\1/p' "$HOME_DIR/config.env" | head -n1)
    [ -n "$p" ] && PORT_NUM="$p"
  fi
  if command -v curl >/dev/null 2>&1 && curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$PORT_NUM/health" 2>/dev/null; then
    echo "A PourGateLLM server is still running on port $PORT_NUM. Stop it first (Ctrl+C in its terminal, or \"pourgate service uninstall\" if it runs as a service), then run this again." >&2
    return 1
  fi

  echo "This will remove:"
  [ -e "$BIN" ] && echo "  - command   $BIN"
  [ -d "$HOME_DIR/app" ] && echo "  - program   $HOME_DIR/app"
  if [ "$PURGE" = 1 ]; then
    echo "  - ALL DATA  $HOME_DIR  (database, stored provider keys, master key, config.env)"
  else
    echo "It will KEEP your data and config in $HOME_DIR (add --purge to delete them too)."
  fi

  if [ "$YES" != 1 ]; then
    if (: </dev/tty) 2>/dev/null; then
      printf 'Continue? [y/N] ' >&2
      read -r answer </dev/tty
    else
      echo "Not a terminal: re-run with --yes to confirm." >&2
      return 1
    fi
    case "$answer" in y|Y|yes|YES) ;; *) echo "Cancelled."; return 1 ;; esac
  fi

  # Stop and remove the auto-start service, if one was installed.
  UNIT="$HOME/.config/systemd/user/pourgatellm.service"
  if [ -f "$UNIT" ]; then
    command -v systemctl >/dev/null 2>&1 && systemctl --user disable --now pourgatellm >/dev/null 2>&1
    rm -f "$UNIT"
    command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1
    echo "Removed the pourgatellm systemd service."
  fi
  PLIST="$HOME/Library/LaunchAgents/dev.pourgatellm.gateway.plist"
  if [ -f "$PLIST" ]; then
    command -v launchctl >/dev/null 2>&1 && launchctl unload -w "$PLIST" >/dev/null 2>&1
    rm -f "$PLIST"
    echo "Removed the launchd service."
  fi
  rm -f "$BIN"
  # Only delete the program directory if it really is one.
  if [ -f "$HOME_DIR/app/bin/pourgate.mjs" ]; then rm -rf "$HOME_DIR/app"; fi
  rm -f "$HOME_DIR/install.json"
  if [ "$PURGE" = 1 ]; then
    rm -rf "$HOME_DIR"
    echo "PourGateLLM and all its data were removed."
  else
    echo "PourGateLLM was removed. Your data is still in $HOME_DIR."
  fi
}

# The whole script is parsed before anything runs, so it can delete itself safely.
main "$@"; exit $?
