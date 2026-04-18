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
  apk add --no-cache git github-cli nodejs npm jq curl chromium bash shadow openssh-client rclone
  adduser -D -h /home/ava -s /bin/bash ava || true
  # The podman --userns=keep-id option auto-injects the host user (UID 1000)
  # into /etc/passwd with home=/ and shell=/bin/sh. Repoint that home dir
  # to /home/ava so ssh/git/etc. find ~/.ssh, ~/.config/gh, ~/.claude, etc.
  # at the right location without every caller having to set $HOME manually.
  usermod -d /home/ava -s /bin/bash $(getent passwd 1000 | cut -d: -f1) 2>/dev/null || true
  npm install -g @anthropic-ai/claude-code @openai/codex @mariozechner/pi-coding-agent
'

# rclone: copy the host's rclone.conf into the sandbox so agents can read/write
# Google Drive via the API (no FUSE needed, works under podman --userns=keep-id).
# The config contains OAuth tokens for whatever remotes are defined — same
# access level as running rclone on the host. If rclone.conf doesn'"'"'t exist
# on the host, Drive commands inside the sandbox will fail but the sandbox
# still comes up.
if [ -f "$HOME/.config/rclone/rclone.conf" ]; then
  docker exec -u 0 "$CONTAINER" install -d -m 700 -o 1000 -g 1000 /home/ava/.config/rclone
  docker cp "$HOME/.config/rclone/rclone.conf" "$CONTAINER":/home/ava/.config/rclone/rclone.conf
  docker exec -u 0 "$CONTAINER" sh -euc '
    chown 1000:1000 /home/ava/.config/rclone/rclone.conf
    chmod 600 /home/ava/.config/rclone/rclone.conf
  '
fi

# SSH key: Ava-dedicated ed25519 key (repo-scoped deploy key on voicepulse).
# Defaults to ~/.config/ava/id_ed25519; override with AVA_DEPLOY_KEY. We do NOT
# fall back to the user's personal ~/.ssh — that would give the sandbox
# broader-than-needed access. If the Ava key doesn't exist, SSH auth in the
# container just won't work and the agent will attach patches/bundles instead.
AVA_DEPLOY_KEY="${AVA_DEPLOY_KEY:-$HOME/.config/ava/id_ed25519}"
if [ -f "$AVA_DEPLOY_KEY" ]; then
  docker exec -u 0 "$CONTAINER" install -d -m 700 -o 1000 -g 1000 /home/ava/.ssh
  docker cp "$AVA_DEPLOY_KEY"     "$CONTAINER":/home/ava/.ssh/id_ed25519
  docker cp "$AVA_DEPLOY_KEY.pub" "$CONTAINER":/home/ava/.ssh/id_ed25519.pub
  # Seed known_hosts with github.com so BatchMode SSH doesn't prompt.
  docker exec -u 0 "$CONTAINER" sh -euc '
    ssh-keyscan -t ed25519,rsa github.com > /home/ava/.ssh/known_hosts 2>/dev/null
    chown -R 1000:1000 /home/ava/.ssh
    chmod 600 /home/ava/.ssh/id_ed25519
    chmod 644 /home/ava/.ssh/id_ed25519.pub /home/ava/.ssh/known_hosts
  '
fi

# gh auth: Ava-dedicated fine-grained PAT (scoped to voicepulse only).
# Defaults to ~/.config/ava/gh-token; override with AVA_GH_TOKEN_FILE. We do
# NOT fall back to the user's personal `gh auth token` — same reasoning as
# the SSH key.
AVA_GH_TOKEN_FILE="${AVA_GH_TOKEN_FILE:-$HOME/.config/ava/gh-token}"
if [ -f "$AVA_GH_TOKEN_FILE" ]; then
  GH_TOKEN="$(tr -d '[:space:]' < "$AVA_GH_TOKEN_FILE")"
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

# Git identity for commits the coding agent produces. Vercel (and other
# GitHub apps) require the author to match an identity the user can vouch
# for — Ava's own mailbox isn't a Vercel team member, so commits authored
# as `Ava <claude@actualvoice.ai>` get deploy-check-failed. We pin to the
# human owner (Min / max@) so PRs land cleanly. Override via
# AVA_GIT_USER_NAME / AVA_GIT_USER_EMAIL env vars if needed.
AVA_GIT_USER_NAME="${AVA_GIT_USER_NAME:-Min Liu}"
AVA_GIT_USER_EMAIL="${AVA_GIT_USER_EMAIL:-minliu905@gmail.com}"
docker exec -u 1000 "$CONTAINER" sh -euc "
  git config --global user.name  '$AVA_GIT_USER_NAME'
  git config --global user.email '$AVA_GIT_USER_EMAIL'
  git config --global init.defaultBranch main
  git config --global pull.rebase false
"

# Host-side: create the bare repo if it does not exist yet
if [ ! -d "$DATA_DIR/repo.git" ]; then
  git clone --bare "$REPO_URL" "$DATA_DIR/repo.git"
fi

echo "Sandbox ready: container=$CONTAINER, data=$DATA_DIR"
echo "Next: run \`ava --data-dir $DATA_DIR --sandbox=docker:$CONTAINER\` after Gmail OAuth."
