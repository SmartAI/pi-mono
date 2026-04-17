#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${AVA_CONTAINER:-ava-sandbox}"
DATA_DIR="${AVA_DATA_DIR:-$(pwd)/data}"
REPO_URL="${AVA_REPO_URL:-}"

if [ -z "$REPO_URL" ]; then
  echo "AVA_REPO_URL must be set to the ActualVoice repo URL (e.g. git@github.com:actualvoice/acav.git)" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running or not accessible." >&2
  exit 1
fi

mkdir -p "$DATA_DIR"

if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Container $CONTAINER already exists. Delete with: docker rm -f $CONTAINER"
else
  # On Fedora, :Z tells Docker to relabel bind mounts for SELinux.
  # Safe on non-SELinux hosts: they ignore it.
  docker run -d --name "$CONTAINER" \
    -v "$DATA_DIR:/workspace:Z" \
    -v "$HOME/.claude:/home/ava/.claude:ro,Z" \
    -v "$HOME/.codex:/home/ava/.codex:ro,Z" \
    -v "$HOME/.pi:/home/ava/.pi:ro,Z" \
    alpine:latest tail -f /dev/null
fi

docker exec -u 0 "$CONTAINER" sh -euc '
  apk add --no-cache git github-cli nodejs npm jq curl chromium bash shadow
  adduser -D -h /home/ava -s /bin/bash ava || true
  npm install -g @anthropic-ai/claude-code @openai/codex @mariozechner/pi-coding-agent
'

# Host-side: create the bare repo if it does not exist yet
if [ ! -d "$DATA_DIR/repo.git" ]; then
  git clone --bare "$REPO_URL" "$DATA_DIR/repo.git"
fi

echo "Sandbox ready: container=$CONTAINER, data=$DATA_DIR"
echo "Next: run \`ava --data-dir $DATA_DIR --sandbox=docker:$CONTAINER\` after Gmail OAuth."
