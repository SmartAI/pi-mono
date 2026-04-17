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
  # Product-context Drive folder: CANNOT be mounted directly if it's a
  # fuse.rclone Google Drive mount (podman refuses FUSE source). TODO:
  # rsync ~/Ava -> a regular-disk mirror inside $DATA_DIR and mount that
  # location, or extract the specs Ava actually needs into the repo.
  # For now: no drive mount. Agent will work from in-repo specs only.

  # Mirror-mount: $DATA_DIR is visible at BOTH /workspace (what the agent
  # is told about) AND its host-absolute path (what worktree .git files
  # reference). This lets `git` inside the container follow worktree
  # gitdir pointers written by Ava's host-side WorktreeManager, without
  # having to rewrite them or teach the manager about container paths.
  # SSH keys and gh token are COPIED in post-start (see below), not mounted,
  # because SELinux MCS categories on ~/.ssh conflict with the container's
  # per-run category and :Z refuses to relabel existing container-labeled files.
  docker run -d --name "$CONTAINER" \
    --userns=keep-id \
    -v "$DATA_DIR:/workspace:Z" \
    -v "$DATA_DIR:$DATA_DIR" \
    -v "$HOME/.claude:/home/ava/.claude:Z" \
    -v "$HOME/.claude.json:/home/ava/.claude.json:Z" \
    -v "$HOME/.codex:/home/ava/.codex:Z" \
    -v "$HOME/.pi:/home/ava/.pi:ro,Z" \
    alpine:latest tail -f /dev/null
fi

docker exec -u 0 "$CONTAINER" sh -euc '
  apk add --no-cache git github-cli nodejs npm jq curl chromium bash shadow openssh-client
  adduser -D -h /home/ava -s /bin/bash ava || true
  # The podman --userns=keep-id option auto-injects the host user (UID 1000)
  # into /etc/passwd with home=/ and shell=/bin/sh. Repoint that home dir
  # to /home/ava so ssh/git/etc. find ~/.ssh, ~/.config/gh, ~/.claude, etc.
  # at the right location without every caller having to set $HOME manually.
  usermod -d /home/ava -s /bin/bash $(getent passwd 1000 | cut -d: -f1) 2>/dev/null || true
  npm install -g @anthropic-ai/claude-code @openai/codex @mariozechner/pi-coding-agent
'

# SSH keys: copy into the container (can't mount because of SELinux MCS
# category mismatch between host ~/.ssh and this container's category).
# Owned by UID 1000 (the exec user) with correct SSH perms.
if [ -f "$HOME/.ssh/id_ed25519" ]; then
  docker exec -u 0 "$CONTAINER" install -d -m 700 -o 1000 -g 1000 /home/ava/.ssh
  docker cp "$HOME/.ssh/id_ed25519" "$CONTAINER":/home/ava/.ssh/id_ed25519
  docker cp "$HOME/.ssh/id_ed25519.pub" "$CONTAINER":/home/ava/.ssh/id_ed25519.pub
  [ -f "$HOME/.ssh/known_hosts" ] && docker cp "$HOME/.ssh/known_hosts" "$CONTAINER":/home/ava/.ssh/known_hosts
  docker exec -u 0 "$CONTAINER" sh -euc '
    chown -R 1000:1000 /home/ava/.ssh
    chmod 600 /home/ava/.ssh/id_ed25519
    chmod 644 /home/ava/.ssh/id_ed25519.pub
    [ -f /home/ava/.ssh/known_hosts ] && chmod 644 /home/ava/.ssh/known_hosts
    exit 0
  '
fi

# gh auth: the host keeps its token in the system keyring (not hosts.yml).
# Write an explicit hosts.yml inside the container so `gh` works without
# needing the keyring. Runs best-effort; if `gh auth token` on the host
# fails, the sandbox still comes up but `gh` commands will require manual
# login. Owned by UID 1000 (our exec user) — NOT the ava user (UID 1001).
GH_TOKEN="$(gh auth token 2>/dev/null || true)"
if [ -n "$GH_TOKEN" ]; then
  docker exec -u 0 "$CONTAINER" sh -euc "
    install -d -m 700 -o 1000 -g 1000 /home/ava/.config/gh
    cat > /home/ava/.config/gh/hosts.yml <<EOF
github.com:
    oauth_token: $GH_TOKEN
    git_protocol: ssh
    user: SmartAI
    users:
        SmartAI:
            oauth_token: $GH_TOKEN
EOF
    chown 1000:1000 /home/ava/.config/gh/hosts.yml
    chmod 600 /home/ava/.config/gh/hosts.yml
  "
fi

# Host-side: create the bare repo if it does not exist yet
if [ ! -d "$DATA_DIR/repo.git" ]; then
  git clone --bare "$REPO_URL" "$DATA_DIR/repo.git"
fi

echo "Sandbox ready: container=$CONTAINER, data=$DATA_DIR"
echo "Next: run \`ava --data-dir $DATA_DIR --sandbox=docker:$CONTAINER\` after Gmail OAuth."
