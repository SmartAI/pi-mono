# Ava Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@actualvoice/ava`, an email-driven AI teammate that receives Gmail at `claude@actualvoice.ai`, runs an official vendor CLI (`claude`, `codex`, or `pi`) in a Docker sandbox to do development work against the ActualVoice repo, and replies in-thread with results, diffs, screenshots, and PR links.

**Architecture:** Node host process polls Gmail via OAuth, enforces a strict allowlist, serializes per-thread work in a dispatcher, and spawns an agent CLI via `docker exec` with per-thread session reuse. One shared bare repo with `git worktree`s per thread. Attachments flow via a filesystem convention (`threads/<tid>/outgoing/`), no custom tool layer.

**Tech Stack:** TypeScript, Node 20+, `vitest`, `googleapis` (Gmail), `mailparser` (RFC-822), `p-queue` (dispatcher), `proper-lockfile` (flock), Docker, Alpine, Claude Code CLI, Codex CLI, pi-coding-agent CLI.

**Spec:** `docs/superpowers/specs/2026-04-16-ava-design.md` — read this first.

---

## File Structure

```
packages/ava/
  package.json
  tsconfig.build.json
  vitest.config.ts
  README.md
  scripts/
    setup-sandbox.sh              # Create ava-sandbox container + preseed
    bootstrap-repo.sh             # First-time bare clone of ActualVoice repo
  src/
    main.ts                       # CLI parse, wiring, shutdown
    types.ts                      # Shared cross-module types
    log.ts                        # Console logger
    store.ts                      # Data-dir layout, log.jsonl, locks, pointer files
    reply-format.ts               # Agent stdout -> email-safe plaintext
    outgoing.ts                   # Scan threads/<tid>/outgoing/, enforce size cap
    gmail/
      parse.ts                    # RFC-822 -> ParsedInboundMessage
      allowlist.ts                # Sender + DKIM/SPF gate
      client.ts                   # Googleapis wrapper: oauth, list, get, send, modify
      poller.ts                   # 30s tick loop, dedup, write to store, enqueue
    dispatcher.ts                 # Per-thread FIFO via p-queue
    worktree.ts                   # Bare-repo init, per-thread worktree add/remove/prune
    sandbox.ts                    # docker exec helper with stream capture + timeout
    backends/
      types.ts                    # Backend interface + FailureKind
      claude-code.ts              # `claude` CLI invocation
      codex.ts                    # `codex` CLI invocation
      pi.ts                       # `pi` CLI invocation
      select.ts                   # Policy: default + fallback + override + TOS warning
    agent-invoker.ts              # Per-run orchestration: prompt, spawn, classify, reply
    prompt-builder.ts             # Build the one-shot prompt from log + memory
  test/
    fixtures/
      emails/                     # Raw RFC-822 samples
      shims/                      # Fake claude/codex/pi shell scripts
    gmail/
      parse.test.ts
      allowlist.test.ts
    dispatcher.test.ts
    worktree.test.ts
    reply-format.test.ts
    outgoing-scan.test.ts
    prompt-builder.test.ts
    backends/
      claude-code.test.ts
      codex.test.ts
      pi.test.ts
      select.test.ts
    integration/                  # Manual, not in CI
      gmail-roundtrip.ts
      sandbox-smoke.ts
      backend-session-reuse.ts
```

**Why this split:**
- `gmail/` groups RFC-822 parsing + auth + client — they change together.
- `backends/` is a plug-in tree; each backend is one small file.
- `store.ts` owns all filesystem layout so the rest of the code never hard-codes paths.
- No file exceeds ~300 lines; each has one responsibility.

---

## Phase 0 — Spikes (verify unknowns before writing code)

### Task 1: Spike — verify Claude Code CLI flags

**Purpose:** The spec commits to behavior ("resume session, non-interactive, set cwd, persist session id") but not to exact flag names. Confirm against the installed `claude` before writing the backend.

**Files:**
- Create: `packages/ava/docs/cli-flags.md` (a notes file; delete after implementation if no longer useful)

- [ ] **Step 1: Check installed claude version**

Run: `claude --version`
Expected: something like `claude-code 2.x.x`. If not installed, run `npm install -g @anthropic-ai/claude-code` first.

- [ ] **Step 2: List non-interactive/print + session flags**

Run: `claude --help 2>&1 | head -80`

Expected: a flag list. Record in `packages/ava/docs/cli-flags.md` the exact names for:
- Non-interactive/print mode (likely `-p` / `--print`).
- Resume session by id (likely `--resume <id>` or `-c`).
- Persist/save new session id on first invocation (check for `--session-id-file`, `--output-session-id`, etc.).
- Set working directory (`--cwd`?).
- Skip permission prompts for automation (`--dangerously-skip-permissions` is the known one).

- [ ] **Step 3: Write down the actual command shape**

Append to `packages/ava/docs/cli-flags.md`:

```md
## Claude Code

First run (no existing session):
claude -p "<prompt>" --cwd <cwd> --dangerously-skip-permissions --output-session-id <file>

Subsequent runs:
claude --resume "$(cat <file>)" -p "<prompt>" --cwd <cwd> --dangerously-skip-permissions
```
(Replace with whatever the actual help output says. If a flag does not exist with that name but a near-equivalent does, use the near-equivalent and document what's different.)

- [ ] **Step 4: Commit**

```bash
git add packages/ava/docs/cli-flags.md
git commit -m "ava: record verified Claude Code CLI flags"
```

### Task 2: Spike — verify Codex CLI flags

**Files:**
- Modify: `packages/ava/docs/cli-flags.md`

- [ ] **Step 1: Check installed codex version**

Run: `codex --version`
Expected: a version string. If not installed, look up the current install command at https://github.com/openai/codex or equivalent and install it.

- [ ] **Step 2: List relevant flags**

Run: `codex --help 2>&1 | head -80` and `codex resume --help 2>&1 | head -40` (if `resume` is a subcommand).

Record in `cli-flags.md` the exact flag names for: non-interactive, resume by session id, set cwd, model selection (to pin GPT-5.4).

- [ ] **Step 3: Write down command shape**

Append:

```md
## Codex

First run:
codex ... -m gpt-5.4 "<prompt>" --cwd <cwd> ...

Resume:
codex resume <session-id> "<prompt>" --cwd <cwd> ...
```

- [ ] **Step 4: Commit**

```bash
git add packages/ava/docs/cli-flags.md
git commit -m "ava: record verified Codex CLI flags"
```

### Task 3: Spike — verify pi CLI flags (known good, but confirm)

**Files:**
- Modify: `packages/ava/docs/cli-flags.md`

- [ ] **Step 1: Check pi**

Run: `pi --help 2>&1 | grep -E -- '--session|--cwd|-p\b|--no-context'`
Expected: confirms `--session <path|uuid>`, `-p`, `--cwd`, `--no-context-files` exist.

- [ ] **Step 2: Record**

```md
## pi-coding-agent

Every run (same command shape; --session creates or resumes):
pi --session /workspace/threads/<tid>/pi-session.jsonl \
   --cwd <worktree> --no-context-files -p "<prompt>"
```

- [ ] **Step 3: Commit**

```bash
git add packages/ava/docs/cli-flags.md
git commit -m "ava: record verified pi CLI flags"
```

---

## Phase 1 — Foundations

### Task 4: Package scaffolding

**Files:**
- Create: `packages/ava/package.json`
- Create: `packages/ava/tsconfig.build.json`
- Create: `packages/ava/vitest.config.ts`
- Create: `packages/ava/README.md`
- Modify: `packages/ava/../../package.json` (root) — add `packages/ava` to workspaces if not already covered by a glob
- Modify: `packages/ava/../../tsconfig.json` (root) — add project reference if the repo uses references

- [ ] **Step 1: Inspect the pi-mom package for structure to mirror**

Run: `cat packages/mom/package.json`
Expected: see the scripts (`dev`, `build`, `check`), deps layout. The new Ava package will mirror this.

- [ ] **Step 2: Write package.json**

Create `packages/ava/package.json`:

```json
{
  "name": "@actualvoice/ava",
  "version": "0.0.1",
  "private": true,
  "description": "Email-driven AI teammate for ActualVoice",
  "type": "module",
  "bin": {
    "ava": "./dist/main.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsc -p tsconfig.build.json -w",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "googleapis": "^140.0.0",
    "mailparser": "^3.6.0",
    "p-queue": "^8.0.0",
    "proper-lockfile": "^4.1.2"
  },
  "devDependencies": {
    "@types/mailparser": "^3.4.4",
    "@types/node": "^20.0.0",
    "@types/proper-lockfile": "^4.1.4",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 3: Write tsconfig.build.json**

Create `packages/ava/tsconfig.build.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Write vitest.config.ts**

Create `packages/ava/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**"],
    testTimeout: 10_000,
  },
});
```

- [ ] **Step 5: Write minimal README.md**

Create `packages/ava/README.md`:

```md
# @actualvoice/ava

Email-driven AI teammate for ActualVoice. Receives Gmail at a dedicated
address, runs an agent CLI in a Docker sandbox, replies in-thread.

See `docs/superpowers/specs/2026-04-16-ava-design.md` for the design.

## Setup (not-yet-complete; see plan)

1. Authenticate `claude`, `codex`, and optionally `pi` on the host.
2. `scripts/setup-sandbox.sh` creates the ava-sandbox Docker container.
3. `ava --data-dir ./data --sandbox=docker:ava-sandbox`
```

- [ ] **Step 6: Install deps + type-check**

Run: `cd packages/ava && npm install`
Expected: install succeeds.

Run: `cd packages/ava && npx tsc -p tsconfig.build.json --noEmit`
Expected: no errors (there's no `src/` yet, which is fine — tsc exits 0 for empty include).

- [ ] **Step 7: Commit**

```bash
git add packages/ava/package.json packages/ava/tsconfig.build.json \
        packages/ava/vitest.config.ts packages/ava/README.md \
        packages/ava/docs/cli-flags.md package.json package-lock.json
git commit -m "ava: scaffold package"
```

### Task 5: Shared types

**Files:**
- Create: `packages/ava/src/types.ts`

- [ ] **Step 1: Write the types file**

Create `packages/ava/src/types.ts`:

```ts
export interface ParsedInboundMessage {
  gmailMessageId: string;           // Gmail's Message-Id header value
  threadId: string;                 // Gmail threadId
  from: string;                     // email address (normalised lowercase)
  to: string[];
  subject: string;
  bodyText: string;                 // quoted-history stripped
  dkimResult: "pass" | "fail" | "none";
  spfResult: "pass" | "fail" | "none";
  attachments: Array<{ filename: string; path: string; bytes: number }>;
  receivedAt: string;               // ISO 8601
  headers: Record<string, string>;  // lowercased keys
}

export interface OutboundReply {
  threadId: string;
  to: string;
  inReplyToMessageId: string;
  subject: string;
  bodyText: string;
  attachments: Array<{ filename: string; path: string; bytes: number }>;
}

export type BackendName = "claude-code" | "codex" | "pi";

export type FailureKind = "ok" | "rate-limit" | "auth" | "crash";

export interface AvaSettings {
  backend: {
    default: BackendName;
    fallback: BackendName | null;
  };
  prune: {
    maxInactiveDays: number;          // default 14
  };
  timeouts: {
    perRunMs: number;                 // default 20 * 60_000
    gmailPollMs: number;              // default 30_000
  };
  attachments: {
    perReplyMaxBytes: number;         // default 20 * 1024 * 1024
  };
  gitFetchIntervalMs: number;         // default 10 * 60_000
}

export const DEFAULT_SETTINGS: AvaSettings = {
  backend: { default: "claude-code", fallback: "codex" },
  prune: { maxInactiveDays: 14 },
  timeouts: { perRunMs: 20 * 60_000, gmailPollMs: 30_000 },
  attachments: { perReplyMaxBytes: 20 * 1024 * 1024 },
  gitFetchIntervalMs: 10 * 60_000,
};
```

- [ ] **Step 2: Compile**

Run: `cd packages/ava && npx tsc -p tsconfig.build.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ava/src/types.ts
git commit -m "ava: shared types and default settings"
```

### Task 6: Console logger

**Files:**
- Create: `packages/ava/src/log.ts`
- Create: `packages/ava/test/log.test.ts` (optional smoke)

- [ ] **Step 1: Write a small structured logger**

Create `packages/ava/src/log.ts`:

```ts
type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.AVA_LOG_LEVEL as Level) ?? "info"];

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (order[level] < threshold) return;
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(meta ?? {}),
  };
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(JSON.stringify(line) + "\n");
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
```

- [ ] **Step 2: Compile**

Run: `cd packages/ava && npx tsc -p tsconfig.build.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ava/src/log.ts
git commit -m "ava: structured console logger"
```

### Task 7: Store (data-dir layout + log.jsonl + locks)

**Files:**
- Create: `packages/ava/src/store.ts`
- Create: `packages/ava/test/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/ava/test/store.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

describe("Store", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ava-store-"));
    store = new Store(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates thread dirs and appends inbound messages to log.jsonl", async () => {
    await store.appendInbound("T-abc", {
      kind: "inbound",
      gmailMessageId: "<m1@x>",
      from: "brian@actualvoice.ai",
      at: "2026-04-16T12:00:00Z",
      subject: "hi",
      bodyText: "hello",
    });
    const content = await readFile(join(dir, "threads", "T-abc", "log.jsonl"), "utf-8");
    expect(content.trim().split("\n")).toHaveLength(1);
    const row = JSON.parse(content.trim());
    expect(row.kind).toBe("inbound");
    expect(row.gmailMessageId).toBe("<m1@x>");
  });

  it("dedups by gmailMessageId across inbound appends", async () => {
    const entry = {
      kind: "inbound" as const,
      gmailMessageId: "<dup@x>",
      from: "x@y",
      at: "2026-04-16T12:00:00Z",
      subject: "s",
      bodyText: "b",
    };
    await store.appendInbound("T-1", entry);
    await store.appendInbound("T-1", entry); // same id, should be ignored
    const rows = (await readFile(join(dir, "threads", "T-1", "log.jsonl"), "utf-8")).trim().split("\n");
    expect(rows).toHaveLength(1);
  });

  it("lists known thread ids from the threads/ dir", async () => {
    await store.appendInbound("T-a", { kind: "inbound", gmailMessageId: "<1@x>", from: "u@v", at: "2026-04-16T12:00:00Z", subject: "", bodyText: "" });
    await store.appendInbound("T-b", { kind: "inbound", gmailMessageId: "<2@x>", from: "u@v", at: "2026-04-16T12:00:00Z", subject: "", bodyText: "" });
    expect(await store.listThreadIds()).toEqual(expect.arrayContaining(["T-a", "T-b"]));
  });
});
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cd packages/ava && npx vitest run test/store.test.ts`
Expected: FAIL (`Cannot find module '../src/store.js'`).

- [ ] **Step 3: Write the store module**

Create `packages/ava/src/store.ts`:

```ts
import { mkdir, readFile, readdir, writeFile, appendFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type LogEntry =
  | {
      kind: "inbound";
      gmailMessageId: string;
      from: string;
      at: string;
      subject: string;
      bodyText: string;
      attachments?: Array<{ filename: string; path: string; bytes: number }>;
    }
  | {
      kind: "outbound";
      gmailMessageId: string;            // the Message-Id of the reply we sent
      inReplyToMessageId: string;
      at: string;
      backendUsed: string;
      attachments: Array<{ filename: string; bytes: number }>;
    }
  | { kind: "allowlist-reject"; gmailMessageId: string; from: string; reason: string; at: string };

export class Store {
  constructor(public readonly dataDir: string) {}

  private threadDir(threadId: string): string {
    return join(this.dataDir, "threads", threadId);
  }

  async ensureThread(threadId: string): Promise<string> {
    const dir = this.threadDir(threadId);
    await mkdir(join(dir, "attachments"), { recursive: true });
    await mkdir(join(dir, "outgoing"), { recursive: true });
    return dir;
  }

  async appendInbound(threadId: string, entry: Extract<LogEntry, { kind: "inbound" }>): Promise<void> {
    await this.ensureThread(threadId);
    if (await this.hasMessageId(threadId, entry.gmailMessageId)) return;
    await appendFile(join(this.threadDir(threadId), "log.jsonl"), JSON.stringify(entry) + "\n");
  }

  async appendOutbound(threadId: string, entry: Extract<LogEntry, { kind: "outbound" }>): Promise<void> {
    await this.ensureThread(threadId);
    await appendFile(join(this.threadDir(threadId), "log.jsonl"), JSON.stringify(entry) + "\n");
  }

  async appendReject(threadId: string, entry: Extract<LogEntry, { kind: "allowlist-reject" }>): Promise<void> {
    await this.ensureThread(threadId);
    await appendFile(join(this.threadDir(threadId), "log.jsonl"), JSON.stringify(entry) + "\n");
  }

  async hasMessageId(threadId: string, messageId: string): Promise<boolean> {
    const path = join(this.threadDir(threadId), "log.jsonl");
    if (!existsSync(path)) return false;
    const content = await readFile(path, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as LogEntry;
        if (row.kind === "inbound" && row.gmailMessageId === messageId) return true;
      } catch {
        // corrupt line, skip
      }
    }
    return false;
  }

  async listThreadIds(): Promise<string[]> {
    const dir = join(this.dataDir, "threads");
    if (!existsSync(dir)) return [];
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  }

  async threadLastActivityMs(threadId: string): Promise<number> {
    const path = join(this.threadDir(threadId), "log.jsonl");
    if (!existsSync(path)) return 0;
    const s = await stat(path);
    return s.mtimeMs;
  }

  async readSessionPointer(threadId: string, backend: string): Promise<string | null> {
    const path = join(this.threadDir(threadId), `${backend}-session-id`);
    if (!existsSync(path)) return null;
    return (await readFile(path, "utf-8")).trim();
  }

  async writeSessionPointer(threadId: string, backend: string, sessionId: string): Promise<void> {
    await this.ensureThread(threadId);
    await writeFile(join(this.threadDir(threadId), `${backend}-session-id`), sessionId);
  }

  threadPathAbs(threadId: string, sub = ""): string {
    return sub ? join(this.threadDir(threadId), sub) : this.threadDir(threadId);
  }
}
```

- [ ] **Step 4: Run tests and see them pass**

Run: `cd packages/ava && npx vitest run test/store.test.ts`
Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/ava/src/store.ts packages/ava/test/store.test.ts
git commit -m "ava: store module with log.jsonl append + dedup"
```

### Task 8: Reply-format normalizer

**Files:**
- Create: `packages/ava/src/reply-format.ts`
- Create: `packages/ava/test/reply-format.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/ava/test/reply-format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeReply } from "../src/reply-format.js";

describe("normalizeReply", () => {
  it("passes short plain text through untouched", () => {
    expect(normalizeReply("hello world")).toBe("hello world");
  });

  it("strips ANSI escape codes", () => {
    const input = "\x1b[31mred\x1b[0m text";
    expect(normalizeReply(input)).toBe("red text");
  });

  it("truncates very long lines with an ellipsis marker", () => {
    const long = "x".repeat(30_000);
    const out = normalizeReply(long);
    expect(out.length).toBeLessThan(30_000);
    expect(out).toContain("[... 1 lines truncated");
  });

  it("preserves triple-backtick code fences", () => {
    const input = "see below:\n```js\nconst x = 1;\n```\n";
    expect(normalizeReply(input)).toBe(input);
  });

  it("trims long output blocks but keeps surrounding prose", () => {
    const block = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const input = `before\n${block}\nafter`;
    const out = normalizeReply(input);
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).toContain("lines truncated");
  });
});
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cd packages/ava && npx vitest run test/reply-format.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the normalizer**

