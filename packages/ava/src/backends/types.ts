import type { BackendName, FailureKind } from "../types.js";

export interface BackendRunOpts {
	threadId: string;
	cwdInContainer: string; // absolute path inside sandbox, e.g. /workspace/threads/T-abc/worktree
	prompt: string;
	dataDir: string; // host path to ./data/, used to persist session pointer
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
