#!/bin/sh
# Stops and removes the PourGateLLM Docker install created by install-docker.sh.
#   sh uninstall-docker.sh                 stop and remove the container, keep data volume and .env
#   sh uninstall-docker.sh --purge         also delete the data volume (database, provider keys) and the folder
#   sh uninstall-docker.sh --image         also remove the downloaded image
# Flags: --yes  do not ask for confirmation
# Env:   POURGATE_DIR (default ./pourgate)
set -eu

PURGE=0; IMAGE=0; YES=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    --image) IMAGE=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n 2,8p "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

DIR="${POURGATE_DIR:-$PWD/pourgate}"
[ -f "$DIR/docker-compose.yml" ] || { echo "No PourGateLLM compose file in $DIR (set POURGATE_DIR)." >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Docker is required." >&2; exit 1; }

echo "This will:"
echo "  - stop and remove the PourGateLLM container"
[ "$PURGE" = 1 ] && echo "  - DELETE the data volume (database, stored provider keys) and the folder $DIR (including .env)"
[ "$PURGE" = 0 ] && echo "  - KEEP the data volume and $DIR/.env (add --purge to delete them)"
[ "$IMAGE" = 1 ] && echo "  - remove the downloaded image"

if [ "$YES" != 1 ]; then
  if (: </dev/tty) 2>/dev/null; then
    printf 'Continue? [y/N] ' >&2
    read -r answer </dev/tty
  else
    echo "Not a terminal: re-run with --yes to confirm." >&2; exit 1
  fi
  case "$answer" in y|Y|yes|YES) ;; *) echo "Cancelled."; exit 1 ;; esac
fi

cd "$DIR"
IMG=$(docker compose config --images 2>/dev/null | head -n1 || true)
if [ "$PURGE" = 1 ]; then docker compose down -v --remove-orphans; else docker compose down --remove-orphans; fi
if [ "$IMAGE" = 1 ] && [ -n "$IMG" ]; then docker rmi "$IMG" >/dev/null 2>&1 || echo "Could not remove image $IMG (still in use?)." >&2; fi
if [ "$PURGE" = 1 ]; then
  cd ..
  # Only delete a folder that looks like ours.
  if [ -f "$DIR/docker-compose.yml" ]; then rm -rf "$DIR"; fi
  echo "PourGateLLM and its data were removed."
else
  echo "PourGateLLM was removed. Data volume and $DIR/.env were kept."
fi