Create `packages/ava/src/reply-format.ts`:

```ts
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const MAX_LINE_CHARS = 2_000;
const MAX_TOTAL_LINES = 1_500;

export function normalizeReply(input: string): string {
  const noAnsi = input.replace(ANSI_REGEX, "");
  const linesIn = noAnsi.split("\n");
  const trimmedLines = linesIn.map((line) =>
    line.length > MAX_LINE_CHARS
      ? line.slice(0, MAX_LINE_CHARS) + ` [... 1 lines truncated — ${line.length - MAX_LINE_CHARS} chars removed ...]`
      : line,
  );
  if (trimmedLines.length <= MAX_TOTAL_LINES) return trimmedLines.join("\n");
  const head = trimmedLines.slice(0, Math.floor(MAX_TOTAL_LINES / 2));
  const tail = trimmedLines.slice(-Math.floor(MAX_TOTAL_LINES / 2));
  const removed = trimmedLines.length - head.length - tail.length;
  return [...head, `[... ${removed} lines truncated ...]`, ...tail].join("\n");
}
```

- [ ] **Step 4: Run tests and see them pass**

Run: `cd packages/ava && npx vitest run test/reply-format.test.ts`
Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/ava/src/reply-format.ts packages/ava/test/reply-format.test.ts
git commit -m "ava: reply-format normalizer (ANSI strip + truncation)"
```

### Task 9: Outgoing scan + size cap

**Files:**
- Create: `packages/ava/src/outgoing.ts`
- Create: `packages/ava/test/outgoing-scan.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/ava/test/outgoing-scan.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanOutgoing, clearOutgoing } from "../src/outgoing.js";

