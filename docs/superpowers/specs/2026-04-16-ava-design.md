# Ava — Email-driven AI teammate for ActualVoice

**Status:** design, 2026-04-16
**Authors:** Max Liu, with Claude
**Package:** `@actualvoice/ava` (new, under `packages/ava` in the pi-mono monorepo)

## 1. Purpose

Ava is an LLM-powered teammate that Max and Brian can reach over email at `claude@actualvoice.ai`. She handles development, testing, bug fixes, frontend, and design work for the ActualVoice product. Every thread is a task; Ava replies with results, diffs, screenshots, and PR links.

Ava is a fork of the architecture proven in [`@mariozechner/pi-mom`](../../../packages/mom/README.md) — with two structural differences: the Slack transport is swapped for Gmail, and the agent loop itself is delegated to the `pi` CLI (pi-coding-agent) via subprocess invocation with per-thread session files. Ava's own code is deliberately small: Gmail transport, allowlist, dispatcher, sandbox glue, worktree management, and an attachment-collection convention.

## 2. Scope

### In scope (v1)
- Inbound email via Gmail API, allowlisted to Max's and Brian's verified addresses only.
- One Gmail thread = one Ava "channel" with persistent state (conversation log, memory, worktree).
- Clone-and-branch workflow against the ActualVoice GitHub repo: Ava creates branches, pushes commits, opens PRs. Humans merge.
- Sandboxed tool execution in a Docker container on Max's Fedora laptop. Bind-mounts use SELinux `:Z` relabel flag.
- Two-email reply model per request: instant ack ("on it") + final reply with results.
- Sequential execution per thread; cross-thread serialization is single-process sequential in v1.
- LLM access via Claude Opus 4.7 over pi-coding-agent's OAuth `auth.json` (Max has no Anthropic API key, only subscription access).
- Agent execution delegated to pi-coding-agent (`pi` CLI) as a subprocess, one process per email run, with per-thread session files (`threads/<tid>/session.jsonl`) passed via `--session`. Ava does NOT re-implement the agent loop.
- Auto-prune of inactive thread worktrees after 14 days; `log.jsonl` and memory retained indefinitely.

### Explicitly out of scope (v1)
- Auto-merge, auto-deploy, or any action that skips human review of code changes.
- Scheduled wake-ups / cron events (pi-mom has these; port later if needed).
- Web dashboard, artifacts server, progress streaming beyond the two emails.
- Multi-transport abstraction. If a second transport ever appears, we refactor then.
- Cross-provider LLM fallback. Claude-only in v1.
- Load testing, horizontal scaling. Two users on one laptop.

## 3. High-level architecture

```
┌─────────────────────────────────────────────────────────┐
│  Host machine (Max's Fedora laptop)                     │
│  ┌───────────────────────────────────────────────┐      │
│  │  ava (Node process)                           │      │
│  │  ┌──────────────┐    ┌────────────────────┐   │      │
│  │  │ Gmail poller │──▶ │ Thread dispatcher  │   │      │
│  │  │ (30s tick)   │    │ (per-thread queue) │   │      │
│  │  └──────┬───────┘    └─────────┬──────────┘   │      │
│  │         │                      ▼              │      │
│  │         │        ┌──────────────────────────┐ │      │
│  │         │        │ pi-invoker               │ │      │
│  │         │        │ spawns `pi` subprocess   │ │      │
│  │         │        │ with --session <file>    │ │      │
│  │         │        └───────────┬──────────────┘ │      │
│  │         ▼                    ▼                │      │
│  │  ┌──────────────────────────────────────┐     │      │
│  │  │ Gmail sender (API) — ack + replies   │     │      │
│  │  └──────────────────────────────────────┘     │      │
│  └──────────────────┬────────────────────────────┘      │
│                     │ docker exec pi ...                │
│  ┌──────────────────▼────────────────────────────┐      │
│  │  ava-sandbox (Alpine container)               │      │
│  │  + pi-coding-agent CLI (`pi`) preinstalled    │      │
│  │  /workspace/                                  │      │
│  │    repo.git/                (shared bare)     │      │
│  │    threads/<thread-id>/                       │      │
│  │      session.jsonl         (pi session)       │      │
│  │      worktree/             (git worktree)     │      │
│  │      scratch/              (temp files)       │      │
│  │      outgoing/             (email attachments)│      │
│  │    skills/                  (gh, etc.)        │      │
│  └───────────────────────────────────────────────┘      │
│                                                         │
│  ./data/ (host-mounted into container with :Z)          │
│    MEMORY.md                         (global)           │
│    allowlist.json                    (Max + Brian)      │
│    settings.json                     (prune days, etc.) │
│    auth.json                         (pi OAuth)         │
│    gmail-token.json                  (OAuth refresh)    │
│    threads/<thread-id>/                                 │
│      log.jsonl        (email transport log only)        │
│      session.jsonl    (owned by pi-coding-agent)        │
│      MEMORY.md, attachments/, outgoing/, .lock,         │
│      last-seen-msg-id                                   │
└─────────────────────────────────────────────────────────┘
```

