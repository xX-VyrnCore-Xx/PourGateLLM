#!/bin/sh
# PourGateLLM installer for Linux and macOS (needs Node >= 22.13).
#   curl -fsSL https://raw.githubusercontent.com/xX-VyrnCore-Xx/PourGateLLM/main/install/install.sh | sh
#   ... | sh -s -- 0.1.1        # a specific version
# Env: POURGATE_HOME (default ~/.pourgate), POURGATE_BIN (default ~/.local/bin)
set -eu

REPO="xX-VyrnCore-Xx/PourGateLLM"
VERSION="${1:-${POURGATE_VERSION:-latest}}"
HOME_DIR="${POURGATE_HOME:-$HOME/.pourgate}"
BIN_DIR="${POURGATE_BIN:-$HOME/.local/bin}"

die() { echo "error: $*" >&2; exit 1; }
command -v node >/dev/null 2>&1 || die "Node.js 22.13 or newer is required (https://nodejs.org)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "Node $(node -v) is too old: 22.13 or newer is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

if [ "$VERSION" = "latest" ]; then
  final=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") || die "could not resolve the latest release"
  VERSION="${final##*/}"
fi
VERSION="${VERSION#v}"
echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || die "invalid version: $VERSION"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading PourGateLLM $VERSION..."
curl -fsSL "https://github.com/$REPO/releases/download/v$VERSION/pourgatellm-$VERSION.tar.gz" -o "$tmp/pg.tar.gz" \
  || die "download failed (does release v$VERSION have a tarball?)"

# Replace the application; data and config in $HOME_DIR/data and config.env are kept.
mkdir -p "$HOME_DIR" "$BIN_DIR"
rm -rf "$HOME_DIR/app"
mkdir -p "$HOME_DIR/app"
tar -xzf "$tmp/pg.tar.gz" -C "$HOME_DIR/app" --strip-components=1
[ -f "$HOME_DIR/app/bin/pourgate.mjs" ] || die "this release has no launcher (bin/pourgate.mjs); use a newer version"

cat > "$BIN_DIR/pourgate" <<SHIM
#!/bin/sh
POURGATE_HOME="\${POURGATE_HOME:-$HOME_DIR}" exec node "$HOME_DIR/app/bin/pourgate.mjs" "\$@"
SHIM
chmod +x "$BIN_DIR/pourgate"

echo "Installed PourGateLLM $VERSION to $HOME_DIR"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Add $BIN_DIR to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;; esac
echo "Start it with:  pourgate start   (first run prints your dashboard password and API token)"