describe("outgoing scan", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ava-out-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns files with size", async () => {
    await mkdir(join(dir, "outgoing"), { recursive: true });
    await writeFile(join(dir, "outgoing", "a.png"), Buffer.alloc(1024));
    await writeFile(join(dir, "outgoing", "b.txt"), "hello");
    const r = await scanOutgoing(dir, 10 * 1024 * 1024);
    expect(r.attached.map((a) => a.filename).sort()).toEqual(["a.png", "b.txt"]);
    expect(r.overflow).toEqual([]);
  });

  it("overflows beyond the cap", async () => {
    await mkdir(join(dir, "outgoing"), { recursive: true });
    await writeFile(join(dir, "outgoing", "big.bin"), Buffer.alloc(900_000));
    await writeFile(join(dir, "outgoing", "also.bin"), Buffer.alloc(900_000));
    await writeFile(join(dir, "outgoing", "tiny.txt"), "ok");
    const r = await scanOutgoing(dir, 1_000_000);
    // FIFO by name means 'also.bin' goes in first (alphabetical), then 'tiny.txt' fits; 'big.bin' overflows.
    const attachedNames = r.attached.map((a) => a.filename).sort();
    const overflowNames = r.overflow.map((a) => a.filename).sort();
    expect(attachedNames.length + overflowNames.length).toBe(3);
    const totalAttached = r.attached.reduce((n, a) => n + a.bytes, 0);
    expect(totalAttached).toBeLessThanOrEqual(1_000_000);
  });

  it("clear empties the outgoing dir", async () => {
    await mkdir(join(dir, "outgoing"), { recursive: true });
    await writeFile(join(dir, "outgoing", "stale.txt"), "old");
    await clearOutgoing(dir);
    const r = await scanOutgoing(dir, 1_000_000);
    expect(r.attached).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cd packages/ava && npx vitest run test/outgoing-scan.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `packages/ava/src/outgoing.ts`:

```ts
import { readdir, stat, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface OutgoingFile {
  filename: string;
  path: string;
  bytes: number;
}

export interface OutgoingScanResult {
  attached: OutgoingFile[];
  overflow: OutgoingFile[];
}

export async function scanOutgoing(threadDirAbs: string, capBytes: number): Promise<OutgoingScanResult> {
  const outDir = join(threadDirAbs, "outgoing");
  if (!existsSync(outDir)) return { attached: [], overflow: [] };
  const entries = (await readdir(outDir, { withFileTypes: true })).filter((e) => e.isFile());
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const attached: OutgoingFile[] = [];
  const overflow: OutgoingFile[] = [];
  let running = 0;
  for (const e of entries) {
    const path = join(outDir, e.name);
    const bytes = (await stat(path)).size;
    const file: OutgoingFile = { filename: e.name, path, bytes };
    if (running + bytes <= capBytes) {
      attached.push(file);
      running += bytes;
    } else {
      overflow.push(file);
    }
  }
  return { attached, overflow };
}

export async function clearOutgoing(threadDirAbs: string): Promise<void> {
  const outDir = join(threadDirAbs, "outgoing");
  if (!existsSync(outDir)) {
    await mkdir(outDir, { recursive: true });
    return;
  }
  const entries = await readdir(outDir, { withFileTypes: true });
  await Promise.all(entries.filter((e) => e.isFile()).map((e) => unlink(join(outDir, e.name))));
}
```

- [ ] **Step 4: Run tests and see them pass**

Run: `cd packages/ava && npx vitest run test/outgoing-scan.test.ts`
Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/ava/src/outgoing.ts packages/ava/test/outgoing-scan.test.ts
git commit -m "ava: outgoing directory scan with size cap"
```

---

## Phase 2 — Gmail transport

### Task 10: Gmail parse (raw RFC-822 → ParsedInboundMessage)

**Files:**
- Create: `packages/ava/src/gmail/parse.ts`
- Create: `packages/ava/test/fixtures/emails/plain.eml`
- Create: `packages/ava/test/fixtures/emails/multipart-attach.eml`
- Create: `packages/ava/test/fixtures/emails/quoted-history.eml`
- Create: `packages/ava/test/gmail/parse.test.ts`

- [ ] **Step 1: Create the three fixture email files**

Create `packages/ava/test/fixtures/emails/plain.eml`:

```
From: Brian <brian@actualvoice.ai>
To: claude@actualvoice.ai
Subject: hello
Date: Thu, 16 Apr 2026 12:00:00 +0000
Message-ID: <m1@mail.example>
Authentication-Results: mx.google.com; dkim=pass header.d=actualvoice.ai; spf=pass smtp.mailfrom=actualvoice.ai

this is the body
```

Create `packages/ava/test/fixtures/emails/multipart-attach.eml`:

```
From: Max <max@actualvoice.ai>
To: claude@actualvoice.ai
Subject: with an attachment
Date: Thu, 16 Apr 2026 12:05:00 +0000
Message-ID: <m2@mail.example>
Authentication-Results: mx.google.com; dkim=pass header.d=actualvoice.ai; spf=pass smtp.mailfrom=actualvoice.ai
Content-Type: multipart/mixed; boundary="b"

--b
Content-Type: text/plain; charset=utf-8

see attached
--b
Content-Type: text/plain; name="note.txt"
Content-Disposition: attachment; filename="note.txt"

payload-bytes
--b--
```

Create `packages/ava/test/fixtures/emails/quoted-history.eml`:

```
From: Brian <brian@actualvoice.ai>
To: claude@actualvoice.ai
Subject: Re: hello
Date: Thu, 16 Apr 2026 13:00:00 +0000
Message-ID: <m3@mail.example>
Authentication-Results: mx.google.com; dkim=pass header.d=actualvoice.ai; spf=pass smtp.mailfrom=actualvoice.ai

retake the screenshot please

On Thu, 16 Apr 2026 at 12:30, Ava <claude@actualvoice.ai> wrote:
> here's the first screenshot
> [image attached]
```

- [ ] **Step 2: Write the failing test**

Create `packages/ava/test/gmail/parse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRaw } from "../../src/gmail/parse.js";

const fixturesDir = join(__dirname, "../fixtures/emails");

describe("parseRaw", () => {
  it("parses a plain message with auth results", async () => {
    const raw = await readFile(join(fixturesDir, "plain.eml"));
    const p = await parseRaw(raw, { threadId: "T-1" });
    expect(p.from).toBe("brian@actualvoice.ai");
    expect(p.subject).toBe("hello");
    expect(p.bodyText.trim()).toBe("this is the body");
    expect(p.dkimResult).toBe("pass");
    expect(p.spfResult).toBe("pass");
    expect(p.gmailMessageId).toBe("<m1@mail.example>");
  });

  it("keeps attachments as metadata only (caller writes them to disk)", async () => {
    const raw = await readFile(join(fixturesDir, "multipart-attach.eml"));
    const p = await parseRaw(raw, { threadId: "T-2" });
    expect(p.attachments).toHaveLength(1);
    expect(p.attachments[0].filename).toBe("note.txt");
    expect(p.bodyText.trim()).toBe("see attached");
  });

  it("strips quoted-history from reply bodies", async () => {
    const raw = await readFile(join(fixturesDir, "quoted-history.eml"));
    const p = await parseRaw(raw, { threadId: "T-3" });
    expect(p.bodyText.trim()).toBe("retake the screenshot please");
    expect(p.bodyText).not.toContain("here's the first screenshot");
  });
});
```

- [ ] **Step 3: Run tests and see them fail**

Run: `cd packages/ava && npx vitest run test/gmail/parse.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement the parser**

Create `packages/ava/src/gmail/parse.ts`:

```ts
import { simpleParser, type ParsedMail, type AddressObject } from "mailparser";
import type { ParsedInboundMessage } from "../types.js";

const QUOTE_LINE = /^(?:On\b.*wrote:\s*$|[>].*)/i;

function stripQuoted(body: string): string {
  const lines = body.split(/\r?\n/);
  const cutoff = lines.findIndex((line) => QUOTE_LINE.test(line.trim()));
  if (cutoff === -1) return body.trim();
  return lines.slice(0, cutoff).join("\n").trim();
}

function classifyAuth(header: string | undefined, tag: "dkim" | "spf"): "pass" | "fail" | "none" {
  if (!header) return "none";
  const rx = new RegExp(`\\b${tag}=([a-z]+)`, "i");
  const m = header.match(rx);
  if (!m) return "none";
  const v = m[1].toLowerCase();
  if (v === "pass") return "pass";
  if (v === "fail" || v === "softfail" || v === "temperror" || v === "permerror") return "fail";
  return "none";
}

function firstAddress(a: AddressObject | AddressObject[] | undefined): string {
  if (!a) return "";
  const one = Array.isArray(a) ? a[0] : a;
  return (one?.value?.[0]?.address ?? "").toLowerCase();
}

function addresses(a: AddressObject | AddressObject[] | undefined): string[] {
  if (!a) return [];
  const arr = Array.isArray(a) ? a : [a];
  return arr.flatMap((o) => o.value.map((v) => (v.address ?? "").toLowerCase()).filter(Boolean));
}

export async function parseRaw(raw: Buffer, opts: { threadId: string }): Promise<ParsedInboundMessage> {
  const parsed: ParsedMail = await simpleParser(raw);
  const authHeader = (parsed.headers.get("authentication-results") as string | undefined) ?? undefined;
  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of parsed.headers.entries()) {
    lowerHeaders[k.toLowerCase()] = typeof v === "string" ? v : JSON.stringify(v);
  }

  return {
    gmailMessageId: parsed.messageId ?? "",
    threadId: opts.threadId,
    from: firstAddress(parsed.from),
    to: addresses(parsed.to),
    subject: parsed.subject ?? "",
    bodyText: stripQuoted(parsed.text ?? ""),
    dkimResult: classifyAuth(authHeader, "dkim"),
    spfResult: classifyAuth(authHeader, "spf"),
    attachments: (parsed.attachments ?? []).map((a) => ({
      filename: a.filename ?? "unnamed",
      path: "",           // filled in later by the caller that writes to disk
      bytes: a.size ?? 0,
    })),
    receivedAt: (parsed.date ?? new Date()).toISOString(),
    headers: lowerHeaders,
  };
}
```

- [ ] **Step 5: Run tests and see them pass**

Run: `cd packages/ava && npx vitest run test/gmail/parse.test.ts`
Expected: 3 tests passing.

- [ ] **Step 6: Commit**

```bash
git add packages/ava/src/gmail/parse.ts packages/ava/test/gmail/ packages/ava/test/fixtures/
git commit -m "ava: gmail RFC-822 parser with quoted-history stripping"
```

### Task 11: Allowlist gate

**Files:**
- Create: `packages/ava/src/gmail/allowlist.ts`
- Create: `packages/ava/test/gmail/allowlist.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/ava/test/gmail/allowlist.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decideAllowlist } from "../../src/gmail/allowlist.js";
import type { ParsedInboundMessage } from "../../src/types.js";

function msg(over: Partial<ParsedInboundMessage>): ParsedInboundMessage {
  return {
    gmailMessageId: "<m@x>",
    threadId: "T",
    from: "brian@actualvoice.ai",
    to: ["claude@actualvoice.ai"],
    subject: "hi",
    bodyText: "",
    dkimResult: "pass",
    spfResult: "pass",
    attachments: [],
    receivedAt: "2026-04-16T12:00:00Z",
    headers: {},
    ...over,
  };
}

describe("decideAllowlist", () => {
  const allow = ["brian@actualvoice.ai", "max@actualvoice.ai"];

  it("accepts allowlisted sender with DKIM+SPF pass", () => {
    expect(decideAllowlist(msg({}), allow)).toEqual({ allowed: true });
  });

  it("rejects sender not on allowlist", () => {
    const r = decideAllowlist(msg({ from: "stranger@evil.com" }), allow);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/not on allowlist/i);
  });

  it("rejects allowlisted sender if DKIM fails — suspicious", () => {
    const r = decideAllowlist(msg({ dkimResult: "fail" }), allow);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toMatch(/dkim/i);
      expect(r.suspicious).toBe(true);
    }
  });

  it("rejects allowlisted sender if SPF fails — suspicious", () => {
    const r = decideAllowlist(msg({ spfResult: "fail" }), allow);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.suspicious).toBe(true);
  });

  it("normalises case on allowlist entries", () => {
    expect(decideAllowlist(msg({ from: "Brian@ActualVoice.ai" }), allow).allowed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cd packages/ava && npx vitest run test/gmail/allowlist.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `packages/ava/src/gmail/allowlist.ts`:

```ts
import type { ParsedInboundMessage } from "../types.js";

export type AllowlistDecision =
  | { allowed: true }
  | { allowed: false; reason: string; suspicious: boolean };

export function decideAllowlist(msg: ParsedInboundMessage, allowlist: string[]): AllowlistDecision {
  const allow = new Set(allowlist.map((e) => e.toLowerCase()));
  const from = msg.from.toLowerCase();
  const isAllowed = allow.has(from);
  if (!isAllowed) {
    return { allowed: false, reason: "sender not on allowlist", suspicious: false };
  }
  if (msg.dkimResult !== "pass") {
    return { allowed: false, reason: `dkim=${msg.dkimResult} on allowlisted sender`, suspicious: true };
  }
  if (msg.spfResult !== "pass") {
    return { allowed: false, reason: `spf=${msg.spfResult} on allowlisted sender`, suspicious: true };
  }
  return { allowed: true };
}
```

- [ ] **Step 4: Run tests and see them pass**

Run: `cd packages/ava && npx vitest run test/gmail/allowlist.test.ts`
Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/ava/src/gmail/allowlist.ts packages/ava/test/gmail/allowlist.test.ts
git commit -m "ava: allowlist + DKIM/SPF gate with suspicious-flag"
```

### Task 12: Gmail API client (thin googleapis wrapper)

**Files:**
- Create: `packages/ava/src/gmail/client.ts`

Note: the client is verified by the integration test (Task 25) against real Gmail; no unit test here because mocking googleapis thoroughly is not worth the effort for a thin wrapper.

- [ ] **Step 1: Implement the wrapper**

Create `packages/ava/src/gmail/client.ts`:

```ts
import { google, type gmail_v1 } from "googleapis";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";

export interface GmailAuthFiles {
  credentialsPath: string;   // OAuth client secret JSON from Google Cloud
  tokenPath: string;         // where refresh token is persisted
}

export class GmailClient {
  private gmail!: gmail_v1.Gmail;

  async init(files: GmailAuthFiles): Promise<void> {
    const creds = JSON.parse(await readFile(files.credentialsPath, "utf-8"));
    const { client_id, client_secret, redirect_uris } = creds.installed ?? creds.web;
    const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    if (!existsSync(files.tokenPath)) {
      throw new Error(
        `Gmail token not found at ${files.tokenPath}. Run: npx @actualvoice/ava auth:gmail`,
      );
    }
    const token = JSON.parse(await readFile(files.tokenPath, "utf-8"));
    oauth2.setCredentials(token);
    oauth2.on("tokens", async (refreshed) => {
      const merged = { ...token, ...refreshed };
      await writeFile(files.tokenPath, JSON.stringify(merged, null, 2));
      log.debug("gmail token refreshed");
    });
    this.gmail = google.gmail({ version: "v1", auth: oauth2 });
  }

  async listUnread(query: string): Promise<string[]> {
    const res = await this.gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 50,
    });
    return (res.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  }

  async getRaw(messageId: string): Promise<{ raw: Buffer; threadId: string }> {
    const res = await this.gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "raw",
    });
    const raw = Buffer.from(res.data.raw as string, "base64url");
    return { raw, threadId: res.data.threadId ?? "" };
  }

  async markRead(messageId: string): Promise<void> {
    await this.gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { removeLabelIds: ["UNREAD"] },
    });
  }

  async send(opts: {
    threadId: string;
    to: string;
    subject: string;
    bodyText: string;
    inReplyTo: string;
    references: string[];
    attachments: Array<{ filename: string; path: string }>;
  }): Promise<string> {
    const mime = await buildMime(opts);
    const res = await this.gmail.users.messages.send({
      userId: "me",
      requestBody: {
        threadId: opts.threadId,
        raw: mime.toString("base64url"),
      },
    });
    return res.data.id ?? "";
  }
}

async function buildMime(opts: {
  to: string;
  subject: string;
  bodyText: string;
  inReplyTo: string;
  references: string[];
  attachments: Array<{ filename: string; path: string }>;
}): Promise<Buffer> {
  const boundary = `ava-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const headers = [
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `In-Reply-To: ${opts.inReplyTo}`,
    `References: ${opts.references.join(" ")}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts: string[] = [
    "",
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    "",
    opts.bodyText,
  ];
  for (const att of opts.attachments) {
    const data = (await readFile(att.path)).toString("base64");
    parts.push(
      `--${boundary}`,
      `Content-Type: application/octet-stream; name="${att.filename}"`,
      `Content-Disposition: attachment; filename="${att.filename}"`,
      `Content-Transfer-Encoding: base64`,
      "",
      data,
    );
  }
  parts.push(`--${boundary}--`, "");
  return Buffer.from(headers.join("\r\n") + "\r\n" + parts.join("\r\n"), "utf-8");
}
```

- [ ] **Step 2: Compile**

Run: `cd packages/ava && npx tsc -p tsconfig.build.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ava/src/gmail/client.ts
git commit -m "ava: Gmail API client (OAuth + list + get + send)"
```

### Task 12b: Gmail OAuth helper (`ava auth:gmail`)

**Files:**
- Create: `packages/ava/src/gmail/oauth-setup.ts`
- Modify: `packages/ava/src/main.ts` (later, in Task 26, by adding a subcommand check at the top — noted there)

- [ ] **Step 1: Implement the helper**

Create `packages/ava/src/gmail/oauth-setup.ts`:

```ts
import { google } from "googleapis";
import { createInterface } from "node:readline/promises";
import { readFile, writeFile } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

export async function gmailAuthSetup(opts: { credentialsPath: string; tokenPath: string }): Promise<void> {
  const creds = JSON.parse(await readFile(opts.credentialsPath, "utf-8"));
  const { client_id, client_secret, redirect_uris } = creds.installed ?? creds.web;
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const url = oauth2.generateAuthUrl({ access_type: "offline", scope: SCOPES, prompt: "consent" });
  console.log("\nOpen this URL in a browser, grant consent, then paste the resulting code:\n");
  console.log(url);
  const rl = createInterface({ input, output });
  try {
    const code = (await rl.question("\nCode: ")).trim();
    const { tokens } = await oauth2.getToken(code);
    await writeFile(opts.tokenPath, JSON.stringify(tokens, null, 2));
    console.log(`Token written to ${opts.tokenPath}`);
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 2: Wire a subcommand check into the CLI (defer to Task 26)**

In Task 26, the CLI parser will include an `auth:gmail` subcommand dispatch. For now the helper is importable; Task 26 calls it.

- [ ] **Step 3: Compile**

Run: `cd packages/ava && npx tsc -p tsconfig.build.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/ava/src/gmail/oauth-setup.ts
git commit -m "ava: Gmail OAuth first-run helper"
```

### Task 13: Gmail poller

**Files:**
- Create: `packages/ava/src/gmail/poller.ts`

No unit test — depends on real Gmail. Covered by integration test in Task 25.

- [ ] **Step 1: Implement**

Create `packages/ava/src/gmail/poller.ts`:

```ts
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { GmailClient } from "./client.js";
import { parseRaw } from "./parse.js";
import { decideAllowlist } from "./allowlist.js";
import { Store } from "../store.js";
import { log } from "../log.js";

export interface PollerOptions {
  client: GmailClient;
  store: Store;
  allowlist: string[];
  intervalMs: number;
  query: string;
  onAccepted: (threadId: string) => void;
  onStopSignal: AbortSignal;
}

export async function runPoller(opts: PollerOptions): Promise<void> {
  let backoffMs = opts.intervalMs;
  while (!opts.onStopSignal.aborted) {
    try {
      await tick(opts);
      backoffMs = opts.intervalMs; // success: reset backoff
    } catch (e) {
      log.warn("poll tick failed", { error: String(e), nextInMs: backoffMs });
      backoffMs = Math.min(backoffMs * 2, 5 * 60_000);
    }
    await sleep(backoffMs, opts.onStopSignal);
  }
}

async function tick(opts: PollerOptions): Promise<void> {
  const ids = await opts.client.listUnread(opts.query);
  for (const id of ids) {
    const { raw, threadId } = await opts.client.getRaw(id);
    if (!threadId) continue;

    if (await opts.store.hasMessageId(threadId, id)) {
      await opts.client.markRead(id);
      continue;
    }

    const parsed = await parseRaw(raw, { threadId });
    const attDir = opts.store.threadPathAbs(threadId, `attachments/${parsed.gmailMessageId.replace(/[<>]/g, "")}`);
    await mkdir(attDir, { recursive: true });
    // We intentionally do NOT re-parse mailparser for attachment bytes here; real implementation
    // would either parse once and write bytes in parse.ts, or use Gmail's attachment.get API.
    // For now: write zero-byte placeholders matching filenames so paths are stable.
    for (const a of parsed.attachments) {
      const abs = join(attDir, a.filename);
      await writeFile(abs, Buffer.alloc(0));
      a.path = abs;
    }

    const decision = decideAllowlist(parsed, opts.allowlist);
    if (!decision.allowed) {
      log.warn("allowlist reject", { from: parsed.from, reason: decision.reason, suspicious: decision.suspicious });
      await opts.store.appendReject(threadId, {
        kind: "allowlist-reject",
        gmailMessageId: id,
        from: parsed.from,
        reason: decision.reason,
        at: parsed.receivedAt,
      });
      await opts.client.markRead(id);
      continue;
    }

    await opts.store.appendInbound(threadId, {
      kind: "inbound",
      gmailMessageId: parsed.gmailMessageId,
      from: parsed.from,
      at: parsed.receivedAt,
      subject: parsed.subject,
      bodyText: parsed.bodyText,
      attachments: parsed.attachments,
    });
    await opts.client.markRead(id);
    opts.onAccepted(threadId);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
```

**Note:** attachment-bytes handling is simplified — a follow-up task (in v1.1) can fetch real bytes via `users.messages.attachments.get`. For v1 tests and dogfood, filenames + metadata are the hot path.

- [ ] **Step 2: Compile**

Run: `cd packages/ava && npx tsc -p tsconfig.build.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ava/src/gmail/poller.ts
git commit -m "ava: Gmail poller with backoff and allowlist wiring"
```

---

## Phase 3 — Backends

### Task 14: Backend interface + FailureKind

**Files:**
- Create: `packages/ava/src/backends/types.ts`

- [ ] **Step 1: Write the interface**

Create `packages/ava/src/backends/types.ts`:

```ts
import type { BackendName, FailureKind } from "../types.js";

export interface BackendRunOpts {
  threadId: string;
  cwdInContainer: string;            // absolute path inside sandbox, e.g. /workspace/threads/T-abc/worktree
  prompt: string;
  dataDir: string;                   // host path to ./data/, used to persist session pointer
  timeoutMs: number;
  sandboxExec: (
    argv: string[],
    opts: { env?: Record<string, string>; timeoutMs: number; workdir?: string },
  ) => Promise<BackendRunResult>;
}

export interface BackendRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface Backend {
  name: BackendName;
  run(opts: BackendRunOpts): Promise<BackendRunResult>;
  classify(result: BackendRunResult): FailureKind;
}
```

- [ ] **Step 2: Compile**

Run: `cd packages/ava && npx tsc -p tsconfig.build.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ava/src/backends/types.ts
git commit -m "ava: Backend interface + result types"
```

### Task 15: Fake CLI shim harness (test fixtures)

**Files:**
- Create: `packages/ava/test/fixtures/shims/fake-cli.sh`
- Create: `packages/ava/test/helpers/shim.ts`

- [ ] **Step 1: Create the generic fake CLI shim**

Create `packages/ava/test/fixtures/shims/fake-cli.sh`:

```bash
#!/usr/bin/env bash
# Generic fake CLI shim used by backend tests.
# Behavior is controlled via env vars set in the test:
#   FAKE_EXIT      - exit code (default 0)
#   FAKE_STDOUT    - text written to stdout
#   FAKE_STDERR    - text written to stderr
#   FAKE_WRITE     - path (optional) to touch/write 'ok' into, for simulating session-id emission
set -euo pipefail
if [ -n "${FAKE_STDOUT:-}" ]; then printf "%s" "$FAKE_STDOUT"; fi
if [ -n "${FAKE_STDERR:-}" ]; then printf "%s" "$FAKE_STDERR" 1>&2; fi
if [ -n "${FAKE_WRITE:-}" ]; then printf "fake-session-id" > "$FAKE_WRITE"; fi
exit "${FAKE_EXIT:-0}"
```

Mark executable:

```bash
chmod +x packages/ava/test/fixtures/shims/fake-cli.sh
```

- [ ] **Step 2: Write the helper that runs the shim like `sandboxExec`**

Create `packages/ava/test/helpers/shim.ts`:

```ts
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { BackendRunResult } from "../../src/backends/types.js";

const shim = join(__dirname, "../fixtures/shims/fake-cli.sh");

export function makeShimExec(env: Record<string, string>) {
  return async (argv: string[], _opts: { env?: Record<string, string>; timeoutMs: number }): Promise<BackendRunResult> => {
    const start = Date.now();
    return new Promise((resolve) => {
      const c = spawn(shim, argv, { env: { ...process.env, ...env } });
      let out = "";
      let err = "";
      c.stdout.on("data", (d) => (out += d.toString()));
      c.stderr.on("data", (d) => (err += d.toString()));
      c.on("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout: out,
          stderr: err,
          durationMs: Date.now() - start,
          timedOut: false,
        });
      });
    });
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/ava/test/fixtures/shims/fake-cli.sh packages/ava/test/helpers/shim.ts
git commit -m "ava: fake CLI shim harness for backend tests"
```

### Task 16: Claude Code backend

**Files:**
- Create: `packages/ava/src/backends/claude-code.ts`
- Create: `packages/ava/test/backends/claude-code.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/ava/test/backends/claude-code.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeBackend } from "../../src/backends/claude-code.js";
import { makeShimExec } from "../helpers/shim.js";

describe("ClaudeCodeBackend", () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ava-cc-"));
    await mkdir(join(dir, "threads", "T-1"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("classifies a known rate-limit stderr as rate-limit", () => {
    const b = new ClaudeCodeBackend();
    expect(
      b.classify({ exitCode: 1, stdout: "", stderr: "Error: rate limit exceeded. retry after 300s", durationMs: 1, timedOut: false }),
    ).toBe("rate-limit");
  });

  it("classifies an auth-expired stderr as auth", () => {
    const b = new ClaudeCodeBackend();
    expect(
      b.classify({ exitCode: 1, stdout: "", stderr: "Authentication token expired. Please re-login.", durationMs: 1, timedOut: false }),
    ).toBe("auth");
  });

  it("classifies exit 0 as ok", () => {
    const b = new ClaudeCodeBackend();
    expect(b.classify({ exitCode: 0, stdout: "done", stderr: "", durationMs: 1, timedOut: false })).toBe("ok");
  });

  it("classifies other nonzero exits as crash", () => {
    const b = new ClaudeCodeBackend();
    expect(b.classify({ exitCode: 9, stdout: "", stderr: "segfault", durationMs: 1, timedOut: false })).toBe("crash");
  });

  it("on first run, generates a UUID, writes it to the pointer, and passes --session-id <uuid>", async () => {
    const b = new ClaudeCodeBackend();
    const sessionFile = join(dir, "threads", "T-1", "claude-session-id");
    let capturedArgv: string[] = [];
    const result = await b.run({
      threadId: "T-1",
      cwdInContainer: "/workspace/threads/T-1/worktree",
      prompt: "hello",
      dataDir: dir,
      timeoutMs: 5_000,
      sandboxExec: async (argv) => {
        capturedArgv = argv;
        return { exitCode: 0, stdout: "final reply text", stderr: "", durationMs: 1, timedOut: false };
      },
    });
    expect(result.exitCode).toBe(0);
    const storedId = (await readFile(sessionFile, "utf-8")).trim();
    expect(storedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(capturedArgv).toContain("--session-id");
    expect(capturedArgv).toContain(storedId);
  });

  it("on subsequent runs, passes the stored session id via --resume", async () => {
    const b = new ClaudeCodeBackend();
    const sessionFile = join(dir, "threads", "T-1", "claude-session-id");
    await writeFile(sessionFile, "existing-id");
    let capturedArgv: string[] = [];
    const result = await b.run({
      threadId: "T-1",
      cwdInContainer: "/workspace/threads/T-1/worktree",
      prompt: "second message",
      dataDir: dir,
      timeoutMs: 5_000,
      sandboxExec: async (argv, opts) => {
        capturedArgv = argv;
        return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, timedOut: false };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(capturedArgv).toContain("--resume");
    expect(capturedArgv).toContain("existing-id");
  });

  it("forwards the worktree path to sandboxExec as workdir, not as a CLI flag", async () => {
    const b = new ClaudeCodeBackend();
    let capturedOpts: { workdir?: string } = {};
    let capturedArgv: string[] = [];
    await b.run({
      threadId: "T-1",
      cwdInContainer: "/workspace/threads/T-1/worktree",
      prompt: "hi",
      dataDir: dir,
      timeoutMs: 5_000,
      sandboxExec: async (argv, opts) => {
        capturedArgv = argv;
        capturedOpts = opts;
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
      },
    });
    expect(capturedOpts.workdir).toBe("/workspace/threads/T-1/worktree");
    expect(capturedArgv).not.toContain("--cwd"); // verified absent by spike
  });
});
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cd packages/ava && npx vitest run test/backends/claude-code.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the backend**

Spike findings from Task 1 (see `packages/ava/docs/cli-flags.md`):
- Claude Code has **no `--cwd` flag.** Set working directory via `docker exec --workdir` — Ava's `sandboxExec` helper supports this through the BackendRunOpts.cwdInContainer parameter it passes on.
- Claude Code has **no `--output-session-id`.** Ava pre-generates a UUID on first run, passes it as `--session-id <uuid>`, and persists it to the pointer file.
- On subsequent runs, pass `--resume <uuid>` where the uuid comes from the pointer file.

Create `packages/ava/src/backends/claude-code.ts`:

```ts
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Backend, BackendRunOpts, BackendRunResult } from "./types.js";
import type { FailureKind } from "../types.js";

// NOTE: flag names match Task 1 verification. Update here in one place if the CLI changes.
const ARGV_PRINT = "-p";
const ARGV_RESUME = "--resume";
const ARGV_SESSION_ID = "--session-id";
const ARGV_SKIP_PERMS = "--dangerously-skip-permissions";

const RATE_LIMIT_RX = /rate\s*limit|quota|429|retry after/i;
const AUTH_RX = /(authentication|auth).*(expired|invalid|required|revoked)|please re-?login/i;

export class ClaudeCodeBackend implements Backend {
  readonly name = "claude-code" as const;

  async run(opts: BackendRunOpts): Promise<BackendRunResult> {
    const sessionFile = sessionPath(opts);
    const argv: string[] = ["claude", ARGV_SKIP_PERMS];
    if (existsSync(sessionFile)) {
      const id = (await readFile(sessionFile, "utf-8")).trim();
      argv.push(ARGV_RESUME, id);
    } else {
      const id = randomUUID();
      await mkdir(dirname(sessionFile), { recursive: true });
      await writeFile(sessionFile, id);
      argv.push(ARGV_SESSION_ID, id);
    }
    argv.push(ARGV_PRINT, opts.prompt);
    // cwd is forwarded to docker exec via sandboxExec; not a CLI flag.
    return opts.sandboxExec(argv, { timeoutMs: opts.timeoutMs, workdir: opts.cwdInContainer });
  }

  classify(r: BackendRunResult): FailureKind {
    if (r.exitCode === 0) return "ok";
    if (AUTH_RX.test(r.stderr)) return "auth";
    if (RATE_LIMIT_RX.test(r.stderr)) return "rate-limit";
    return "crash";
  }
}

function sessionPath(opts: BackendRunOpts): string {
  return join(opts.dataDir, "threads", opts.threadId, "claude-session-id");
}
```

- [ ] **Step 4: Run tests and see them pass**

Run: `cd packages/ava && npx vitest run test/backends/claude-code.test.ts`
Expected: 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/ava/src/backends/claude-code.ts packages/ava/test/backends/claude-code.test.ts
git commit -m "ava: claude-code backend"
```

### Task 17: Codex backend

**Files:**
- Create: `packages/ava/src/backends/codex.ts`
- Create: `packages/ava/test/backends/codex.test.ts`

- [ ] **Step 1: Write the failing test (mirror claude-code test)**

Create `packages/ava/test/backends/codex.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexBackend } from "../../src/backends/codex.js";
import { makeShimExec } from "../helpers/shim.js";

describe("CodexBackend", () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ava-cx-"));
    await mkdir(join(dir, "threads", "T-1"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("classifies rate-limit patterns from Codex", () => {
    const b = new CodexBackend();
    expect(
      b.classify({ exitCode: 1, stdout: "", stderr: "429 Too Many Requests — quota exhausted", durationMs: 1, timedOut: false }),
    ).toBe("rate-limit");
  });

  it("classifies auth patterns from Codex", () => {
    const b = new CodexBackend();
    expect(
      b.classify({ exitCode: 1, stdout: "", stderr: "401 Unauthorized: please login again", durationMs: 1, timedOut: false }),
    ).toBe("auth");
  });

  it("on first run, writes session id from output", async () => {
    const b = new CodexBackend();
    const sessionFile = join(dir, "threads", "T-1", "codex-session-id");
    const result = await b.run({
      threadId: "T-1",
      cwdInContainer: "/workspace/threads/T-1/worktree",
      prompt: "hi",
      dataDir: dir,
      timeoutMs: 5_000,
      sandboxExec: makeShimExec({ FAKE_STDOUT: "ok", FAKE_WRITE: sessionFile }),
    });
    expect(result.exitCode).toBe(0);
    expect((await readFile(sessionFile, "utf-8")).trim()).toBe("fake-session-id");
  });

  it("on subsequent runs, includes the stored session id", async () => {
    const b = new CodexBackend();
    const sessionFile = join(dir, "threads", "T-1", "codex-session-id");
    await writeFile(sessionFile, "prev-id");
    let argvSeen: string[] = [];
    await b.run({
      threadId: "T-1",
      cwdInContainer: "/workspace/threads/T-1/worktree",
      prompt: "second",
      dataDir: dir,
      timeoutMs: 5_000,
      sandboxExec: async (argv) => {
        argvSeen = argv;
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
      },
    });
    expect(argvSeen).toContain("prev-id");
  });
});
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cd packages/ava && npx vitest run test/backends/codex.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Spike findings (see `packages/ava/docs/cli-flags.md` Codex section):
- Codex is **subcommand-based**, not flag-based. Non-interactive is `codex exec [OPTS] "<PROMPT>"`; resume is `codex exec resume <session-uuid> "<PROMPT>"`.
- **First-run session UUID cannot be pre-assigned.** Codex generates it internally. To capture it, pass `--json` so Codex streams JSONL events; parse the first line that includes a `session_id` field; persist to the `codex-session-id` pointer.
- `-o, --output-last-message <FILE>` captures the final reply text to a file (cleaner than parsing from stdout when `--json` is on).
- `-C, --cd <DIR>` exists on `codex exec` (first run) but NOT on `codex exec resume`. Since we're setting cwd via `docker exec --workdir` anyway, we do not pass `-C` at all.
- `-m, --model <MODEL>` confirmed; skip-permissions flag is `--dangerously-bypass-approvals-and-sandbox`.

Create `packages/ava/src/backends/codex.ts`:

```ts
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Backend, BackendRunOpts, BackendRunResult } from "./types.js";
import type { FailureKind } from "../types.js";

const MODEL = "gpt-5.4";
const SKIP_PERMS = "--dangerously-bypass-approvals-and-sandbox";

const RATE_LIMIT_RX = /rate\s*limit|quota|429|too many requests/i;
const AUTH_RX = /401\b|unauthorized|please (re-?)?login|auth.*(expired|invalid)/i;

const SESSION_EVENT_RX = /"session_id"\s*:\s*"([0-9a-f-]{36})"/i;

export class CodexBackend implements Backend {
  readonly name = "codex" as const;

  async run(opts: BackendRunOpts): Promise<BackendRunResult> {
    const sessionFile = join(opts.dataDir, "threads", opts.threadId, "codex-session-id");
    const outFile = join(opts.dataDir, "threads", opts.threadId, "codex-last.txt");
    await mkdir(dirname(sessionFile), { recursive: true });
    if (existsSync(outFile)) await unlink(outFile);

    const argv: string[] = ["codex", "exec"];
    const resuming = existsSync(sessionFile);
    if (resuming) {
      const id = (await readFile(sessionFile, "utf-8")).trim();
      argv.splice(2, 0, "resume", id);    // argv becomes: codex exec resume <id>
    }
    argv.push("-m", MODEL, SKIP_PERMS, "--json", "-o", outFile, opts.prompt);

    const result = await opts.sandboxExec(argv, { timeoutMs: opts.timeoutMs, workdir: opts.cwdInContainer });

    if (!resuming && result.exitCode === 0) {
      const sid = extractSessionId(result.stdout) ?? extractSessionId(result.stderr);
      if (sid) await writeFile(sessionFile, sid);
    }

    if (result.exitCode === 0 && existsSync(outFile)) {
      // Prefer the captured reply file over stdout (stdout is JSONL events with --json).
      result.stdout = await readFile(outFile, "utf-8");
    }
    return result;
  }

  classify(r: BackendRunResult): FailureKind {
    if (r.exitCode === 0) return "ok";
    if (AUTH_RX.test(r.stderr)) return "auth";
    if (RATE_LIMIT_RX.test(r.stderr)) return "rate-limit";
    return "crash";
  }
}

function extractSessionId(text: string): string | null {
  const m = text.match(SESSION_EVENT_RX);
  return m ? m[1] : null;
}
```

- [ ] **Step 4: Run tests and see them pass**

Run: `cd packages/ava && npx vitest run test/backends/codex.test.ts`
Expected: 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/ava/src/backends/codex.ts packages/ava/test/backends/codex.test.ts
git commit -m "ava: codex backend (GPT-5.4)"
```

### Task 18: pi backend

**Files:**
- Create: `packages/ava/src/backends/pi.ts`
- Create: `packages/ava/test/backends/pi.test.ts`

- [ ] **Step 1: Write the failing test (pi uses inline session file, not pointer)**

Create `packages/ava/test/backends/pi.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiBackend } from "../../src/backends/pi.js";

describe("PiBackend", () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ava-pi-"));
    await mkdir(join(dir, "threads", "T-1"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes --session pointing at the in-tree pi-session.jsonl and forwards cwd via workdir", async () => {
    const b = new PiBackend();
    let argvSeen: string[] = [];
    let optsSeen: { workdir?: string } = {};
    await b.run({
      threadId: "T-1",
      cwdInContainer: "/workspace/threads/T-1/worktree",
      prompt: "hi",
      dataDir: dir,
      timeoutMs: 5_000,
      sandboxExec: async (argv, opts) => {
        argvSeen = argv;
        optsSeen = opts;
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
      },
    });
    expect(argvSeen).toContain("--session");
    const sessionIdx = argvSeen.indexOf("--session");
    expect(argvSeen[sessionIdx + 1]).toMatch(/pi-session\.jsonl$/);
    expect(argvSeen).not.toContain("--cwd"); // verified absent by spike
    expect(optsSeen.workdir).toBe("/workspace/threads/T-1/worktree");
  });

  it("classifies pi-ai rate-limit stderr", () => {
    const b = new PiBackend();
    expect(
      b.classify({ exitCode: 1, stdout: "", stderr: "pi-ai: rate_limit_error (429)", durationMs: 1, timedOut: false }),
    ).toBe("rate-limit");
  });
});
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cd packages/ava && npx vitest run test/backends/pi.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Spike findings (see `cli-flags.md` pi section): `--cwd` does NOT exist on pi. Set cwd via `docker exec --workdir` (the `sandboxExec` helper takes `workdir` in its opts, and pi reads the spawn cwd correctly).

Create `packages/ava/src/backends/pi.ts`:

```ts
import { join } from "node:path";
import type { Backend, BackendRunOpts, BackendRunResult } from "./types.js";
import type { FailureKind } from "../types.js";

const RATE_LIMIT_RX = /rate[_\s]*limit|quota|429/i;
const AUTH_RX = /auth.*(expired|invalid|required)|please re-?login|oauth.*(revoked|invalid)/i;

export class PiBackend implements Backend {
  readonly name = "pi" as const;

  async run(opts: BackendRunOpts): Promise<BackendRunResult> {
    const sessionPath = join(opts.dataDir, "threads", opts.threadId, "pi-session.jsonl");
    const argv: string[] = [
      "pi",
      "--session", sessionPath,
      "--no-context-files",
      "-p", opts.prompt,
    ];
    return opts.sandboxExec(argv, { timeoutMs: opts.timeoutMs, workdir: opts.cwdInContainer });
  }

  classify(r: BackendRunResult): FailureKind {
    if (r.exitCode === 0) return "ok";
    if (AUTH_RX.test(r.stderr)) return "auth";
    if (RATE_LIMIT_RX.test(r.stderr)) return "rate-limit";
    return "crash";
  }
}
```

- [ ] **Step 4: Run tests and see them pass**

Run: `cd packages/ava && npx vitest run test/backends/pi.test.ts`
Expected: 2 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/ava/src/backends/pi.ts packages/ava/test/backends/pi.test.ts
git commit -m "ava: pi backend (opt-in, TOS caveat)"
```

### Task 19: Backend selection policy

**Files:**
- Create: `packages/ava/src/backends/select.ts`
- Create: `packages/ava/test/backends/select.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/ava/test/backends/select.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  parseBackendDirective,
  selectBackend,
  shouldEmitPiTosWarning,
} from "../../src/backends/select.js";
import type { BackendName } from "../../src/types.js";

describe("parseBackendDirective", () => {
  it("finds @ava:use=codex", () => {
    expect(parseBackendDirective("please do X @ava:use=codex")).toBe("codex");
  });
  it("is case-insensitive", () => {
    expect(parseBackendDirective("@AVA:USE=Claude-Code go")).toBe("claude-code");
  });
  it("returns null if no directive", () => {
    expect(parseBackendDirective("just a normal email")).toBeNull();
  });
  it("returns null for invalid backend name", () => {
    expect(parseBackendDirective("@ava:use=gemini")).toBeNull();
  });
});

describe("selectBackend", () => {
  it("honors directive when present", () => {
    const r = selectBackend({ settingsDefault: "claude-code", settingsFallback: "codex", directive: "pi" });
    expect(r.primary).toBe("pi");
    expect(r.fallback).toBeNull(); // directive overrides fallback too
  });
  it("defaults to settings primary+fallback when no directive", () => {
    const r = selectBackend({ settingsDefault: "claude-code", settingsFallback: "codex", directive: null });
    expect(r.primary).toBe("claude-code");
    expect(r.fallback).toBe("codex");
  });
  it("omits fallback if not configured", () => {
    const r = selectBackend({ settingsDefault: "codex", settingsFallback: null, directive: null });
    expect(r.fallback).toBeNull();
  });
});

describe("shouldEmitPiTosWarning", () => {
  it("warns when pi is default", () => {
    expect(shouldEmitPiTosWarning({ default: "pi", fallback: null })).toBe(true);
  });
  it("warns when pi is fallback", () => {
    expect(shouldEmitPiTosWarning({ default: "claude-code", fallback: "pi" })).toBe(true);
  });
  it("does not warn when pi is neither", () => {
    expect(shouldEmitPiTosWarning({ default: "claude-code", fallback: "codex" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cd packages/ava && npx vitest run test/backends/select.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `packages/ava/src/backends/select.ts`:

```ts
import type { BackendName } from "../types.js";

const DIRECTIVE_RX = /@ava:use=([a-z-]+)/i;
const VALID: BackendName[] = ["claude-code", "codex", "pi"];

export function parseBackendDirective(body: string): BackendName | null {
  const m = body.match(DIRECTIVE_RX);
  if (!m) return null;
  const v = m[1].toLowerCase() as BackendName;
  return VALID.includes(v) ? v : null;
}

export interface BackendSelection {
  primary: BackendName;
  fallback: BackendName | null;
}

export function selectBackend(opts: {
  settingsDefault: BackendName;
  settingsFallback: BackendName | null;
  directive: BackendName | null;
}): BackendSelection {
  if (opts.directive) {
    return { primary: opts.directive, fallback: null };
  }
  return { primary: opts.settingsDefault, fallback: opts.settingsFallback };
}

export function shouldEmitPiTosWarning(cfg: { default: BackendName; fallback: BackendName | null }): boolean {
  return cfg.default === "pi" || cfg.fallback === "pi";
}
```

- [ ] **Step 4: Run tests and see them pass**

Run: `cd packages/ava && npx vitest run test/backends/select.test.ts`
Expected: 10 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/ava/src/backends/select.ts packages/ava/test/backends/select.test.ts
git commit -m "ava: backend selection policy + @ava:use directive"
```

---

## Phase 4 — Execution

### Task 20: Worktree manager

**Files:**
- Create: `packages/ava/src/worktree.ts`
- Create: `packages/ava/test/worktree.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/ava/test/worktree.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager } from "../src/worktree.js";

function sh(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "pipe" });
}

describe("WorktreeManager", () => {
  let dir: string;
  let bareRepo: string;
  let threadsRoot: string;
  let wm: WorktreeManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ava-wt-"));
    // Create a real bare repo from a seed workdir so worktree operations work against real git
    const seed = join(dir, "seed");
    await mkdir(seed);
    sh("git init -b main", seed);
    sh("git config user.email 'test@example.com'", seed);
    sh("git config user.name 'Test'", seed);
    await writeFile(join(seed, "README.md"), "seed\n");
    sh("git add .", seed);
    sh("git commit -m initial", seed);

    bareRepo = join(dir, "repo.git");
    sh(`git clone --bare "${seed}" "${bareRepo}"`, dir);

    threadsRoot = join(dir, "threads");
    await mkdir(threadsRoot);
    wm = new WorktreeManager({ bareRepoPath: bareRepo, threadsRoot });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates a worktree for a new thread", async () => {
    const path = await wm.ensureWorktree("T-abc1234");
    expect(path).toBe(join(threadsRoot, "T-abc1234", "worktree"));
    expect(existsSync(join(path, ".git"))).toBe(true);
    expect(existsSync(join(path, "README.md"))).toBe(true);
  });

  it("reuses an existing worktree on the second call", async () => {
    const p1 = await wm.ensureWorktree("T-abc1234");
    const p2 = await wm.ensureWorktree("T-abc1234");
    expect(p1).toBe(p2);
  });

  it("cleanup removes the worktree but keeps branch reachable", async () => {
    await wm.ensureWorktree("T-xyz00000");
    await wm.cleanupThread("T-xyz00000");
    expect(existsSync(join(threadsRoot, "T-xyz00000", "worktree"))).toBe(false);
    // Branch still lives in the bare repo
    const branches = execSync(`git -C "${bareRepo}" branch --list "ava/*"`, { encoding: "utf-8" });
    expect(branches).toContain("ava/T-xyz00");
  });
});
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cd packages/ava && npx vitest run test/worktree.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `packages/ava/src/worktree.ts`:

```ts
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileP = promisify(execFile);

export interface WorktreeManagerOpts {
  bareRepoPath: string;   // absolute path to repo.git
  threadsRoot: string;    // absolute path to threads/
}

export class WorktreeManager {
  constructor(private opts: WorktreeManagerOpts) {}

  async ensureWorktree(threadId: string): Promise<string> {
    const wtPath = join(this.opts.threadsRoot, threadId, "worktree");
    const branch = `ava/${threadId.slice(0, 8)}`;
    if (existsSync(wtPath)) return wtPath;
    await execFileP("git", ["-C", this.opts.bareRepoPath, "worktree", "add", "-B", branch, wtPath]);
    return wtPath;
  }

  async cleanupThread(threadId: string): Promise<void> {
    const wtPath = join(this.opts.threadsRoot, threadId, "worktree");
    if (!existsSync(wtPath)) return;
    await execFileP("git", ["-C", this.opts.bareRepoPath, "worktree", "remove", "--force", wtPath]);
  }

  async fetch(): Promise<void> {
    await execFileP("git", ["-C", this.opts.bareRepoPath, "fetch", "--prune", "--all"]);
  }

  async prune(maxInactiveMs: number, store: { threadLastActivityMs: (id: string) => Promise<number>; listThreadIds: () => Promise<string[]> }): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const tid of await store.listThreadIds()) {
      const wtPath = join(this.opts.threadsRoot, tid, "worktree");
      if (!existsSync(wtPath)) continue;
      const last = await store.threadLastActivityMs(tid);
      if (now - last > maxInactiveMs) {
        await this.cleanupThread(tid);
        removed++;
      }
    }
    return removed;
  }
}
```

- [ ] **Step 4: Run tests and see them pass**

Run: `cd packages/ava && npx vitest run test/worktree.test.ts`
Expected: 3 tests passing. (Test runs against a real local bare repo, no network needed.)

- [ ] **Step 5: Commit**

```bash
git add packages/ava/src/worktree.ts packages/ava/test/worktree.test.ts
git commit -m "ava: worktree manager with ensure/cleanup/fetch/prune"
```

### Task 21: Dispatcher (per-thread FIFO)

**Files:**
- Create: `packages/ava/src/dispatcher.ts`
- Create: `packages/ava/test/dispatcher.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/ava/test/dispatcher.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Dispatcher } from "../src/dispatcher.js";

describe("Dispatcher", () => {
  it("coalesces repeat enqueues while a thread is queued (idempotent enqueue)", async () => {
    let runs = 0;
    const d = new Dispatcher(async () => { runs++; });
    d.enqueue("A");
    d.enqueue("A");
    d.enqueue("A");
    await d.drain();
    expect(runs).toBe(1);
  });

  it("picks up a re-enqueue that arrives during an active run", async () => {
    const order: string[] = [];
    const d = new Dispatcher(async (tid) => {
      order.push(`start ${tid}`);
      if (order.length === 1) d.enqueue("A"); // re-enqueue while active
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end ${tid}`);
    });
    d.enqueue("A");
    await d.drain();
    expect(order).toEqual(["start A", "end A", "start A", "end A"]);
  });

  it("runs different threads sequentially in v1 (single worker)", async () => {
    const order: string[] = [];
    const d = new Dispatcher(async (tid) => {
      order.push(`start ${tid}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end ${tid}`);
    });
    d.enqueue("A");
    d.enqueue("B");
    await d.drain();
    expect(order).toEqual(["start A", "end A", "start B", "end B"]);
  });
});
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cd packages/ava && npx vitest run test/dispatcher.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `packages/ava/src/dispatcher.ts`:

