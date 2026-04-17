# Ava — Email-driven AI teammate for ActualVoice

**Status:** design, 2026-04-16
**Authors:** Max Liu, with Claude
**Package:** `@actualvoice/ava` (new, under `packages/ava` in the pi-mono monorepo)

## 1. Purpose

Ava is an LLM-powered teammate that Max and Brian can reach over email at `claude@actualvoice.ai`. She handles development, testing, bug fixes, frontend, and design work for the ActualVoice product. Every thread is a task; Ava replies with results, diffs, screenshots, and PR links.

Ava is a fork of the architecture proven in [`@mariozechner/pi-mom`](../../../packages/mom/README.md) — with two structural differences: the Slack transport is swapped for Gmail, and the agent loop itself is delegated to an official vendor CLI (either `claude` or `codex`) via subprocess invocation with per-thread session reuse. Ava's own code is deliberately small: Gmail transport, allowlist, dispatcher, sandbox glue, worktree management, backend selection, and an attachment-collection convention.

## 2. Scope

### In scope (v1)
- Inbound email via Gmail API, allowlisted to Max's and Brian's verified addresses only.
- One Gmail thread = one Ava "channel" with persistent state (conversation log, memory, worktree).
- Clone-and-branch workflow against the ActualVoice GitHub repo: Ava creates branches, pushes commits, opens PRs. Humans merge.
- Sandboxed tool execution in a Docker container on Max's Fedora laptop. Bind-mounts use SELinux `:Z` relabel flag.
- Two-email reply model per request: instant ack ("on it") + final reply with results.
- Sequential execution per thread; cross-thread serialization is single-process sequential in v1.
- LLM access via Max's **subscriptions** to Claude Code and Codex — no API keys. Agent execution delegated to subprocesses.
- Three pluggable backends, configured in `settings.json`:
  - `claude-code` — Anthropic's official `claude` CLI. TOS-safe (it's Anthropic's own app), uses Max's Claude Code subscription.
  - `codex` — OpenAI's official `codex` CLI. TOS-safe, uses Max's Codex/ChatGPT subscription; defaults to GPT-5.4.
  - `pi` — `@mariozechner/pi-coding-agent`. Max can opt in for extended features (skills tree, in-tree sessions, additional providers if an API key is ever added). **TOS caveat:** if pi is used with Anthropic OAuth, that path is less clearly sanctioned than calling `claude` directly — Max accepts the risk when he selects this backend on his own laptop.