### Process boundaries

- **Host process**: the Node app running `ava`. Owns Gmail API access, dispatcher queue, filesystem state under `./data/`, and spawning the `pi` subprocess via `docker exec`. Does not run the agent loop itself.
- **Sandbox container**: Alpine Linux with `pi-coding-agent` preinstalled. Started and managed by the host process. Owns the bare repo, all worktrees, and anything pi installs while working. The container mount point `/workspace` is the same directory as the host's `./data/`, with SELinux relabeled via `:Z`.
- **pi subprocess**: the actual agent, invoked once per run with `--session <thread-session-file>`. Handles tool calls, LLM conversation, 429 backoff, and context compaction.
- **Gmail API**: external. OAuth token refresh is automatic; refresh token lives in `./data/gmail-token.json`.
- **GitHub**: external. `gh` CLI is installed inside the container and authenticated once on setup; token lives in the container filesystem, not on the host.

## 4. Components

Each component is one source file in `packages/ava/src/`.

### 4.1 `main.ts` — entry point

Adapted from `packages/mom/src/main.ts`.

Responsibilities:
- Parse CLI: `ava --sandbox=docker:ava-sandbox --data-dir ./data`.
- Load `allowlist.json` and `settings.json`.
- Verify Docker sandbox is running (start it if not; exit with a clear error if the container is missing entirely).
- Verify `auth.json` (pi OAuth) exists and is readable; otherwise print setup instructions and exit.
- Start the Gmail poller, wire it to the dispatcher, wait on `SIGTERM` for graceful shutdown.
- On shutdown: drain dispatcher queue, flush in-flight replies to disk, release any filesystem locks.

### 4.2 `gmail.ts` — Gmail transport

New, replaces pi-mom's `src/slack.ts`.

Responsibilities:
- **First-run OAuth flow**: print auth URL, accept pasted code, write refresh token to `./data/gmail-token.json`. Uses the same installed-app flow Gmail API supports.
- **`poll()`**: runs every 30 seconds. Query: `is:unread newer_than:7d -in:sent -from:claude@actualvoice.ai`. For each new message:
  - Extract Gmail `Message-Id`. If already in any thread's `log.jsonl`, skip (idempotency).
  - Parse into `{threadId, from, dkimResult, spfResult, subject, bodyText, attachments[]}`.
  - Enforce allowlist: `from` must be in `allowlist.json` AND `dkimResult === 'pass'` AND `spfResult === 'pass'`. Rejects are logged and no-op'd (no reply to strangers). If the allowlist reason is "DKIM/SPF fail on allowlisted sender," log loudly — this is a spoofing attempt worth seeing.
  - Strip quoted history from `bodyText` using common reply markers (`^On .* wrote:$`, `>`-prefixed lines at the bottom, known client banners).
  - Download attachments to `./data/threads/<threadId>/attachments/<msg-id>/<filename>`.
  - Append the parsed message to `./data/threads/<threadId>/log.jsonl`.
  - Mark message as read (or remove the unread label — equivalent in Gmail API).
  - Enqueue `threadId` on the dispatcher.