```ts
export type ThreadRunner = (threadId: string) => Promise<void>;

export class Dispatcher {
  private pending = new Set<string>();
  private queue: string[] = [];
  private active = false;

  constructor(private runner: ThreadRunner) {}

  enqueue(threadId: string): void {
    if (this.pending.has(threadId)) return;
    this.pending.add(threadId);
    this.queue.push(threadId);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      while (this.queue.length > 0) {
        const tid = this.queue.shift()!;
        this.pending.delete(tid);
        await this.runner(tid);
      }
    } finally {
      this.active = false;
    }
  }

  async drain(): Promise<void> {
    while (this.active || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}
```

- [ ] **Step 4: Run tests and see them pass**

Run: `cd packages/ava && npx vitest run test/dispatcher.test.ts`
Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/ava/src/dispatcher.ts packages/ava/test/dispatcher.test.ts
git commit -m "ava: per-thread FIFO dispatcher"
```

### Task 22: Sandbox docker-exec helper

**Files:**
- Create: `packages/ava/src/sandbox.ts`

- [ ] **Step 1: Implement**

Create `packages/ava/src/sandbox.ts`:

```ts
import { spawn } from "node:child_process";
import type { BackendRunResult } from "./backends/types.js";

export interface SandboxExecOpts {
  env?: Record<string, string>;
  timeoutMs: number;
  workdir?: string;      // forwarded as `docker exec --workdir <path>` (none of the agent CLIs have --cwd)
}

