import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Per-invocation token accounting. Populated from each backend's native
 * session transcript after `run()` completes; attached to BackendRunResult
 * as an optional field so backends that can't easily extract usage (codex,
 * pi for now) just omit it.
 */
export interface BackendUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreateTokens: number;
	turnCount: number; // number of assistant messages produced during this run
	durationMs: number; // wall-clock time of this invocation
}

/**
 * Read Claude Code's per-project session transcript and sum the usage of
 * every assistant message with `timestamp >= sinceMs`. That defines "this
 * turn's" usage — the rest of the file is prior turns' history.
 *
 * Claude Code stores transcripts at:
 *   ~/.claude/projects/<cwd-as-dashes>/<session-id>.jsonl
 * where <cwd-as-dashes> is the cwd with / replaced by - (e.g.
 * "/workspace/threads/T-1/worktree" -> "-workspace-threads-T-1-worktree").
 *
 * Returns zero-usage stub if the transcript doesn't exist or can't be read.
 * Never throws — usage is best-effort telemetry, not a correctness gate.
 */
export async function readClaudeUsageSince(opts: {
	cwdInContainer: string;
	sessionId: string;
	sinceMs: number;
	durationMs: number;
}): Promise<BackendUsage> {
	const empty: BackendUsage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreateTokens: 0,
		turnCount: 0,
		durationMs: opts.durationMs,
	};
	const projectDir = opts.cwdInContainer.replaceAll("/", "-");
	const transcript = join(homedir(), ".claude", "projects", projectDir, `${opts.sessionId}.jsonl`);
	if (!existsSync(transcript)) return empty;
	let text: string;
	try {
		text = await readFile(transcript, "utf-8");
	} catch {
		return empty;
	}
	const usage: BackendUsage = { ...empty };
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let row: {
			type?: string;
			timestamp?: string;
			message?: {
				usage?: {
					input_tokens?: number;
					output_tokens?: number;
					cache_read_input_tokens?: number;
					cache_creation_input_tokens?: number;
				};
			};
		};
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (row.type !== "assistant") continue;
		if (!row.timestamp) continue;
		const t = Date.parse(row.timestamp);
		if (!Number.isFinite(t) || t < opts.sinceMs) continue;
		const u = row.message?.usage;
		if (!u) continue;
		usage.inputTokens += u.input_tokens ?? 0;
		usage.outputTokens += u.output_tokens ?? 0;
		usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
		usage.cacheCreateTokens += u.cache_creation_input_tokens ?? 0;
		usage.turnCount++;
	}
	return usage;
}

/**
 * Compact human-friendly one-liner for the email footer. No USD cost
 * since Max is on a subscription — tokens and wall-clock are the
 * actually-useful numbers for rate-limit awareness.
 */
export function formatUsageFooter(usage: BackendUsage): string {
	const fmt = (n: number): string => {
		if (n < 1000) return String(n);
		if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
		return `${(n / 1_000_000).toFixed(2)}M`;
	};
	const seconds = (usage.durationMs / 1000).toFixed(1);
	return `— cost: ${fmt(usage.inputTokens)}in / ${fmt(usage.outputTokens)}out / ${fmt(usage.cacheReadTokens)} cache-read · ${usage.turnCount} turns · ${seconds}s wall`;
}
