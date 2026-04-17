import { join } from "node:path";
import type { FailureKind } from "../types.js";
import type { Backend, BackendRunOpts, BackendRunResult } from "./types.js";

const RATE_LIMIT_RX = /rate[_\s]*limit|quota|429/i;
const AUTH_RX = /auth.*(expired|invalid|required)|please re-?login|oauth.*(revoked|invalid)/i;

export class PiBackend implements Backend {
	readonly name = "pi" as const;

	async run(opts: BackendRunOpts): Promise<BackendRunResult> {
		const sessionPath = join(opts.dataDir, "threads", opts.threadId, "pi-session.jsonl");
		const argv: string[] = ["pi", "--session", sessionPath, "--no-context-files", "-p", opts.prompt];
		return opts.sandboxExec(argv, { timeoutMs: opts.timeoutMs, workdir: opts.cwdInContainer });
	}

	classify(r: BackendRunResult): FailureKind {
		if (r.exitCode === 0) return "ok";
		if (AUTH_RX.test(r.stderr)) return "auth";
		if (RATE_LIMIT_RX.test(r.stderr)) return "rate-limit";
		return "crash";
	}
}