export interface SandboxConfig {
  containerName: string;
}

export function makeSandboxExec(cfg: SandboxConfig) {
  return async (argv: string[], opts: SandboxExecOpts): Promise<BackendRunResult> => {
    const dockerArgv = ["exec", "-i"];
    if (opts.workdir) dockerArgv.push("--workdir", opts.workdir);
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      dockerArgv.push("-e", `${k}=${v}`);
    }
    dockerArgv.push(cfg.containerName, ...argv);
    const start = Date.now();
    return new Promise((resolve) => {
      const c = spawn("docker", dockerArgv, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        c.kill("SIGKILL");
      }, opts.timeoutMs);
      c.stdout.on("data", (d) => (out += d.toString()));
      c.stderr.on("data", (d) => (err += d.toString()));
      c.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout: out,
          stderr: err,
          durationMs: Date.now() - start,
          timedOut,
        });
      });
    });
  };
}
```

- [ ] **Step 2: Compile**

Run: `cd packages/ava && npx tsc -p tsconfig.build.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ava/src/sandbox.ts
git commit -m "ava: sandbox docker-exec helper with timeout + stream capture"
```

### Task 23: Prompt builder

**Files:**
- Create: `packages/ava/src/prompt-builder.ts`
- Create: `packages/ava/test/prompt-builder.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/ava/test/prompt-builder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/prompt-builder.js";

