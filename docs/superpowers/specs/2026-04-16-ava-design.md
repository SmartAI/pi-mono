# Ava — Email-driven AI teammate for ActualVoice

**Status:** design, 2026-04-16
**Authors:** Max Liu, with Claude
**Package:** `@actualvoice/ava` (new, under `packages/ava` in the pi-mono monorepo)

## 1. Purpose

Ava is an LLM-powered teammate that Max and Brian can reach over email at `claude@actualvoice.ai`. She handles development, testing, bug fixes, frontend, and design work for the ActualVoice product. Every thread is a task; Ava replies with results, diffs, screenshots, and PR links.

Ava is a fork of the architecture proven in [`@mariozechner/pi-mom`](../../../packages/mom/README.md), with the Slack transport swapped for Gmail. Everything else — the self-managing agent loop, sandboxed tool execution, per-conversation state, skill system, and memory — is inherited.

## 2. Scope

### In scope (v1)
- Inbound email via Gmail API, allowlisted to Max's and Brian's verified addresses only.
- One Gmail thread = one Ava "channel" with persistent state (conversation log, memory, worktree).
- Clone-and-branch workflow against the ActualVoice GitHub repo: Ava creates branches, pushes commits, opens PRs. Humans merge.
- Sandboxed tool execution in a Docker container on Max's Fedora laptop. Bind-mounts use SELinux `:Z` relabel flag.
- Two-email reply model per request: instant ack ("on it") + final reply with results.
- Sequential execution per thread; cross-thread serialization is single-process sequential in v1.
- LLM access via Claude Opus 4.7 over pi-coding-agent's OAuth `auth.json` (Max has no Anthropic API key, only subscription access).
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
│  │         │          ┌────────────────────┐     │      │
│  │         │          │ Agent runner       │     │      │
│  │         │          │ (pi-agent-core)    │     │      │
│  │         │          └─────────┬──────────┘     │      │
│  │         │                    ▼                │      │
│  │         │     ┌─────────────────────────┐     │      │
│  │         │     │ Tools: bash, read,      │     │      │
│  │         │     │ write, edit, attach     │     │      │
│  │         │     └─────────────┬───────────┘     │      │
│  │         ▼                   ▼                 │      │
│  │  ┌──────────────────────────────────────┐     │      │
│  │  │ Gmail sender (API) — ack + replies   │     │      │
│  │  └──────────────────────────────────────┘     │      │
│  └──────────────────┬────────────────────────────┘      │
│                     │ docker exec                       │
│  ┌──────────────────▼────────────────────────────┐      │
│  │  ava-sandbox (Alpine container)               │      │
│  │  /workspace/                                  │      │
│  │    repo.git/                (shared bare)     │      │
│  │    threads/<thread-id>/                       │      │
│  │      worktree/             (git worktree)     │      │
│  │      scratch/              (temp files)       │      │
│  │    skills/                  (gh, gmail, etc.) │      │
│  └───────────────────────────────────────────────┘      │
│                                                         │
│  ./data/ (host-mounted into container with :Z)          │
│    MEMORY.md                         (global)           │
│    allowlist.json                    (Max + Brian)      │
│    settings.json                     (prune days, etc.) │
│    auth.json                         (Anthropic/Claude) │
│    gmail-token.json                  (OAuth refresh)    │
│    threads/<thread-id>/                                 │
│      log.jsonl, context.jsonl, MEMORY.md,               │
│      attachments/, outgoing/, .lock,                    │
│      last-seen-msg-id                                   │
└─────────────────────────────────────────────────────────┘
```

### Process boundaries

- **Host process**: the Node app running `ava`. Owns Gmail API access, dispatcher queue, filesystem state under `./data/`.
- **Sandbox container**: Alpine Linux, started and managed by the host process via `docker exec`. Owns the bare repo, all worktrees, and any tools the agent installs. The container mount point `/workspace` is the same directory as the host's `./data/`, with SELinux relabeled via `:Z`.
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

### 4.4 `agent.ts` — agent runner

Lightly adapted from `packages/mom/src/agent.ts`.

- Sync `log.jsonl` → `context.jsonl` (unchanged logic).
- Load memory: global `./data/MEMORY.md` + thread-specific `threads/<tid>/MEMORY.md`.
- Build LLM conversation: system prompt + memory + context messages.
- Run the pi-agent-core loop with our tool set.
- On run completion, write Ava's final reply to `log.jsonl` and hand it to `gmail.sendReply`.
- On rate-limit (429) from pi-ai:
  - Pause the run, persist current state.
  - If no rate-limit email has been sent for the current inbound message yet, send a one-time status email (`"hit Claude quota, resuming at <time> — I'll continue this thread automatically"`). "Current inbound message" is scoped per user message, not per thread: each new email from Max/Brian resets the counter.
  - Schedule a resume after `retry-after`; dispatcher re-picks up the thread.
  - Subsequent rate-limit hits while processing the same inbound message: silent backoff, no additional emails.
- On auth failure (invalid `auth.json`), send one email per thread in flight: `"My Claude auth is broken. Max/Brian: re-run pi-coding-agent /login, then link auth.json. I'll retry on my own after that."` Stop the run; do not retry until the file mtime changes.

### 4.5 `sandbox.ts` — Docker sandbox adapter

Adapted from `packages/mom/src/sandbox.ts`, with the Fedora/SELinux fix baked in.

- All tool calls (`bash`, `read`, `write`, `edit`) go through `docker exec ava-sandbox <cmd>`.
- Setup script (`scripts/setup-sandbox.sh`) creates the container with:
  ```
  docker run -d --name ava-sandbox \
      -v "$(pwd)/data:/workspace:Z" \
      alpine:latest tail -f /dev/null
  ```
  The `:Z` flag is mandatory on Fedora — without it, SELinux blocks the mount and all file I/O from the container returns EPERM. A `podman` alternative is documented for users who prefer Fedora's native tooling.
- Preseeds inside the container: `apk add git github-cli nodejs npm jq curl`.
- Preseeds the bare repo: `git clone --bare https://github.com/<actualvoice-org>/<repo>.git /workspace/repo.git`.
- `gh auth login --with-token` using a dedicated Ava GitHub token (scoped to `repo` + `workflow` if Ava should read CI results).