- Settings pick a default backend and a fallback backend (e.g. default `claude-code`, fallback `codex`). Any backend not listed is still callable via the `@ava:use=<backend>` directive in the message body. Automatic failover on rate-limit.
- Per-thread session reuse handled by the backend itself (`claude --resume <id>`, Codex's equivalent). Ava persists only a session-id pointer file per thread per backend.
- Auto-prune of inactive thread worktrees after 14 days; `log.jsonl` and memory retained indefinitely.

### Explicitly out of scope (v1)
- Auto-merge, auto-deploy, or any action that skips human review of code changes.
- Scheduled wake-ups / cron events (pi-mom has these; port later if needed).
- Web dashboard, artifacts server, progress streaming beyond the two emails.
- Multi-transport abstraction. If a second transport ever appears, we refactor then.
- Backends beyond Claude Code and Codex in v1 (Gemini CLI, Ollama, etc. are v2 candidates; the backend interface is designed to accept them).
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
│  │         │        │ agent-invoker            │ │      │
│  │         │        │ spawns `claude`, `codex`,│ │      │
│  │         │        │ or `pi` (pluggable)      │ │      │
│  │         │        └───────────┬──────────────┘ │      │
│  │         ▼                    ▼                │      │
│  │  ┌──────────────────────────────────────┐     │      │
│  │  │ Gmail sender (API) — ack + replies   │     │      │
│  │  └──────────────────────────────────────┘     │      │
│  └──────────────────┬────────────────────────────┘      │
│                     │ docker exec (claude | codex | pi) │
│  ┌──────────────────▼────────────────────────────┐      │
│  │  ava-sandbox (Alpine container)               │      │
│  │  + `claude` (Claude Code) preinstalled        │      │
│  │  + `codex`  (OpenAI Codex) preinstalled       │      │
│  │  + `pi`     (pi-coding-agent) preinstalled    │      │
│  │  /home/ava/.claude   (host ~/.claude   ro)    │      │
│  │  /home/ava/.codex    (host ~/.codex    ro)    │      │
│  │  /home/ava/.pi       (host ~/.pi       ro)    │      │
│  │  /workspace/                                  │      │
│  │    repo.git/                (shared bare)     │      │
│  │    threads/<thread-id>/                       │      │
│  │      worktree/             (git worktree)     │      │
│  │      scratch/              (temp files)       │      │
│  │      outgoing/             (email attachments)│      │
│  │    skills/                  (gh, etc.)        │      │
│  └───────────────────────────────────────────────┘      │
│                                                         │
│  ./data/ (host-mounted into container with :Z)          │
│    MEMORY.md                         (global)           │
│    allowlist.json                    (Max + Brian)      │
│    settings.json       (backend default+fallback, etc.) │
│    gmail-token.json                  (Gmail OAuth)      │
│    threads/<thread-id>/                                 │
│      log.jsonl              (email transport log)       │
│      claude-session-id      (pointer, if ever used)     │
│      codex-session-id       (pointer, if ever used)     │
│      pi-session.jsonl       (inline, if ever used)      │
│      MEMORY.md, attachments/, outgoing/, .lock,         │
│      last-seen-msg-id, crash.log                        │
└─────────────────────────────────────────────────────────┘
```

### Process boundaries

- **Host process**: the Node app running `ava`. Owns Gmail API access, dispatcher queue, filesystem state under `./data/`, backend selection, and spawning the chosen agent CLI via `docker exec`. Does not run the agent loop itself.
- **Sandbox container**: Alpine Linux with both `claude` and `codex` preinstalled. Started and managed by the host process. Owns the bare repo, all worktrees, and anything the agent installs while working. `/workspace` mirrors host `./data/` with SELinux `:Z` relabeling; `~/.claude` and `~/.codex` from the host are mounted read-only so both CLIs find their OAuth credentials but can't write to them.
- **Agent subprocess** (`claude` or `codex`): the actual agent, invoked per run with backend-specific session resume flags. Handles tool calls, LLM conversation, rate-limit backoff, and context compaction.
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

### 4.4 `agent-invoker.ts` — pluggable backend runner

**Three pluggable backends, no hand-rolled agent loop.** Ava spawns an agent CLI as a subprocess per run. The backend is chosen per-run from:
- `claude-code` — Anthropic's official `claude` CLI.
- `codex` — OpenAI's official `codex` CLI.
- `pi` — `@mariozechner/pi-coding-agent`, opt-in for extended features (skill system, tree-structured sessions, additional providers).

The two official CLIs are the **TOS-safe default pair**. `pi` is available as an explicit opt-in for Max's own experimentation and for scenarios where pi's features are worth the caveat (its Anthropic OAuth reuse is on thinner TOS ice than `claude` itself).

**Why pluggable:**
- Using the official CLIs directly keeps Ava on sanctioned auth paths by default.
- Max has both Claude and Codex subscriptions. If one quota is exhausted, the other is a legitimate fallback.
- Each backend already has mature session reuse, non-interactive modes, and internal rate-limit/compaction handling — Ava doesn't re-implement any of it.
- Having `pi` available keeps the door open for its skill and extension ecosystem if/when Max decides to rely on them.

**Backend interface** (`Backend` in `src/backends/types.ts`):
```
interface Backend {
  name: "claude-code" | "codex" | "pi";
  // invoke the CLI for a single email run; returns exit code + captured stdout/stderr
  run(opts: {
    cwd: string;                   // worktree path inside the sandbox
    prompt: string;                // Ava-built prompt from log + memory
    sessionPointerFile: string;    // e.g. threads/<tid>/claude-session-id
    timeoutMs: number;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  // pattern classifier for exit-code analysis
  classifyFailure(exitCode: number, stderr: string): FailureKind;
}
type FailureKind = "ok" | "rate-limit" | "auth" | "crash";
```

**Claude Code backend (`src/backends/claude-code.ts`):**
- Command shape: `claude --resume "$(cat <sessionPointerFile>)" -p "<prompt>"` with `--cwd <cwd>`. On the very first invocation for a thread, there is no stored session id, so we instead invoke `claude -p "<prompt>" --cwd <cwd> --session-save <sessionPointerFile>` (where `--session-save` persists the new session's id to a file). Exact flag names will be verified against the installed Claude Code version during implementation; this spec commits to the behavior, not the precise flag.
- Auth: `claude` reads `~/.claude/` inside the sandbox. The host's `~/.claude/` is mounted read-only into the container at `/home/ava/.claude/`. Max runs `claude` locally once to authenticate; Ava reuses that credential.
- Classifier: stderr regex for Claude Code's 5-hour-quota error wording → `rate-limit`. Auth-expired wording → `auth`. Everything else nonzero → `crash`.

**Codex backend (`src/backends/codex.ts`):**
- Command shape: `codex resume --session "$(cat <sessionPointerFile>)" --cwd <cwd>` piping prompt on stdin, or the equivalent Codex non-interactive invocation. On first invocation: `codex` with `--session-save` analog. Flag names to be verified at implementation.
- Model selection: GPT-5.4 via Codex's model flag (Max's ChatGPT subscription grants access to whatever tier he's on).
- Auth: `codex` reads `~/.codex/` inside the sandbox. Host's `~/.codex/` is mounted read-only the same way as Claude Code's directory.
- Classifier: stderr regex for Codex's quota-exhausted wording → `rate-limit`. Auth wording → `auth`. Else → `crash`.

**pi backend (`src/backends/pi.ts`):**
- Command shape: `pi --session /workspace/threads/<tid>/pi-session.jsonl --cwd <cwd> --no-context-files -p "<prompt>"`. Unlike Claude/Codex, pi's session file is an in-tree JSONL that Ava stores under `./data/threads/<tid>/`, so there's no separate pointer file — the session path IS the pointer.
- Auth: `pi` reads `~/.pi/agent/auth.json` inside the sandbox. Host's `~/.pi/` is mounted read-only. Max authenticates pi once on the host with `pi --login`.
- Classifier: stderr regex for pi-ai 429 wording → `rate-limit`. Auth-invalid wording → `auth`. Else → `crash`.
- **TOS caveat recorded in `settings.json`:** choosing `pi` as the default or fallback backend produces a one-time warning in Ava's startup logs reminding Max of the risk. Never the default in the shipped config.

**Backend selection policy:**
- `settings.json` has `"backend": { "default": "claude-code", "fallback": "codex" }`.
- Per-email override: if an inbound message body contains `@ava:use=codex` (or `@ava:use=claude-code`), that run uses the specified backend. Useful for ad-hoc comparison.
- Automatic failover: if the default backend returns `rate-limit` AND `fallback` is configured, the SAME run retries immediately with the fallback backend. The session pointer is backend-scoped (`claude-session-id` vs `codex-session-id`) — they are independent histories, so the fallback starts "fresh" from the email prompt but with the same worktree state.

**Per-run flow:**
1. Read the newest inbound messages from `threads/<tid>/log.jsonl` that haven't been fed to the agent yet.
2. Build the prompt: new email body, sender, subject, worktree path, global + thread `MEMORY.md` contents on first run (later runs rely on the agent's own session memory).
3. Ensure `threads/<tid>/outgoing/` is empty.
4. Select backend per policy above.
5. Spawn inside the sandbox with `docker exec` + the selected backend's command shape.
6. Wait on exit with the configured timeout (default 20 min).
7. Classify the result. On `ok`, scan `outgoing/`, attach everything to the Gmail reply, send.
8. On `rate-limit`, apply the status-email rule (first hit per inbound message sends one email, subsequent hits silent) and either retry after the reported backoff or failover to the other backend.
9. On `auth`, send the one-time "my auth is broken" email scoped to the failing backend ("Max: re-run `claude` locally to refresh Claude Code auth, then I'll retry").
10. On `crash`, capture `threads/<tid>/crash.log` and send the generic "exited with code N — reply to retry" email.
11. Append outbound reply metadata (Message-Id, backend used, attachments) to `log.jsonl`.

**No tool interception in v1.** Attachments follow the `outgoing/` directory convention (Section 4.7). Fancier behavior is a v2 problem.

### 4.5 `sandbox.ts` — Docker sandbox adapter

Adapted from `packages/mom/src/sandbox.ts`, with the Fedora/SELinux fix and both agent CLIs preinstalled.

- The sandbox is where `claude` and `codex` run. Ava's host process only reaches in via `docker exec` to launch the chosen backend and to perform a few host-side git operations on the bare repo (fetch, worktree add).
- Setup script (`scripts/setup-sandbox.sh`) creates the container with:
  ```
  docker run -d --name ava-sandbox \
      -v "$(pwd)/data:/workspace:Z" \
      -v "$HOME/.claude:/home/ava/.claude:ro,Z" \
      -v "$HOME/.codex:/home/ava/.codex:ro,Z" \
      -v "$HOME/.pi:/home/ava/.pi:ro,Z" \
      alpine:latest tail -f /dev/null
  ```
  - The `:Z` flag is mandatory on Fedora; without it, SELinux blocks every bind-mount and all file I/O from the container returns EPERM. A `podman` alternative is documented for users who prefer Fedora's native tooling.
  - `~/.claude`, `~/.codex`, and `~/.pi` are all mounted **read-only** so the sandbox can read Max's existing credentials but cannot corrupt or rotate them. Max refreshes any credential by running the corresponding CLI directly on the host, outside the sandbox.
- Preseeds inside the container:
  - `apk add git github-cli nodejs npm jq curl chromium` (chromium for any screenshot skill the backend might use).
  - `npm install -g @anthropic-ai/claude-code` — installs the `claude` CLI.
  - Codex install (exact command depends on how OpenAI distributes the `codex` CLI — `npm install -g @openai/codex-cli` or equivalent; implementation verifies).
  - `npm install -g @mariozechner/pi-coding-agent` — installs the `pi` CLI for the opt-in backend.
  - Container user `ava` with home `/home/ava` so the mounted `~/.claude`, `~/.codex`, and `~/.pi` land at the paths each CLI expects by default.
  - `git clone --bare https://github.com/<actualvoice-org>/<repo>.git /workspace/repo.git`.
  - `gh auth login --with-token` using a dedicated Ava GitHub token (scoped to `repo` + `workflow` if Ava should read CI results).
- There is no tool-layer adapter inside Ava itself — each backend ships its own tools. Ava's only sandbox responsibility is spawning the backend CLI and performing the handful of host-side git operations noted below.

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

T=30s  agent-invoker starts the Ava run for this thread:
       1. worktree.ensureWorktree(tid)
       2. clear threads/<tid>/outgoing/
       3. select backend (default = claude-code per settings.json,
          or override from @ava:use=<backend> directive in body)
       4. build prompt (email body + sender + worktree path +
          memory hints on first run)
       5. docker exec claude -p "<prompt>"
          --cwd /workspace/threads/<tid>/worktree
          [--resume $(cat claude-session-id) if exists
           else --session-save claude-session-id]
       6. claude runs its own agent loop: grep, read, edit, run
          dev server, screenshot, git commit+push, gh pr create,
          writes before.png + after.png to ./outgoing/
       7. claude exits 0, stdout is the final text reply

T=~3m  gmail.sendReply(tid, stdoutText, [before.png, after.png])
       Brian receives the real reply, threaded with the ack.

T=later  Brian replies: "the after screenshot is cropped, retake it"
         → gmail.poll() picks up the new message in the same thread
         → appended to existing log.jsonl for tid
         → dispatcher enqueues tid again
         → ack → claude is re-invoked with --resume $(cat
           claude-session-id), so it already knows the PR, the
           branch, what screenshots it took, and why. A new commit
           lands on the branch, the PR picks it up, a new
           screenshot is attached.
           (worktree still there, branch unchanged — PR gets a new
            commit, reply gets a new screenshot)

If at any T the backend returns rate-limit:
         → first hit for this inbound message → one status email
         → immediately retry with fallback backend (codex) using
           codex-session-id pointer (or fresh if none)
         → if fallback also rate-limits → silent wait + retry per
           backoff hint, no further emails until resolved
```

### Specific data decisions

- **Reply body**: markdown-ish plaintext only. No HTML. Ava passes pi's stdout through a normalizer that enforces code fences, truncates very long sections, and strips ANSI escapes.
- **Attachments**: 20 MB soft cap per reply. Everything in `threads/<tid>/outgoing/` is attached; overflow is pushed to the PR and linked.
- **Deduplication**: Gmail `Message-Id` is the unique key in `log.jsonl`. Re-runs after a crash won't double-process.
- **Quoted-history stripping**: inbound body strips everything below `^On .* wrote:$` and similar variants before it's built into the pi prompt.
- **Session vs log**: `log.jsonl` is Ava's email transport log (headers, allowlist decisions, outbound metadata). Each backend keeps its own session file in its own place (Claude Code under `~/.claude/projects/`, Codex under `~/.codex/sessions/`). Ava only stores the session **id** per thread per backend (`claude-session-id`, `codex-session-id`), so if a log is lost the agent memory is still intact, and vice versa.
- **Worktree restart**: on crash recovery, the backend's first action in a resumed session is already to orient itself (`git status` is a built-in tool in both). No Ava-side special handling required.
- **`@ava:use=` directive**: a line of the form `@ava:use=codex` (or `=claude-code`) anywhere in the inbound body forces that backend for the run. Case-insensitive, stripped before the body is shown to the agent. Invalid values fall back to the configured default with a one-line note in the reply.

## 6. Error handling

See Section 4.4 for LLM rate-limit and auth-failure flows.

**Gmail errors:**
- Poll API error → exponential backoff 30s → 60s → 2m → 5m cap; console-log only.
- OAuth access-token expired → auto-refresh.
- OAuth refresh-token invalid → stop polling, print recovery instructions to console. No email path available.
- Send failure → retry 3x with backoff, then persist to `threads/<tid>/pending-replies/` and retry on next poll tick.

**Sandbox / agent subprocess errors:**
- Container stopped → `main.ts` starts it.
- Container missing entirely → exit with clear error, no Gmail polling.
- Backend subprocess nonzero exit → as covered in 4.4: `rate-limit` / `auth` / `crash` classifier outcomes each produce specific user-facing behavior (automatic fallover, one-time auth email, or generic crash email respectively).
- Backend wedged (no stdout or exit for longer than the configured per-run timeout, default 20 min) → kill the subprocess, send the generic crash reply, the backend's session id is preserved so the user's reply resumes from whatever the CLI committed before the kill.

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
- `prompt-builder.test.ts`: prompt is assembled correctly from log.jsonl + memory + directive stripping (`@ava:use=`).
- `backend-claude-code.test.ts`: command-shape construction (with and without existing session id), classifier returns correct `FailureKind` for known stderr patterns (rate-limit, auth-expired, generic crash). Uses a fake `claude` shim (shell script) so no real LLM call is made.
- `backend-codex.test.ts`: same shape as the Claude Code backend test, against a fake `codex` shim.
- `backend-pi.test.ts`: same shape, against a fake `pi` shim, plus verifies the `--session <path>` convention (pi-session.jsonl inline) rather than the pointer-file pattern used by the two official CLIs.
- `backend-policy.test.ts`: selection honors `settings.json` default, honors the `@ava:use=` directive for all three backends, triggers fallback on `rate-limit` from the primary and succeeds on the fallback, emits the pi TOS warning only when pi is configured as default or fallback.
- `reply-format.test.ts`: agent-stdout-to-email-body normalizer (code fences preserved, truncation, ANSI-escape stripping, Unicode).
- `outgoing-scan.test.ts`: after a run, all files in `threads/<tid>/outgoing/` are attached; total-size cap enforced; directory cleared on next run.

No mocked-LLM tests at any level. Each vendor CLI owns its agent loop.

### Tier 2 — integration tests (`test/integration/`, manual, not in CI)
- `gmail-roundtrip.ts`: real email round-trip using a second Gmail OAuth credential. Sends from test account, waits for ack and final reply, asserts threading headers. Tagged `@real-gmail`.
- `sandbox-smoke.ts`: stands up `ava-sandbox` on the Fedora host, validates `:Z` mount, verifies `claude --version`, `codex --version`, and `pi --version` all run inside the container against the mounted credential directories, runs `ensureWorktree` against a disposable GitHub fixture repo, pushes and deletes a throwaway branch. Tagged `@real-docker`. Run once after setup and after any infra change.
- `backend-session-reuse.ts`: two sequential runs per backend against the same session identifier. Assert the second invocation sees the first's outputs in its conversation history. Tagged `@real-claude`, `@real-codex`, and `@real-pi` so each can be skipped independently.

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
- **Additional backends**: `gemini` CLI, `ollama`-local, etc. Backend interface is already designed to accept them.
- **Cross-backend session bridging**: if Ava wants Codex to pick up where Claude left off mid-thread, we'd need to translate history across session formats. Punted to v2.