describe("buildPrompt", () => {
  it("includes sender, subject, and body", () => {
    const p = buildPrompt({
      isFirstRun: false,
      newestMessage: {
        from: "brian@actualvoice.ai",
        subject: "typo fix",
        bodyText: "fix the typo on /signup",
      },
      worktreePath: "/workspace/threads/T-1/worktree",
      outgoingPath: "./outgoing",
      globalMemory: "",
      threadMemory: "",
    });
    expect(p).toContain("brian@actualvoice.ai");
    expect(p).toContain("typo fix");
    expect(p).toContain("fix the typo on /signup");
    expect(p).toContain("/workspace/threads/T-1/worktree");
    expect(p).toContain("./outgoing");
  });

  it("includes memory on first run only", () => {
    const first = buildPrompt({
      isFirstRun: true,
      newestMessage: { from: "u@v", subject: "s", bodyText: "b" },
      worktreePath: "/w",
      outgoingPath: "./outgoing",
      globalMemory: "GLOBAL_MEM",
      threadMemory: "THREAD_MEM",
    });
    expect(first).toContain("GLOBAL_MEM");
    expect(first).toContain("THREAD_MEM");

    const later = buildPrompt({
      isFirstRun: false,
      newestMessage: { from: "u@v", subject: "s", bodyText: "b" },
      worktreePath: "/w",
      outgoingPath: "./outgoing",
      globalMemory: "GLOBAL_MEM",
      threadMemory: "THREAD_MEM",
    });
    expect(later).not.toContain("GLOBAL_MEM");
    expect(later).not.toContain("THREAD_MEM");
  });

  it("strips the @ava:use directive from the body shown to the agent", () => {
    const p = buildPrompt({
      isFirstRun: false,
      newestMessage: { from: "u@v", subject: "s", bodyText: "please do X @ava:use=codex thanks" },
      worktreePath: "/w",
      outgoingPath: "./outgoing",
      globalMemory: "",
      threadMemory: "",
    });
    expect(p).not.toContain("@ava:use");
  });
});
```

- [ ] **Step 2: Run tests and see them fail**

Run: `cd packages/ava && npx vitest run test/prompt-builder.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `packages/ava/src/prompt-builder.ts`:

```ts
const DIRECTIVE_STRIP = /@ava:use=[a-z-]+/gi;

export interface BuildPromptInput {
  isFirstRun: boolean;
  newestMessage: { from: string; subject: string; bodyText: string };
  worktreePath: string;
  outgoingPath: string;
  globalMemory: string;
  threadMemory: string;
}

export function buildPrompt(input: BuildPromptInput): string {
  const sections: string[] = [];
  sections.push(
    `You are Ava, an engineering teammate for ActualVoice. You are replying to an email from ${input.newestMessage.from}. Your response will be sent as an email reply, so write it as a human-readable message (plain text, code fences ok). Working directory: ${input.worktreePath}. Files you want attached to your reply must be written to ${input.outgoingPath}/.`,
  );
  if (input.isFirstRun) {
    if (input.globalMemory) sections.push(`## Global memory\n${input.globalMemory}`);
    if (input.threadMemory) sections.push(`## Thread memory\n${input.threadMemory}`);
  }
  const cleanBody = input.newestMessage.bodyText.replace(DIRECTIVE_STRIP, "").trim();
  sections.push(`## Incoming email\nSubject: ${input.newestMessage.subject}\nFrom: ${input.newestMessage.from}\n\n${cleanBody}`);
  return sections.join("\n\n");
}
```

- [ ] **Step 4: Run tests and see them pass**

Run: `cd packages/ava && npx vitest run test/prompt-builder.test.ts`
Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/ava/src/prompt-builder.ts packages/ava/test/prompt-builder.test.ts
git commit -m "ava: prompt builder with memory gate and directive stripping"
```

### Task 24: Agent invoker (per-run orchestrator)

**Files:**
- Create: `packages/ava/src/agent-invoker.ts`

This glues everything together. No unit test directly — exercised by integration tests and by manual end-to-end runs. Code is straight-line and narrow.

- [ ] **Step 1: Implement**

Create `packages/ava/src/agent-invoker.ts`:

```ts
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Backend, BackendRunOpts, BackendRunResult } from "./backends/types.js";
import type { AvaSettings, BackendName, FailureKind, OutboundReply } from "./types.js";
import { ClaudeCodeBackend } from "./backends/claude-code.js";
import { CodexBackend } from "./backends/codex.js";
import { PiBackend } from "./backends/pi.js";
import { parseBackendDirective, selectBackend } from "./backends/select.js";
import { buildPrompt } from "./prompt-builder.js";
import { normalizeReply } from "./reply-format.js";
import { scanOutgoing, clearOutgoing } from "./outgoing.js";
import { Store } from "./store.js";
import { log } from "./log.js";

export interface AgentInvokerDeps {
  store: Store;
  settings: AvaSettings;
  allowedBackends: Record<BackendName, Backend>;
  ensureWorktree: (tid: string) => Promise<string>;
  sandboxExec: BackendRunOpts["sandboxExec"];
  cwdInContainer: (tid: string) => string;
  sendAck: (tid: string, originalMessageId: string, to: string, subject: string) => Promise<void>;
  sendReply: (reply: OutboundReply) => Promise<string>;
  sendStatus: (tid: string, text: string, to: string, inReplyTo: string, subject: string) => Promise<void>;
}

export function defaultBackends(): Record<BackendName, Backend> {
  return {
    "claude-code": new ClaudeCodeBackend(),
    "codex": new CodexBackend(),
    "pi": new PiBackend(),
  };
}

export async function runThread(tid: string, deps: AgentInvokerDeps): Promise<void> {
  const { store, settings } = deps;
  const newestInbound = await readNewestInbound(store, tid);
  if (!newestInbound) return;

  await deps.sendAck(tid, newestInbound.gmailMessageId, newestInbound.from, reSubject(newestInbound.subject));

  await deps.ensureWorktree(tid);
  await clearOutgoing(store.threadPathAbs(tid));

  const directive = parseBackendDirective(newestInbound.bodyText);
  const { primary, fallback } = selectBackend({
    settingsDefault: settings.backend.default,
    settingsFallback: settings.backend.fallback,
    directive,
  });

  const globalMemory = await readIf(join(store.dataDir, "MEMORY.md"));
  const threadMemory = await readIf(join(store.threadPathAbs(tid), "MEMORY.md"));
  const isFirstRun =
    !existsSync(join(store.threadPathAbs(tid), "claude-session-id")) &&
    !existsSync(join(store.threadPathAbs(tid), "codex-session-id")) &&
    !existsSync(join(store.threadPathAbs(tid), "pi-session.jsonl"));
  const prompt = buildPrompt({
    isFirstRun,
    newestMessage: newestInbound,
    worktreePath: deps.cwdInContainer(tid),
    outgoingPath: "./outgoing",
    globalMemory,
    threadMemory,
  });

  let result = await runBackend(primary, deps, tid, prompt);
  let kind = deps.allowedBackends[primary].classify(result);
  if (kind === "rate-limit" && fallback) {
    await deps.sendStatus(
      tid,
      `${primary} is rate-limited. Trying ${fallback} as fallback; I'll continue this thread automatically.`,
      newestInbound.from,
      newestInbound.gmailMessageId,
      reSubject(newestInbound.subject),
    );
    result = await runBackend(fallback, deps, tid, prompt);
    kind = deps.allowedBackends[fallback].classify(result);
  }

  const backendUsed = kind === "ok" ? (fallback && result === (await result) ? primary : primary) : primary;

  if (kind !== "ok") {
    await handleFailure(kind, { deps, tid, newestInbound, primary, fallback, result });
    return;
  }

  const replyBody = normalizeReply(result.stdout);
  const { attached, overflow } = await scanOutgoing(
    store.threadPathAbs(tid),
    settings.attachments.perReplyMaxBytes,
  );
  const finalBody = overflow.length
    ? `${replyBody}\n\n---\n(Some files exceeded the 20MB attachment cap and were not attached: ${overflow.map((f) => f.filename).join(", ")}. Push these to the PR instead.)`
    : replyBody;

  const sentId = await deps.sendReply({
    threadId: tid,
    to: newestInbound.from,
    inReplyToMessageId: newestInbound.gmailMessageId,
    subject: reSubject(newestInbound.subject),
    bodyText: finalBody,
    attachments: attached.map((a) => ({ filename: a.filename, path: a.path, bytes: a.bytes })),
  });

  await store.appendOutbound(tid, {
    kind: "outbound",
    gmailMessageId: sentId,
    inReplyToMessageId: newestInbound.gmailMessageId,
    at: new Date().toISOString(),
    backendUsed,
    attachments: attached.map((a) => ({ filename: a.filename, bytes: a.bytes })),
  });
}

async function runBackend(
  name: BackendName,
  deps: AgentInvokerDeps,
  tid: string,
  prompt: string,
): Promise<BackendRunResult> {
  const backend = deps.allowedBackends[name];
  return backend.run({
    threadId: tid,
    cwdInContainer: deps.cwdInContainer(tid),
    prompt,
    dataDir: deps.store.dataDir,
    timeoutMs: deps.settings.timeouts.perRunMs,
    sandboxExec: deps.sandboxExec,
  });
}

async function handleFailure(
  kind: FailureKind,
  ctx: {
    deps: AgentInvokerDeps;
    tid: string;
    newestInbound: NewestInbound;
    primary: BackendName;
    fallback: BackendName | null;
    result: BackendRunResult;
  },
): Promise<void> {
  const { deps, tid, newestInbound, primary, result } = ctx;
  const subject = reSubject(newestInbound.subject);
  if (kind === "auth") {
    await deps.sendStatus(
      tid,
      `My ${primary} auth is broken. Please re-authenticate ${primary} on the host. I'll retry automatically once the credentials are refreshed.`,
      newestInbound.from,
      newestInbound.gmailMessageId,
      subject,
    );
    return;
  }
  if (kind === "rate-limit") {
    await deps.sendStatus(
      tid,
      `Hit rate limits on all configured backends. I'll resume this thread when quotas reset. Reply again any time to bump the queue.`,
      newestInbound.from,
      newestInbound.gmailMessageId,
      subject,
    );
    return;
  }
  // crash
  log.error("agent crash", { threadId: tid, exitCode: result.exitCode, stderr: result.stderr.slice(0, 4_000) });
  await deps.sendStatus(
    tid,
    `The agent subprocess exited with code ${result.exitCode}. Logs have been written to the thread directory. Reply to this email to retry.`,
    newestInbound.from,
    newestInbound.gmailMessageId,
    subject,
  );
}

interface NewestInbound {
  gmailMessageId: string;
  from: string;
  subject: string;
  bodyText: string;
}

async function readNewestInbound(store: Store, tid: string): Promise<NewestInbound | null> {
  const log = join(store.threadPathAbs(tid), "log.jsonl");
  if (!existsSync(log)) return null;
  const content = await readFile(log, "utf-8");
  const rows = content.split("\n").filter(Boolean);
  for (let i = rows.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(rows[i]);
      if (row.kind === "inbound") {
        return {
          gmailMessageId: row.gmailMessageId,
          from: row.from,
          subject: row.subject,
          bodyText: row.bodyText,
        };
      }
    } catch {
      // skip
    }
  }
  return null;
}

async function readIf(path: string): Promise<string> {
  if (!existsSync(path)) return "";
  return readFile(path, "utf-8");
}

function reSubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}
```

- [ ] **Step 2: Compile**

Run: `cd packages/ava && npx tsc -p tsconfig.build.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ava/src/agent-invoker.ts
git commit -m "ava: per-run agent invoker with fallback + classification"
```

---

## Phase 5 — Entry + ops

### Task 25: setup-sandbox.sh

**Files:**
- Create: `packages/ava/scripts/setup-sandbox.sh`

- [ ] **Step 1: Write the script**

Create `packages/ava/scripts/setup-sandbox.sh`:

```bash
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
  # On Fedora, the :Z flag tells Docker to relabel bind mounts for SELinux.
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
  npm install -g @anthropic-ai/claude-code @openai/codex-cli @mariozechner/pi-coding-agent || true
'

# Host-side: create the bare repo if it does not exist yet
if [ ! -d "$DATA_DIR/repo.git" ]; then
  git clone --bare "$REPO_URL" "$DATA_DIR/repo.git"
fi

