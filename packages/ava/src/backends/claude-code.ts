import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FailureKind } from "../types.js";
import type { Backend, BackendRunOpts, BackendRunResult } from "./types.js";

const ARGV_PRINT = "-p";
const ARGV_RESUME = "--resume";
const ARGV_SESSION_ID = "--session-id";
const ARGV_SKIP_PERMS = "--dangerously-skip-permissions";
const ARGV_APPEND_SYSTEM = "--append-system-prompt";

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
		if (opts.systemPrompt) {
			argv.push(ARGV_APPEND_SYSTEM, opts.systemPrompt);
		}
		argv.push(ARGV_PRINT, opts.userPrompt);
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
