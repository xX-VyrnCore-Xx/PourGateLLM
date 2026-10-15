#!/bin/sh
# PourGateLLM via Docker: creates ./pourgate (or $POURGATE_DIR) with a compose file and a generated .env, then starts it.
#   curl -fsSL https://raw.githubusercontent.com/xX-VyrnCore-Xx/PourGateLLM/main/install/install-docker.sh | sh
set -eu

RAW="https://raw.githubusercontent.com/xX-VyrnCore-Xx/PourGateLLM/main/install"
DIR="${POURGATE_DIR:-$PWD/pourgate}"

die() { echo "error: $*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || die "Docker is required (https://docs.docker.com/get-docker/)"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"

mkdir -p "$DIR"
cd "$DIR"
curl -fsSL "$RAW/docker-compose.yml" -o docker-compose.yml || die "could not download the compose file"

rand() { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$1"; }
if [ ! -f .env ]; then
  PASSWORD=$(rand 24)
  TOKEN="pg-$(rand 40)"
  umask 077
  cat > .env <<ENV
POURGATE_ADMIN_PASSWORD=$PASSWORD
POURGATE_TOKENS=$TOKEN
# Add provider keys, then run: docker compose up -d
GROQ_API_KEYS=
GEMINI_API_KEYS=
CEREBRAS_API_KEYS=
MISTRAL_API_KEYS=
OPENROUTER_API_KEYS=
ENV
  echo "Created $DIR/.env"
  echo "  dashboard password: $PASSWORD"
  echo "  API token:          $TOKEN"
else
  echo "Keeping the existing $DIR/.env"
fi

docker compose pull
docker compose up -d
echo "PourGateLLM is starting on http://localhost:3000 (edit $DIR/.env to add provider keys, then 'docker compose up -d')."