echo "Sandbox ready: container=$CONTAINER, data=$DATA_DIR"
echo "Next: run \`ava --data-dir $DATA_DIR --sandbox=docker:$CONTAINER\` after Gmail OAuth."
```

Mark executable:

```bash
chmod +x packages/ava/scripts/setup-sandbox.sh
```

- [ ] **Step 2: Commit**

```bash
git add packages/ava/scripts/setup-sandbox.sh
git commit -m "ava: setup-sandbox script (Docker + SELinux :Z + CLI installs)"
```

### Task 26: main.ts entry point + CLI

**Files:**
- Create: `packages/ava/src/main.ts`

- [ ] **Step 1: Implement**

Create `packages/ava/src/main.ts`:

```ts
#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { log } from "./log.js";
import { Store } from "./store.js";
import { Dispatcher } from "./dispatcher.js";
import { WorktreeManager } from "./worktree.js";
import { makeSandboxExec } from "./sandbox.js";
import { GmailClient } from "./gmail/client.js";
import { gmailAuthSetup } from "./gmail/oauth-setup.js";
import { runPoller } from "./gmail/poller.js";
import { defaultBackends, runThread } from "./agent-invoker.js";
import { shouldEmitPiTosWarning } from "./backends/select.js";
import { DEFAULT_SETTINGS, type AvaSettings } from "./types.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];
  if (subcommand === "auth:gmail") {
    const dataDir = process.env.AVA_DATA_DIR ?? "./data";
    await gmailAuthSetup({
      credentialsPath: join(dataDir, "gmail-credentials.json"),
      tokenPath: join(dataDir, "gmail-token.json"),
    });
    return;
  }

  const { values } = parseArgs({
    args: argv,
    options: {
      "data-dir": { type: "string", default: "./data" },
      sandbox: { type: "string", default: "docker:ava-sandbox" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(`Usage:
  ava auth:gmail                                   # first-time OAuth
  ava --data-dir <dir> --sandbox=docker:<name>     # run the service`);
    return;
  }

  const dataDir = values["data-dir"]!;
  const sandboxSpec = values.sandbox!;
  if (!sandboxSpec.startsWith("docker:")) {
    throw new Error(`Unsupported sandbox spec: ${sandboxSpec}. Use docker:<container-name>.`);
  }
  const containerName = sandboxSpec.slice("docker:".length);

  const settings = await loadSettings(dataDir);
  const store = new Store(dataDir);
  const allowlist = await loadAllowlist(dataDir);

  if (shouldEmitPiTosWarning(settings.backend)) {
    log.warn("pi backend is configured as default or fallback. Anthropic's OAuth is not clearly sanctioned in third-party apps. Prefer claude-code unless you need pi's features.");
  }

  const gmail = new GmailClient();
  await gmail.init({
    credentialsPath: join(dataDir, "gmail-credentials.json"),
    tokenPath: join(dataDir, "gmail-token.json"),
  });

  const wm = new WorktreeManager({
    bareRepoPath: join(dataDir, "repo.git"),
    threadsRoot: join(dataDir, "threads"),
  });

  const sandboxExec = makeSandboxExec({ containerName });
  const cwdInContainer = (tid: string) => `/workspace/threads/${tid}/worktree`;
  const backends = defaultBackends();

  const dispatcher = new Dispatcher(async (tid) => {
    try {
      await runThread(tid, {
        store,
        settings,
        allowedBackends: backends,
        ensureWorktree: (id) => wm.ensureWorktree(id),
        sandboxExec,
        cwdInContainer,
        sendAck: async (threadId, originalId, to, subject) => {
          await gmail.send({
            threadId,
            to,
            subject,
            bodyText: "On it. I'll reply when done.\n— Ava",
            inReplyTo: originalId,
            references: [originalId],
            attachments: [],
          });
        },
        sendReply: async (reply) => {
          return gmail.send({
            threadId: reply.threadId,
            to: reply.to,
            subject: reply.subject,
            bodyText: reply.bodyText,
            inReplyTo: reply.inReplyToMessageId,
            references: [reply.inReplyToMessageId],
            attachments: reply.attachments.map((a) => ({ filename: a.filename, path: a.path })),
          });
        },
        sendStatus: async (threadId, text, to, inReplyTo, subject) => {
          await gmail.send({ threadId, to, subject, bodyText: text, inReplyTo, references: [inReplyTo], attachments: [] });
        },
      });
    } catch (e) {
      log.error("runThread failed", { threadId: tid, error: String(e) });
    }
  });

  const shutdown = new AbortController();
  process.on("SIGINT", () => shutdown.abort());
  process.on("SIGTERM", () => shutdown.abort());

  // Periodic prune
  const pruneTimer = setInterval(async () => {
    try {
      const removed = await wm.prune(settings.prune.maxInactiveDays * 24 * 60 * 60 * 1000, store);
      if (removed > 0) log.info("pruned inactive worktrees", { removed });
    } catch (e) {
      log.warn("prune failed", { error: String(e) });
    }
  }, 24 * 60 * 60 * 1000);

  try {
    await runPoller({
      client: gmail,
      store,
      allowlist,
      intervalMs: settings.timeouts.gmailPollMs,
      query: "is:unread newer_than:7d -in:sent",
      onAccepted: (tid) => dispatcher.enqueue(tid),
      onStopSignal: shutdown.signal,
    });
  } finally {
    clearInterval(pruneTimer);
    await dispatcher.drain();
  }
}

async function loadSettings(dataDir: string): Promise<AvaSettings> {
  const p = join(dataDir, "settings.json");
  if (!existsSync(p)) return DEFAULT_SETTINGS;
  const raw = JSON.parse(await readFile(p, "utf-8")) as Partial<AvaSettings>;
  return { ...DEFAULT_SETTINGS, ...raw, backend: { ...DEFAULT_SETTINGS.backend, ...(raw.backend ?? {}) } };
}

async function loadAllowlist(dataDir: string): Promise<string[]> {
  const p = join(dataDir, "allowlist.json");
  if (!existsSync(p)) {
    log.error("allowlist.json missing — exiting to avoid open-to-internet state");
    process.exit(2);
  }
  const raw = JSON.parse(await readFile(p, "utf-8")) as { emails: string[] };
  return raw.emails ?? [];
}

main().catch((e) => {
  log.error("fatal", { error: String(e) });
  process.exit(1);
});
```

- [ ] **Step 2: Compile**

Run: `cd packages/ava && npx tsc -p tsconfig.build.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Run the lint/typecheck gate**

Run from repo root: `npm run check`
Expected: all clean. Fix any issues before committing.

- [ ] **Step 4: Commit**

```bash
git add packages/ava/src/main.ts
git commit -m "ava: main entry point (CLI + wiring + prune timer)"
```

### Task 27: README with setup flow

**Files:**
- Modify: `packages/ava/README.md`

- [ ] **Step 1: Rewrite README**

Replace `packages/ava/README.md` with:

```md
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
```

- [ ] **Step 2: Commit**

```bash
git add packages/ava/README.md
git commit -m "ava: README with setup + operations"
```

---

## Phase 6 — Integration tests (manual, tagged, not in CI)

### Task 28: sandbox-smoke.ts

**Files:**
- Create: `packages/ava/test/integration/sandbox-smoke.ts`

- [ ] **Step 1: Implement**

Create `packages/ava/test/integration/sandbox-smoke.ts`:

```ts
/**
 * Manual integration test. Run on the Fedora host once after setup-sandbox.sh.
 *
 *   npx tsx packages/ava/test/integration/sandbox-smoke.ts
 *
 * Fails with exit != 0 if any check fails. Writes a report to stdout.
 */
import { makeSandboxExec } from "../../src/sandbox.js";

async function check(name: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    console.log(`OK   ${name}`);
    return true;
  } catch (e) {
    console.error(`FAIL ${name}: ${e}`);
    return false;
  }
}

async function main(): Promise<void> {
  const exec = makeSandboxExec({ containerName: process.env.AVA_CONTAINER ?? "ava-sandbox" });
  const cases = [
    ["claude --version", ["claude", "--version"]],
    ["codex --version",  ["codex",  "--version"]],
    ["pi --version",     ["pi",     "--version"]],
    ["git --version",    ["git",    "--version"]],
    ["gh --version",     ["gh",     "--version"]],
    ["ls /workspace",    ["ls",     "/workspace"]],
  ] as const;
  let ok = true;
  for (const [name, argv] of cases) {
    const r = await exec([...argv], { timeoutMs: 10_000 });
    ok = (await check(name, async () => {
      if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${r.stderr}`);
    })) && ok;
  }
  process.exit(ok ? 0 : 1);
}

main();
```

- [ ] **Step 2: Commit**

```bash
git add packages/ava/test/integration/sandbox-smoke.ts
git commit -m "ava: sandbox-smoke integration test"
```

### Task 29: gmail-roundtrip.ts

**Files:**
- Create: `packages/ava/test/integration/gmail-roundtrip.ts`

- [ ] **Step 1: Implement**

Create `packages/ava/test/integration/gmail-roundtrip.ts`:

```ts
/**
 * Manual Gmail round-trip test.
 *
 * Requires a SECOND Gmail account with OAuth configured. Sends a test
 * email to claude@actualvoice.ai and waits up to 3 minutes for both the
 * ack and the final reply.
 *
 *   AVA_TEST_SENDER_CREDS=./data/test-sender-creds.json \
 *   AVA_TEST_SENDER_TOKEN=./data/test-sender-token.json \
 *   AVA_TARGET=claude@actualvoice.ai \
 *     npx tsx packages/ava/test/integration/gmail-roundtrip.ts
 */
import { GmailClient } from "../../src/gmail/client.js";

async function main(): Promise<void> {
  const sender = new GmailClient();
  await sender.init({
    credentialsPath: process.env.AVA_TEST_SENDER_CREDS!,
    tokenPath: process.env.AVA_TEST_SENDER_TOKEN!,
  });
  const subject = `ava-roundtrip ${Date.now()}`;
  const messageId = `<roundtrip-${Date.now()}@test>`;
  const sentId = await sender.send({
    threadId: "",
    to: process.env.AVA_TARGET!,
    subject,
    bodyText: "Respond with any message.",
    inReplyTo: messageId,
    references: [messageId],
    attachments: [],
  });
  console.log(`sent ${sentId}, subject=${subject}`);

  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
    const ids = await sender.listUnread(`subject:"Re: ${subject}"`);
    if (ids.length >= 2) {
      console.log(`ack + reply received (${ids.length} messages)`);
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  console.error("timeout: did not receive ack + reply within 3m");
  process.exit(1);
}

main();
```

- [ ] **Step 2: Commit**

```bash
git add packages/ava/test/integration/gmail-roundtrip.ts
git commit -m "ava: gmail-roundtrip integration test"
```

### Task 30: backend-session-reuse.ts

**Files:**
- Create: `packages/ava/test/integration/backend-session-reuse.ts`

- [ ] **Step 1: Implement**

Create `packages/ava/test/integration/backend-session-reuse.ts`:

```ts
/**
 * Verify each real backend preserves conversation history across invocations.
 *
 *   AVA_CONTAINER=ava-sandbox \
 *   AVA_BACKEND=claude-code \
 *     npx tsx packages/ava/test/integration/backend-session-reuse.ts
 *
 * Also run with AVA_BACKEND=codex and AVA_BACKEND=pi.
 */
import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSandboxExec } from "../../src/sandbox.js";
import { ClaudeCodeBackend } from "../../src/backends/claude-code.js";
import { CodexBackend } from "../../src/backends/codex.js";
import { PiBackend } from "../../src/backends/pi.js";
import type { Backend } from "../../src/backends/types.js";

function pick(name: string): Backend {
  if (name === "claude-code") return new ClaudeCodeBackend();
  if (name === "codex") return new CodexBackend();
  if (name === "pi") return new PiBackend();
  throw new Error(`unknown backend ${name}`);
}

async function main(): Promise<void> {
  const backendName = process.env.AVA_BACKEND ?? "claude-code";
  const backend = pick(backendName);
  const dataDir = mkdtempSync(join(tmpdir(), "ava-it-"));
  await mkdir(join(dataDir, "threads", "T-it"), { recursive: true });
  const exec = makeSandboxExec({ containerName: process.env.AVA_CONTAINER ?? "ava-sandbox" });

  const r1 = await backend.run({
    threadId: "T-it",
    cwdInContainer: "/workspace",
    prompt: "My favorite number is 73. Please reply with just the word 'noted'.",
    dataDir,
    timeoutMs: 120_000,
    sandboxExec: exec,
  });
  console.log(`run1 exit=${r1.exitCode} stdout=${r1.stdout.slice(0, 200)}`);
  if (r1.exitCode !== 0) process.exit(1);

  const r2 = await backend.run({
    threadId: "T-it",
    cwdInContainer: "/workspace",
    prompt: "What is my favorite number? Reply with only the number.",
    dataDir,
    timeoutMs: 120_000,
    sandboxExec: exec,
  });
  console.log(`run2 exit=${r2.exitCode} stdout=${r2.stdout.slice(0, 200)}`);
  if (r2.exitCode !== 0) process.exit(1);
  if (!r2.stdout.includes("73")) {
    console.error("FAIL: backend did not remember the number across runs");
    process.exit(1);
  }
  console.log(`PASS: ${backendName} preserved history`);
}

main();
```

- [ ] **Step 2: Commit**

```bash
git add packages/ava/test/integration/backend-session-reuse.ts
git commit -m "ava: backend-session-reuse integration test (all 3 backends)"
```

---

## Final verification

### Task 31: End-to-end local run

No new files. This is a manual verification step before declaring v1 ready for dogfood.

- [ ] **Step 1: Run all unit tests**

Run: `cd packages/ava && npx vitest run`
Expected: every test passes.

- [ ] **Step 2: Typecheck + lint at repo level**

Run from repo root: `npm run check`
Expected: clean.

- [ ] **Step 3: Build the sandbox**

Run: `bash packages/ava/scripts/setup-sandbox.sh` with `AVA_REPO_URL` set to a **throwaway** fixture repo first (not the real ActualVoice repo).
Expected: container running, bare repo cloned, CLIs installed.

- [ ] **Step 4: Run sandbox smoke**

Run: `npx tsx packages/ava/test/integration/sandbox-smoke.ts`
Expected: all OK lines.

- [ ] **Step 5: Run backend-session-reuse for all three backends**

Run three times, once each with `AVA_BACKEND=claude-code|codex|pi`.
Expected: each prints `PASS`.

- [ ] **Step 6: Run Gmail round-trip**

Requires a second Gmail account. Send a test email addressed to `claude@actualvoice.ai` from a whitelisted sender; confirm both ack and final reply arrive within 3 minutes.

- [ ] **Step 7: Point at the real ActualVoice repo and dogfood for a week**

Switch `AVA_REPO_URL` to the actual ActualVoice repo and use Ava for real, low-stakes tasks. Track any showstopper (lost task, leaked secret, wrong-branch push). Iterate on `MEMORY.md` and prompt-builder wording based on observed failures.

---

## Notes for the executor

- **Do not skip Phase 0.** Each spike produces a notes file (`packages/ava/docs/cli-flags.md`) that later tasks reference for exact flag names. If a CLI changed between now and implementation, the spike will surface it before you write a broken backend.
- **If you finish a task and tests fail unexpectedly**, before adjusting production code, re-read the spec section it implements. Several error-handling flows (rate-limit fallback, auth emails) have subtle wording constraints.
- **Commit frequently.** One commit per task minimum; two or three is fine if a task has natural sub-units.
- **Do not merge to main without the user's go-ahead.** PR-based review is the workflow.