### 4.6 `worktree.ts` — git worktree manager

New. Implements Approach 2 from the brainstorm: one shared bare repo, per-thread worktrees.

- `ensureWorktree(threadId)`:
  - If worktree dir exists, `git -C worktree status` and reuse.
  - Otherwise, `git -C repo.git worktree add /workspace/threads/<tid>/worktree ava/<tid-short>` where `<tid-short>` is the first 8 chars of the thread id.
  - Returns the absolute worktree path; the agent prompt references it so Ava knows her working directory.
- `fetch()`: periodic `git -C repo.git fetch --prune --all` (default every 10 minutes, configurable). Keeps all branches up to date without any per-worktree action.
- `cleanupThread(threadId)`: `git -C repo.git worktree remove --force threads/<tid>/worktree`. Does NOT delete the branch in the bare repo or any remote branch. Does NOT delete `log.jsonl`, `MEMORY.md`, or `attachments/`.
- `prune(maxInactiveDays=14)`: sweep at startup + every 24h. For each `threads/<tid>/`, if `log.jsonl`'s last entry is older than `maxInactiveDays` AND a worktree exists, call `cleanupThread`. On a later reply in that thread, `ensureWorktree` re-creates it from the persisted branch.

### 4.7 `src/tools/` — tool implementations

Lifted from pi-mom with minimal changes:
- `bash.ts`, `read.ts`, `write.ts`, `edit.ts`: unchanged in logic; they call through `sandbox.ts`.
- `attach.ts`: writes to `threads/<tid>/outgoing/<filename>` instead of invoking Slack's upload endpoint. `gmail.sendReply` picks up everything in `outgoing/` as attachments after the run completes, enforces the 20 MB cap, and links overflow files to PR artifacts instead of attaching.

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

T=30s  agent.ts starts the Ava run for this thread:
       1. worktree.ensureWorktree(tid)
       2. sync log.jsonl → context.jsonl
       3. load global + thread MEMORY.md
       4. LLM sees system prompt + memories + Brian's message
       5. LLM calls tools: grep, read, edit, screenshot,
          git commit, push, gh pr create, attach screenshots
       6. LLM emits final text reply

T=~3m  gmail.sendReply(tid, replyBody, [before.png, after.png])
       Brian receives the real reply, threaded with the ack.

T=later  Brian replies: "the after screenshot is cropped, retake it"
         → gmail.poll() picks up the new message in the same thread
         → appended to existing log.jsonl for tid
         → dispatcher enqueues tid again
         → ack → agent run resumes with full context
           (worktree still there, branch unchanged — PR gets a new
            commit, reply gets a new screenshot)
```

### Specific data decisions

- **Reply body**: markdown-ish plaintext only. No HTML. Code fences, bulleted test output. Long bash output truncated with `[... N lines omitted ...]`.
- **Attachments**: 20 MB soft cap per reply. Overflow is pushed to the PR (as a committed file or a release artifact) and linked.
- **Deduplication**: Gmail `Message-Id` is the unique key in `log.jsonl`. Re-runs after a crash won't double-process.
- **Quoted-history stripping**: inbound body strips everything below `^On .* wrote:$` and similar variants before the LLM sees it.
- **Worktree restart**: on crash recovery, agent's first tool call in a resumed run is `git status` in the worktree.

## 6. Error handling

See Section 4.4 for LLM rate-limit and auth-failure flows.

**Gmail errors:**
- Poll API error → exponential backoff 30s → 60s → 2m → 5m cap; console-log only.
- OAuth access-token expired → auto-refresh.
- OAuth refresh-token invalid → stop polling, print recovery instructions to console. No email path available.
- Send failure → retry 3x with backoff, then persist to `threads/<tid>/pending-replies/` and retry on next poll tick.

**Sandbox / Docker errors:**
- Container stopped → `main.ts` starts it.
- Container missing entirely → exit with clear error, no Gmail polling.
- Tool call nonzero exit → normal; result returns to the LLM.
- OOM / kill → reply `"Sandbox crashed mid-task. Logs at: ./data/threads/<tid>/crash.log. Reply to retry."` then exit the run.

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
- `agent.reply-format.test.ts`: LLM-text-to-email-body normalizer (code fences, truncation, Unicode).

No mocked-LLM tests; pi-agent-core already covers that surface.

### Tier 2 — integration tests (`test/integration/`, manual, not in CI)
- `gmail-roundtrip.ts`: real email round-trip using a second Gmail OAuth credential. Sends from test account, waits for ack and final reply, asserts threading headers. Tagged `@real-gmail`.
- `sandbox-smoke.ts`: stands up `ava-sandbox` on the Fedora host, validates `:Z` mount, runs `ensureWorktree` against a disposable GitHub fixture repo, pushes and deletes a throwaway branch. Tagged `@real-docker`. Run once after setup and after any infra change.

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
