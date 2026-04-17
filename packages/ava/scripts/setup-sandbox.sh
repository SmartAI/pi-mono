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
  # On Fedora, :Z tells Docker/podman to relabel bind mounts for SELinux.
  # --userns=keep-id is podman-specific: maps host UID 1000 -> container UID 1000
  # so mounted credential files stay readable by the in-container `ava` user
  # (also UID 1000). On Docker Engine, remove --userns=keep-id; you'll need
  # a different credential-sharing strategy. See docs/superpowers/specs for
  # the Fedora/podman design rationale.
  # ~/.claude/ is mounted read-write so claude can persist session JSONL files
  # under projects/<cwd-hash>/ — read-only breaks --resume and session history.
  # Same effective access level as running `claude` on the host (podman's
  # --userns=keep-id preserves UID 1000, so writes look identical on-disk).
  # ~/.claude.json mounted read-write likewise (claude updates counters there).
  # ~/.codex/ and ~/.pi/ can stay read-only for now; revisit if their CLIs
  # exhibit similar session-persistence needs.
  # Optional: product-context Drive folder — mount read-only if present on host.
  # This is where ActualVoice keeps its hub+spoke specs, CHANGELOG, and
  # maintenance guide. Agents read these files but never write to them
  # (updates go via the /maintain-context skill which Max runs on the host).
  DRIVE_MOUNT=""
  if [ -d "$HOME/Ava" ]; then
    DRIVE_MOUNT="-v $HOME/Ava:/home/ava/actualvoice-drive:ro,Z"
  fi

  docker run -d --name "$CONTAINER" \
    --userns=keep-id \
    -v "$DATA_DIR:/workspace:Z" \
    -v "$HOME/.claude:/home/ava/.claude:Z" \
    -v "$HOME/.claude.json:/home/ava/.claude.json:Z" \
    -v "$HOME/.codex:/home/ava/.codex:Z" \
    -v "$HOME/.pi:/home/ava/.pi:ro,Z" \
    $DRIVE_MOUNT \
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
