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
