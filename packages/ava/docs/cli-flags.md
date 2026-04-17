# Claude Code CLI Flags

Verified against `claude` version **2.1.112 (Claude Code)** on 2026-04-16.

Raw version output:

```
2.1.112 (Claude Code)
```

---

## Verified Flag Inventory

### Non-interactive / print mode

```
-p, --print
```

Prints the response and exits. Required for all non-interactive (scripted) use.
Note from help text: "The workspace trust dialog is skipped when Claude is run
with the -p mode. Only use this flag in directories you trust."

**Plan assumption:** `-p` / `--print` — **confirmed correct.**

---

### Resume session by ID

```
-r, --resume [value]
```

Resume a conversation by session ID, or open an interactive picker with an
optional search term.

Example: `--resume 550e8400-e29b-41d4-a716-446655440000`

There is also a shorthand for "continue most-recent session in the current
directory":

```
-c, --continue
```

**Plan assumption:** `--resume <id>` — **confirmed correct.** The `-c` /
`--continue` alias also exists for the most-recent session (no explicit ID
needed).

---

### Persist / save session ID on first invocation

There is **no** `--session-id-file`, `--output-session-id`, or similar flag
that writes the session ID to a file automatically.

To control the session ID, use:

```
--session-id <uuid>
```

This lets the caller supply a specific UUID for the session. The session is
then persisted to disk by default (unless `--no-session-persistence` is
passed).

**Plan assumption:** `--session-id-file` / `--output-session-id` — **does not
exist.** The correct approach is to pre-generate a UUID and pass it in via
`--session-id <uuid>` on the first run; subsequent runs use `--resume <uuid>`
to reload that same session.

To prevent any session from being saved:

```
--no-session-persistence
```

---

### Set working directory

There is **no** `--cwd <path>` flag in the `claude` CLI.

The working directory is determined by the shell's current directory when
`claude` is invoked. To control cwd, the caller must `cd` (or use
`subprocess` options that set cwd) before spawning the process.

**Plan assumption:** `--cwd <path>` — **does not exist.** Use OS-level cwd
on the spawned process instead.

---

### Skip permission prompts

```
--dangerously-skip-permissions
```

Bypasses all permission checks. Recommended only for sandboxes with no
internet access.

There is also a softer variant:

```
--allow-dangerously-skip-permissions
```

Enables bypassing permissions as an option without making it the default.

**Plan assumption:** `--dangerously-skip-permissions` — **confirmed correct.**

---

### Fork on resume (bonus flag)

```
--fork-session
```

When resuming, creates a new session ID instead of reusing the original.
Useful when branching from an existing session without mutating it.

---

## Claude Code

### Command shape: first run (no prior session)

Pre-generate a UUID on the Ava side and pass it to `claude`:

```sh
claude \
  --print \
  --dangerously-skip-permissions \
  --session-id <uuid> \
  "$(cat prompt.txt)"
```

- `--print` puts claude into non-interactive mode.
- `--session-id <uuid>` assigns a stable, caller-controlled session ID so Ava
  can refer to the session by a known key.
- The session is persisted to disk by default; no extra flag needed.
- There is no `--cwd` flag; set the process working directory via OS spawn
  options (e.g., Node's `child_process.spawn` `cwd` option).

### Command shape: subsequent runs (resuming an existing session)

```sh
claude \
  --print \
  --dangerously-skip-permissions \
  --resume <uuid> \
  "$(cat prompt.txt)"
```

- `--resume <uuid>` loads the previously persisted session.
- The UUID is the same one passed as `--session-id` on the first run.

---

## Discrepancies from Plan Assumptions

| Assumption in spec          | Reality                                       | Impact on Task 16                                      |
|-----------------------------|-----------------------------------------------|--------------------------------------------------------|
| `--cwd <path>` flag exists  | Flag does not exist                           | Set cwd via OS spawn options, not a CLI flag           |
| `--session-id-file` / `--output-session-id` | Flag does not exist        | Pre-generate UUID; pass as `--session-id` on first run |
| `--resume <id>` exists      | Confirmed: `-r` / `--resume [value]`          | No change needed                                       |
| `-p` / `--print` exists     | Confirmed                                     | No change needed                                       |
| `--dangerously-skip-permissions` exists | Confirmed                       | No change needed                                       |

---

## Codex

Verified against `codex` version **codex-cli 0.120.0** on 2026-04-16.

Raw version output:

```
codex-cli 0.120.0
```

Codex uses a **subcommand-based** CLI (`codex exec`, `codex exec resume`) for
non-interactive use. The top-level `codex [PROMPT]` defaults to the interactive
TUI; all scripted/Ava use should go through `codex exec`.

---

### Non-interactive / exec mode

The subcommand for non-interactive execution is:

```
codex exec [OPTIONS] [PROMPT]
```

There is **no** `-q` / `--quiet` / `--non-interactive` / `--print` flag.
Non-interactive mode is selected by choosing the `exec` subcommand, not a flag.

**Plan assumption:** `-q` / `--quiet` or `-p` / `--non-interactive` flag —
**does not exist.** Use `codex exec` subcommand instead.

---

### Set working directory

```
-C, --cd <DIR>
```

Available on both `codex exec` and `codex exec resume`. Sets the agent's
working root directory.

**Plan assumption:** `--cwd <path>` — **does not exist.** The correct flag is
`-C` / `--cd <DIR>`.

Note: unlike Claude Code (which has no such flag at all), Codex provides this
natively, so no OS-level cwd manipulation is required.

---

### Select model

```
-m, --model <MODEL>
```

Available on `codex exec` and `codex exec resume`. Pass the model name
directly (e.g. `-m gpt-5.4`). Can also be set via config override:
`-c model="gpt-5.4"`.

**Plan assumption:** `--model gpt-5.4` — **confirmed correct** (short flag is
`-m`, long flag is `--model`).

---

### Session persistence and session ID

`codex exec` **automatically persists sessions to disk** by default (a UUID is
assigned and stored). There is **no** `--session-id` flag to pre-assign an ID
on the first run.

To prevent persistence:

```
--ephemeral
```

Runs without saving session files.

To retrieve the session ID after a run, use `--json` to emit JSONL events to
stdout. The JSON event stream includes session metadata.

To write the agent's last message to a file:

```
-o, --output-last-message <FILE>
```

**Plan assumption:** caller-controlled `--session-id <uuid>` on first run —
**does not exist in `codex exec`.** The session ID is assigned by Codex
internally. Ava must capture the session ID from the JSON event stream
(`--json`) on the first run and store it for later resumption.

---

### Resume a previous session (non-interactive)

```
codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
```

`SESSION_ID` is a positional argument (UUID or thread name), not a flag.

```
codex exec resume <uuid> "next prompt here"
```

To resume the most recent session without specifying an ID:

```
codex exec resume --last "next prompt here"
```

**Plan assumption:** `codex resume --session <id>` — **partially wrong.**
The correct form is `codex exec resume <id>` (positional UUID, subcommand
under `exec`, no `--session` flag).

---

### Skip approval prompts / sandbox

```
--dangerously-bypass-approvals-and-sandbox
```

Available on `codex exec` and `codex exec resume`. Skips all confirmation
prompts and runs without sandboxing. Intended for externally sandboxed
environments.

For a less dangerous alternative (sandboxed but no manual approvals):

```
--full-auto
```

Equivalent to `--sandbox workspace-write` (no `-a` / `--ask-for-approval`
override on `exec`).

**Plan assumption:** `--dangerously-bypass-approvals-and-sandbox` —
**confirmed correct** (different name from Claude Code's
`--dangerously-skip-permissions`, but functionally equivalent).

---

### Output / JSON events

```
--json
```

Prints JSONL events to stdout. Required to capture the session ID assigned on
the first `codex exec` run.

```
-o, --output-last-message <FILE>
```

Writes the agent's final message to a file (useful to capture the reply
without parsing JSONL).

