# @actualvoice/ava

Email-driven AI teammate for ActualVoice. Receives Gmail at a dedicated
address, runs an agent CLI (Claude Code, Codex, or pi) in a Docker
sandbox to do work against the product repo, and replies in-thread.

Design: `docs/superpowers/specs/2026-04-16-ava-design.md`.

## First-time setup

### 1. Authenticate the agent CLIs on the host

Run each once, interactively, outside the sandbox:

```bash
claude login
codex login   # or whatever the current CLI command is
pi --login    # optional, only if you plan to use the pi backend
```

### 2. Create a Google Cloud OAuth client for Gmail

1. Enable the Gmail API in a Google Cloud project.
2. Create an OAuth 2.0 Client of type "Desktop app".
3. Download the JSON and save it as `./data/gmail-credentials.json`.
4. Run `AVA_DATA_DIR=./data ava auth:gmail`. Follow the printed URL, paste the consent code back. A refresh token is written to `./data/gmail-token.json`.

### 3. Configure allowlist

Create `./data/allowlist.json`:

```json
{ "emails": ["max@actualvoice.ai", "brian@actualvoice.ai"] }
```

### 4. Configure settings (optional; defaults are fine)

Create `./data/settings.json`:

```json
{
  "backend": { "default": "claude-code", "fallback": "codex" },
  "prune": { "maxInactiveDays": 14 }
}
```

### 5. Build the sandbox

```bash
AVA_REPO_URL=git@github.com:actualvoice/acav.git \
AVA_DATA_DIR="$(pwd)/data" \
  bash scripts/setup-sandbox.sh
```

This creates the `ava-sandbox` Docker container, preinstalls the three
agent CLIs, and bare-clones the ActualVoice repo into `./data/repo.git`.

On Fedora, SELinux `:Z` flags are set on every bind mount; on other
Linux distros the flag is a no-op.

### 6. Run Ava

```bash
ava --data-dir ./data --sandbox=docker:ava-sandbox
```

Ava will poll Gmail every 30 seconds and process allowlisted threads.
Ctrl-C to stop; in-flight threads finish first.

## Operations

- **Pause Ava**: Ctrl-C. Gmail queue builds up; resume anytime.
- **Force a specific backend**: include `@ava:use=codex` (or `claude-code` / `pi`) anywhere in the email body.
- **Refresh auth**: re-run `claude login` / `codex login` / `pi --login` on the host; no sandbox restart needed.
- **Clear a thread's state**: delete `./data/threads/<thread-id>/` (keeps branch in `repo.git`).
