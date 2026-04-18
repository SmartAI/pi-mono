import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FailureKind } from "../types.js";
import { type Backend, type BackendRunOpts, type BackendRunResult, concatPrompts } from "./types.js";

const MODEL = "gpt-5.4";
const SKIP_PERMS = "--dangerously-bypass-approvals-and-sandbox";

const RATE_LIMIT_RX = /rate\s*limit|quota|429|too many requests/i;
const AUTH_RX = /401\b|unauthorized|please (re-?)?login|auth.*(expired|invalid)/i;

// Codex's JSON event stream emits `thread_id`, not `session_id`. The resume
// subcommand (`codex exec resume <id>`) takes the thread_id back as its argument.
const THREAD_ID_RX = /"thread_id"\s*:\s*"([0-9a-f-]{8,})"/i;

export class CodexBackend implements Backend {
	readonly name = "codex" as const;

	async run(opts: BackendRunOpts): Promise<BackendRunResult> {
		// Host-side paths for files Ava reads/writes directly.
		const sessionFile = join(opts.dataDir, "threads", opts.threadId, "codex-session-id");
		const outFileHost = join(opts.dataDir, "threads", opts.threadId, "codex-last.txt");
		// Container-side path for the -o arg (codex runs inside the sandbox).
		const outFileContainer = join(opts.containerDataDir, "threads", opts.threadId, "codex-last.txt");

		await mkdir(dirname(sessionFile), { recursive: true });
		if (existsSync(outFileHost)) await unlink(outFileHost);

		const resuming = existsSync(sessionFile);
		const argv: string[] = ["codex", "exec"];
		if (resuming) {
			const id = (await readFile(sessionFile, "utf-8")).trim();
			argv.push("resume", id);
		}
		// codex exec has no native system/user split, so we concatenate with
		// a prominent separator. Claude backend uses --append-system-prompt.
		const combined = concatPrompts(opts.systemPrompt, opts.userPrompt);
		argv.push("-m", MODEL, SKIP_PERMS, "--json", "-o", outFileContainer, combined);

		const result = await opts.sandboxExec(argv, { timeoutMs: opts.timeoutMs, workdir: opts.cwdInContainer });

		if (!resuming && result.exitCode === 0) {
			const sid = extractThreadId(result.stdout) ?? extractThreadId(result.stderr);
			if (sid) await writeFile(sessionFile, sid);
		}

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
