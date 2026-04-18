import type { BackendName, FailureKind } from "../types.js";

export interface BackendRunOpts {
	threadId: string;
	cwdInContainer: string; // absolute path inside sandbox, e.g. /workspace/threads/T-abc/worktree
	systemPrompt: string; // ambient Ava state (role, memory, skills, JSON contract) — appended to the backend's native system prompt when supported, else concatenated above the user prompt
	userPrompt: string; // the sender's message only (for email flow) or the schedule task (for scheduled flow) — no Ava framing
	dataDir: string; // host path to ./data/ — use for files the backend itself reads/writes from the host
	containerDataDir: string; // container path that maps to dataDir (typically /workspace) — use for paths passed as CLI args, since the agent sees the container filesystem
	timeoutMs: number;
	sandboxExec: (
		argv: string[],
		opts: { env?: Record<string, string>; timeoutMs: number; workdir?: string },
	) => Promise<BackendRunResult>;
}

/**
 * Fallback concatenation for backends that don't have a native system/user
 * split (codex exec, pi). The separator is deliberately prominent so the
 * model can visually parse the boundary.
 */
export function concatPrompts(systemPrompt: string, userPrompt: string): string {
	if (!systemPrompt) return userPrompt;
	if (!userPrompt) return systemPrompt;
	return `${systemPrompt}\n\n=============================\n## Sender message\n=============================\n\n${userPrompt}`;
}

export interface BackendRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
	usage?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheCreateTokens: number;
		turnCount: number;
		durationMs: number;
	};
}

export interface Backend {
	name: BackendName;
	run(opts: BackendRunOpts): Promise<BackendRunResult>;
	classify(result: BackendRunResult): FailureKind;
}