- **`sendAck(threadId, toAddress, originalMessageId)`**: sends the canned ack. Sets `In-Reply-To` and `References` headers so Gmail keeps threading.
- **`sendReply(threadId, toAddress, body, attachments[], inReplyToMessageId)`**: sends the real reply. Same threading headers. Enforces 20 MB attachment budget (Gmail's hard cap is 25 MB).
- Token refresh is automatic; on refresh-token invalidation, the poller stops and the error is logged. No emails can be sent in that state, so there is no email-based recovery path — only console output.

### 4.3 `dispatcher.ts` — per-thread queue

New.

- Map `threadId → Queue`. Each queue serializes Ava runs for that thread.
- `enqueue(threadId)` is idempotent — if a run is already scheduled or in progress, nothing happens; the newly-appended `log.jsonl` entries will be picked up by the in-progress run via the next sync point (same behavior as mom).
- Cross-thread execution is **sequential** in v1 (single worker). Rationale: predictable laptop resource usage while dogfooding. Easy to lift to a worker pool later.
- Uses a filesystem lock (`threads/<tid>/.lock` via `flock`) as a crash-safety backstop in addition to the in-memory map. On restart, any stale lock whose owning PID no longer exists is reclaimed.

### 4.4 `pi-invoker.ts` — agent runner (spawns `pi` with session reuse)

**New approach — not a hand-rolled agent loop.** Ava does not re-implement the agent loop the way pi-mom does. Instead, she spawns the `pi` (pi-coding-agent) CLI as a subprocess per run, with `--session <path>` pointing at a per-thread session file. pi owns the agent loop, tool set, context compaction, retry/backoff, and session persistence. Ava owns the email transport, allowlist, dispatcher, sandbox, worktree, and outgoing-attachment collection.

**Why this works:**
- pi-coding-agent already has first-class session reuse: `--session <path|uuid>` resumes exactly where the previous invocation left off, with tree-structured history, auto-compaction, and crash-safe JSONL persistence.
- Session files live under `threads/<tid>/session.jsonl`, one per Gmail thread. A follow-up email in the same thread resumes that exact session — pi sees the full prior conversation without Ava rebuilding anything.
- Max's Claude auth works transparently: `pi` inside the sandbox reads `/workspace/auth.json` (mounted from host `./data/auth.json`, itself a symlink to `~/.pi/agent/auth.json`).
- Rate-limit handling, 429 backoff, and context compaction are all pi's responsibility — code Ava does not have to write or maintain.

**Per-run flow:**
1. Read the newest inbound messages from `threads/<tid>/log.jsonl` that haven't been fed to pi yet.
2. Build a prompt that includes: the new email body, sender, subject, worktree path, and thread-memory hints if present. If this is the first pi invocation for the session, also include global and thread-specific `MEMORY.md`. pi's own system prompt and configured skills handle everything else.
3. Spawn inside the sandbox:
   ```
   docker exec -i ava-sandbox pi \
       --session /workspace/threads/<tid>/session.jsonl \
       --cwd /workspace/threads/<tid>/worktree \
       --no-context-files \
       -p "<prompt>"
   ```
   `-p` is pi's non-interactive "print" mode. `--no-context-files` is used because Ava injects the memory explicitly and does not want pi auto-loading host-level context. `--cwd` anchors pi at the per-thread worktree.
4. Capture pi's stdout (the final text response) and stderr. Exit code 0 = success.
5. Gather any files that pi wrote to `threads/<tid>/outgoing/` during the run and hand them, with the stdout text, to `gmail.sendReply`.
6. Append the outbound reply metadata (Message-Id, timestamp, attachment list) to `log.jsonl`.

**Error handling — exit codes and stderr patterns:**
- **Exit 0**: normal completion. Reply is stdout.
- **Rate-limit pattern in stderr** (detected by regex on known pi-ai 429 wording): apply the same behavior as before — first hit for the current inbound message triggers a one-time status email (`"hit Claude quota, resuming at <time> — I'll continue this thread automatically"`); subsequent hits are silent. Re-spawn the same `pi --session ...` after the retry-after window; the session file guarantees no lost progress.
- **Auth-failure pattern in stderr**: send one email per thread in flight: `"My Claude auth is broken. Max/Brian: re-run pi-coding-agent /login, then link auth.json. I'll retry on my own after that."` Stop the run; do not retry until `auth.json` mtime changes.
- **Any other nonzero exit**: capture stdout+stderr to `threads/<tid>/crash.log`, send a reply saying `"pi subprocess exited <code>. Logs at crash.log. Reply to retry."` — the next reply re-enqueues the thread; pi's session file contains whatever pi managed to persist before the crash.

**Sending tool and message interception:**
For v1 Ava does NOT intercept pi's tool calls. Email attachments happen via a simple convention: any file pi writes to the thread's `outgoing/` directory during the run gets attached to the reply. If in v2 we need fancier behavior (progress streaming, custom attach tool), we can either move to SDK-embed (Approach Y from brainstorm) or add a pi extension.

### 4.5 `sandbox.ts` — Docker sandbox adapter

Adapted from `packages/mom/src/sandbox.ts`, with the Fedora/SELinux fix and pi-coding-agent preinstalled.

- The sandbox is where `pi` runs. Ava's host process only reaches in via `docker exec` to launch `pi` and to perform a few host-side git operations on the bare repo (fetch, worktree add).
- Setup script (`scripts/setup-sandbox.sh`) creates the container with:
  ```
  docker run -d --name ava-sandbox \
      -v "$(pwd)/data:/workspace:Z" \
      alpine:latest tail -f /dev/null
  ```
  The `:Z` flag is mandatory on Fedora — without it, SELinux blocks the mount and all file I/O from the container returns EPERM. A `podman` alternative is documented for users who prefer Fedora's native tooling.
- Preseeds inside the container:
  - `apk add git github-cli nodejs npm jq curl chromium` (chromium for any screenshot skill pi might use).
  - `npm install -g @mariozechner/pi-coding-agent` — this is the key step; after it `pi` is on `$PATH`.
  - `ln -s /workspace/auth.json /root/.pi/agent/auth.json` so `pi` finds the OAuth credentials.
  - `git clone --bare https://github.com/<actualvoice-org>/<repo>.git /workspace/repo.git`.
  - `gh auth login --with-token` using a dedicated Ava GitHub token (scoped to `repo` + `workflow` if Ava should read CI results).
- There is no pi-mom-style tool-layer adapter inside Ava itself — pi ships its own `Bash`, `Read`, `Edit`, `Write`, etc. Ava's only sandbox responsibility is spawning `pi` and performing the handful of host-side git operations noted below.

### 4.6 `worktree.ts` — git worktree manager

New. Implements Approach 2 from the brainstorm: one shared bare repo, per-thread worktrees.

- `ensureWorktree(threadId)`:
  - If worktree dir exists, `git -C worktree status` and reuse.
  - Otherwise, `git -C repo.git worktree add /workspace/threads/<tid>/worktree ava/<tid-short>` where `<tid-short>` is the first 8 chars of the thread id.
  - Returns the absolute worktree path; the agent prompt references it so Ava knows her working directory.
- `fetch()`: periodic `git -C repo.git fetch --prune --all` (default every 10 minutes, configurable). Keeps all branches up to date without any per-worktree action.
- `cleanupThread(threadId)`: `git -C repo.git worktree remove --force threads/<tid>/worktree`. Does NOT delete the branch in the bare repo or any remote branch. Does NOT delete `log.jsonl`, `MEMORY.md`, or `attachments/`.
- `prune(maxInactiveDays=14)`: sweep at startup + every 24h. For each `threads/<tid>/`, if `log.jsonl`'s last entry is older than `maxInactiveDays` AND a worktree exists, call `cleanupThread`. On a later reply in that thread, `ensureWorktree` re-creates it from the persisted branch.

### 4.7 Attachments — convention over code

Ava does **not** ship a custom tool layer. pi-coding-agent already provides `Bash`, `Read`, `Write`, `Edit`, etc. Email-specific behavior is handled by convention instead of code:

- Ava's prompt to pi includes: *"Files you want attached to your email reply should be written to `./outgoing/` under the current working directory. Keep total size under 20 MB; larger artifacts should go into the PR instead."*
- After `pi` exits, Ava scans `threads/<tid>/outgoing/` and attaches every file to the Gmail reply. Enforces the 20 MB cap; overflow is linked to the PR instead.
- On next run for the same thread, `outgoing/` is cleared before `pi` starts so stale attachments don't leak into later replies.

This keeps the integration surface tiny and defers the "do we need a custom attach tool" question to v2.

## 5. Data flow — canonical request

```
T=0    Brian sends: "Ava, login form on /signup has a typo
                     in the password validation message. fix it.
                     take a screenshot of before/after."
       From: brian@actualvoice.ai   To: claude@actualvoice.ai
       Subject: typo on signup password validation

T=0–30s  gmail.poll() finds the new message.
         → DKIM=pass, From is in allowlist → accept
         → new thread id, create ./data/threads/<tid>/
         → append parsed message to log.jsonl
         → dispatcher enqueues tid

T=30s  dispatcher picks up tid, calls gmail.sendAck(tid)
       → Brian receives: "On it. I'll reply when done. — Ava"

T=30s  pi-invoker starts the Ava run for this thread:
       1. worktree.ensureWorktree(tid)
       2. clear threads/<tid>/outgoing/
       3. build prompt (email body + sender + worktree path +
          memory hints on first run)
       4. docker exec pi --session threads/<tid>/session.jsonl
          --cwd /workspace/threads/<tid>/worktree -p "<prompt>"
       5. pi runs its own agent loop: grep, read, edit, run
          dev server, screenshot, git commit+push, gh pr create,
          writes before.png + after.png to ./outgoing/
       6. pi exits 0, stdout is the final text reply

T=~3m  gmail.sendReply(tid, stdoutText, [before.png, after.png])
       Brian receives the real reply, threaded with the ack.

T=later  Brian replies: "the after screenshot is cropped, retake it"
         → gmail.poll() picks up the new message in the same thread
         → appended to existing log.jsonl for tid
         → dispatcher enqueues tid again
         → ack → pi is re-invoked with the SAME --session file, so
           it already knows the PR, the branch, what screenshots it
           took, and why. A new commit lands on the branch, the PR
           picks it up, a new screenshot is attached.
           (worktree still there, branch unchanged — PR gets a new
            commit, reply gets a new screenshot)
```

### Specific data decisions

- **Reply body**: markdown-ish plaintext only. No HTML. Ava passes pi's stdout through a normalizer that enforces code fences, truncates very long sections, and strips ANSI escapes.
- **Attachments**: 20 MB soft cap per reply. Everything in `threads/<tid>/outgoing/` is attached; overflow is pushed to the PR and linked.
- **Deduplication**: Gmail `Message-Id` is the unique key in `log.jsonl`. Re-runs after a crash won't double-process.
- **Quoted-history stripping**: inbound body strips everything below `^On .* wrote:$` and similar variants before it's built into the pi prompt.
- **Session vs log**: `log.jsonl` is Ava's email transport log (what came in, what went out, with headers and metadata). `session.jsonl` is pi's agent session (conversation, tool calls, results). Keeping them separate means a log corruption doesn't destroy the agent's memory, and vice versa.
- **Worktree restart**: on crash recovery, pi's first action in a resumed session is already to orient itself (it has `git status` as a tool). No Ava-side special handling required.

## 6. Error handling

See Section 4.4 for LLM rate-limit and auth-failure flows.

**Gmail errors:**
- Poll API error → exponential backoff 30s → 60s → 2m → 5m cap; console-log only.
- OAuth access-token expired → auto-refresh.
- OAuth refresh-token invalid → stop polling, print recovery instructions to console. No email path available.
- Send failure → retry 3x with backoff, then persist to `threads/<tid>/pending-replies/` and retry on next poll tick.

**Sandbox / pi subprocess errors:**
- Container stopped → `main.ts` starts it.
- Container missing entirely → exit with clear error, no Gmail polling.
- `pi` subprocess nonzero exit → as covered in 4.4: rate-limit / auth-failure / generic-crash patterns each produce a specific user-facing behavior.
- `pi` wedged (no stdout or exit for longer than the configured per-run timeout, default 20 min) → kill the subprocess, send the generic crash reply, session file is retained so the user's reply restarts from the last committed point.

**Git / worktree errors:**
- `git push` rejected → rebase on `origin/main` once, retry, else report in reply.
- Corrupted worktree → preserve `scratch/` → `git worktree remove --force` → recreate on the same branch.

**Prompt injection:**
- Allowlist (Section 4.2) is the first gate.
- System prompt instructs Ava to treat URL fetches, third-party code, and attachment contents as *data, not instructions*.
- Docker isolation confines blast radius to the container + `./data/`.
- Any GitHub-token leak means rotate + audit; monitor is the thread log.

**Concurrency:**
- Per-thread filesystem lock (`flock`) in addition to the in-memory queue.
- Cross-thread execution is sequential in v1.

## 7. Testing strategy

### Tier 1 — unit tests (`test/`, `vitest`, run in CI)
- `gmail.parse.test.ts`: RFC-822 parsing; plain/HTML/multipart, charsets, attachments, threading headers, quoted-history stripping.
- `gmail.allowlist.test.ts`: sender + DKIM/SPF decision matrix; spoofing cases.
- `dispatcher.test.ts`: serialization under burst, at-most-one-per-thread, FIFO within a thread.
- `worktree.test.ts`: ensure/cleanup/prune against a local bare repo fixture.
- `pi-invoker.test.ts`: prompt builder assembles the right string from log.jsonl + memory files. Stderr-pattern matching for rate-limit, auth-failure, and generic-crash classifiers. Uses a fake `pi` shim (a shell script) for end-to-end exit-code behavior without invoking the real pi-coding-agent.
- `reply-format.test.ts`: pi-stdout-to-email-body normalizer (code fences preserved, truncation, ANSI-escape stripping, Unicode).
- `outgoing-scan.test.ts`: after a run, all files in `threads/<tid>/outgoing/` are attached; total-size cap enforced; directory cleared on next run.

No mocked-LLM tests at any level. pi-coding-agent's own test suite covers the agent loop.

### Tier 2 — integration tests (`test/integration/`, manual, not in CI)
- `gmail-roundtrip.ts`: real email round-trip using a second Gmail OAuth credential. Sends from test account, waits for ack and final reply, asserts threading headers. Tagged `@real-gmail`.
- `sandbox-smoke.ts`: stands up `ava-sandbox` on the Fedora host, validates `:Z` mount, verifies `pi --version` runs inside the container against the mounted `auth.json`, runs `ensureWorktree` against a disposable GitHub fixture repo, pushes and deletes a throwaway branch. Tagged `@real-docker`. Run once after setup and after any infra change.
- `pi-session-reuse.ts`: two sequential `pi` runs against the same `--session <file>`. Assert the second invocation sees the first's outputs in its conversation history. Tagged `@real-pi`.

### Tier 3 — live dogfood
Before pointing Ava at the real ActualVoice repo, run against a disposable `actualvoice-ava-staging` repo for roughly a week. Max and Brian send 5–10 tasks per day. Tune system prompt and `MEMORY.md` based on observed failures.

### Ship criteria for v1
1. All Tier-1 tests green via `npm run check` + `vitest run`.
2. Tier-2 smoke tests both pass on the Fedora host.
3. Tier-3 dogfood week completes with no showstopper, where a showstopper is:
   - Ava silently loses a task.
   - Ava exfiltrates a secret.
   - Ava pushes to a branch she wasn't authorized to write to.

## 8. Open questions (intentionally deferred)

These are known gaps that v1 does **not** address. They're tracked here so future iterations can pick them up with context:

- **Scheduled wake-ups**: pi-mom's events system would let Ava run a nightly test suite or a weekly dependency bump. Good v2 candidate.
- **Artifacts server / dashboard**: replacement for "screenshots via email" when an HTML visualization is a better deliverable.
- **Multi-tenant / team-scaling**: if ActualVoice grows past the two of you, the strict allowlist becomes a bottleneck. The natural next step is Approach 4B from brainstorm (domain allowlist with CC context).
- **Cross-provider fallback**: if Claude quota is a real operational constraint, pi-ai supports swapping to another provider. Not needed at current usage levels.