---

## Codex command shapes

### First run (no prior session)

```sh
codex exec \
  --dangerously-bypass-approvals-and-sandbox \
  -m gpt-5.4 \
  -C /path/to/repo \
  --json \
  "$(cat prompt.txt)"
```

- Non-interactive mode is the `exec` subcommand itself (no `-q`/`--print`).
- `-m gpt-5.4` selects the model.
- `-C /path/to/repo` sets the working directory (native flag, unlike Claude
  Code which has no such flag).
- `--json` emits JSONL so Ava can parse the auto-assigned session UUID from
  the event stream for later resumption.
- Session is persisted to disk by default.

### Subsequent runs (resuming an existing session)

```sh
codex exec resume \
  --dangerously-bypass-approvals-and-sandbox \
  -m gpt-5.4 \
  <session-uuid> \
  "$(cat prompt.txt)"
```

- `<session-uuid>` is a positional argument, not a flag.
- `-C` / `--cd` is **not available** on `codex exec resume` (only on the
  top-level `codex resume` interactive subcommand); set cwd via OS spawn
  options on resume runs.
- `-m` can still be passed to override the model on resume.

---

## Codex vs Claude Code — key differences

| Dimension               | Claude Code (`claude`)                      | Codex (`codex`)                                        |
|-------------------------|---------------------------------------------|--------------------------------------------------------|
| Non-interactive mode    | `--print` / `-p` flag                       | `exec` subcommand                                      |
| Set working directory   | No flag — OS spawn cwd only                 | `-C` / `--cd <DIR>` flag (on `exec` and TUI)           |
| Session ID on first run | Caller supplies `--session-id <uuid>`       | Codex assigns UUID automatically; capture via `--json` |
| Resume session          | `--resume <uuid>` flag                      | `codex exec resume <uuid>` positional arg              |
| Skip permission prompts | `--dangerously-skip-permissions`            | `--dangerously-bypass-approvals-and-sandbox`           |
| Select model            | `--model <name>`                            | `-m` / `--model <name>`                                |
| Output last message     | No equivalent flag                          | `-o` / `--output-last-message <FILE>`                  |

---

## Discrepancies from Plan Assumptions (Codex)

| Assumption in spec                         | Reality                                                              | Impact on Task 17                                               |
|--------------------------------------------|----------------------------------------------------------------------|-----------------------------------------------------------------|
| `-q` / `--quiet` / `--non-interactive` flag | Does not exist — use `exec` subcommand                             | Spawn `codex exec ...` not `codex -q ...`                       |
| `--cwd <path>` flag                        | Flag is `-C` / `--cd <DIR>` (confirmed, native to Codex)            | Use `-C` on first run; use OS spawn cwd on resume              |
| `--model gpt-5.4`                          | Confirmed: `-m` / `--model <MODEL>`                                 | No change needed                                                |
| `codex resume --session <id>`              | Correct subcommand is `codex exec resume <uuid>` (positional)       | Use `codex exec resume <uuid>` not `codex resume --session <id>` |
| Caller controls session ID on first run   | Codex assigns UUID internally; no `--session-id` flag               | Ava must parse session UUID from `--json` JSONL output          |
