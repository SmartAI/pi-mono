import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FailureKind } from "../types.js";
import type { Backend, BackendRunOpts, BackendRunResult } from "./types.js";

const MODEL = "gpt-5.4";
const SKIP_PERMS = "--dangerously-bypass-approvals-and-sandbox";

const RATE_LIMIT_RX = /rate\s*limit|quota|429|too many requests/i;
const AUTH_RX = /401\b|unauthorized|please (re-?)?login|auth.*(expired|invalid)/i;

const SESSION_EVENT_RX = /"session_id"\s*:\s*"([0-9a-f-]{8,})"/i;

export class CodexBackend implements Backend {
	readonly name = "codex" as const;

	async run(opts: BackendRunOpts): Promise<BackendRunResult> {
		const sessionFile = join(opts.dataDir, "threads", opts.threadId, "codex-session-id");
		const outFile = join(opts.dataDir, "threads", opts.threadId, "codex-last.txt");
		await mkdir(dirname(sessionFile), { recursive: true });
		if (existsSync(outFile)) await unlink(outFile);

		const resuming = existsSync(sessionFile);
		const argv: string[] = ["codex", "exec"];
		if (resuming) {
			const id = (await readFile(sessionFile, "utf-8")).trim();
			argv.push("resume", id);
		}
		argv.push("-m", MODEL, SKIP_PERMS, "--json", "-o", outFile, opts.prompt);

		const result = await opts.sandboxExec(argv, { timeoutMs: opts.timeoutMs, workdir: opts.cwdInContainer });

		if (!resuming && result.exitCode === 0) {
			const sid = extractSessionId(result.stdout) ?? extractSessionId(result.stderr);
			if (sid) await writeFile(sessionFile, sid);
		}

		if (result.exitCode === 0 && existsSync(outFile)) {
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
