import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FailureKind } from "../types.js";
import { CODEX_CONTRACT_SCHEMA } from "./codex-schema.js";
import { type Backend, type BackendRunOpts, type BackendRunResult, concatPrompts } from "./types.js";

const SKIP_PERMS = "--dangerously-bypass-approvals-and-sandbox";
const SCHEMA_FILENAME = "codex-contract-schema.json";

const RATE_LIMIT_RX = /rate\s*limit|quota|429|too many requests/i;
const AUTH_RX = /401\b|unauthorized|please (re-?)?login|auth.*(expired|invalid)/i;

// Codex's JSON event stream emits `thread_id`, not `session_id`. The resume
// subcommand (`codex exec resume <id>`) takes the thread_id back as its argument.
const THREAD_ID_RX = /"thread_id"\s*:\s*"([0-9a-f-]{8,})"/i;

/**
 * Codex CLI backend. Key differences vs claude-code:
 *
 *   1. No native system/user split (no `--append-system-prompt`) — we concat
 *      the system+user prompts with a visible separator.
 *   2. No `--model` flag in our invocation — Codex reads the default from
 *      the user's `~/.codex/config.toml`, so we stay self-updating if they
 *      change models.
 *   3. `--output-schema <file>` structurally enforces the JSON contract
 *      shape. Claude Code has no equivalent, so this is codex-specific
 *      hardening: the model CAN'T emit "almost JSON" or add a preamble.
 *   4. Options MUST come before the `resume` subcommand per clap's
 *      parser. Putting them after silently misapplies (or errors) on
 *      resume runs.
 */
export class CodexBackend implements Backend {
	readonly name = "codex" as const;

	async run(opts: BackendRunOpts): Promise<BackendRunResult> {
		const sessionFile = join(opts.dataDir, "threads", opts.threadId, "codex-session-id");
		const outFileHost = join(opts.dataDir, "threads", opts.threadId, "codex-last.txt");
		const outFileContainer = join(opts.containerDataDir, "threads", opts.threadId, "codex-last.txt");

		// Write (or refresh) the contract schema at data/<SCHEMA_FILENAME>.
		// Idempotent; kept up-to-date with the TS interface via codex-schema.ts.
		const schemaHost = join(opts.dataDir, SCHEMA_FILENAME);
		const schemaContainer = join(opts.containerDataDir, SCHEMA_FILENAME);
		await writeFile(schemaHost, `${JSON.stringify(CODEX_CONTRACT_SCHEMA, null, 2)}\n`);

		await mkdir(dirname(sessionFile), { recursive: true });
		if (existsSync(outFileHost)) await unlink(outFileHost);

		const resuming = existsSync(sessionFile);

		// All options belong on the `codex exec` parent. If we're resuming,
		// the `resume <id>` subcommand goes AFTER the options, with the
		// prompt as its second positional arg. If we're not, the prompt is
		// the positional arg of `exec` itself.
		const combined = concatPrompts(opts.systemPrompt, opts.userPrompt);
		const argv: string[] = [
			"codex",
			"exec",
			SKIP_PERMS,
			"--json",
			"--output-schema",
			schemaContainer,
			"-o",
			outFileContainer,
		];
		if (resuming) {
			const id = (await readFile(sessionFile, "utf-8")).trim();
			argv.push("resume", id, combined);
		} else {
			argv.push(combined);
		}

		const result = await opts.sandboxExec(argv, { timeoutMs: opts.timeoutMs, workdir: opts.cwdInContainer });

		if (!resuming && result.exitCode === 0) {
			const sid = extractThreadId(result.stdout) ?? extractThreadId(result.stderr);
			if (sid) await writeFile(sessionFile, sid);
		}

		// `-o` writes the model's final message to the file. We swap that in
		// for stdout so the agent-contract parser sees just the final reply,
		// not the JSONL event stream.
		if (result.exitCode === 0 && existsSync(outFileHost)) {
			result.stdout = await readFile(outFileHost, "utf-8");
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

function extractThreadId(text: string): string | null {
	const m = text.match(THREAD_ID_RX);
	return m ? m[1] : null;
}
