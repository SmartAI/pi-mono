import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BackendRunOpts } from "./backends/types.js";
import { log } from "./log.js";

/**
 * LLM-driven classifier that decides whether an inbound email warrants a
 * full coding-agent run or can be safely skipped. Runs as its own Claude
 * Code invocation with its own session and its own cwd (`data/triage-cwd/`),
 * so triage history and coding-agent history never cross-contaminate.
 *
 * The triage skill at `data/triage-cwd/.claude/skills/email-triage/SKILL.md`
 * owns the procedure; this module only orchestrates the invocation and
 * parses the JSON decision.
 */

export type TriageRoute = "skip" | "coding_agent";

export interface TriageDecision {
	route: TriageRoute;
	reason: string;
	confidence: "low" | "high";
}

export interface TriageInput {
	threadId: string;
	from: string;
	subject: string;
	bodyText: string;
	attachments: Array<{ filename: string; bytes: number }>;
}

export interface TriageDeps {
	dataDir: string; // host path to data/
	containerDataDir: string; // typically /workspace
	sandboxExec: BackendRunOpts["sandboxExec"];
	timeoutMs: number; // triage should be short — 60_000 is reasonable
}

/**
 * Classify an inbound email. Falls back to `coding_agent` with
 * `confidence: "low"` on any parse/invocation failure — a redundant
 * agent run is cheaper than a silently skipped message.
 */
export async function runTriage(input: TriageInput, deps: TriageDeps): Promise<TriageDecision> {
	const fallback: TriageDecision = {
		route: "coding_agent",
		reason: "triage fell through to default — treat as work request",
		confidence: "low",
	};

	const sessionFile = join(deps.dataDir, "threads", input.threadId, "triage-session-id");
	await mkdir(dirname(sessionFile), { recursive: true });

	const argv: string[] = ["claude", "--dangerously-skip-permissions"];
	if (existsSync(sessionFile)) {
		const id = (await readFile(sessionFile, "utf-8")).trim();
		argv.push("--resume", id);
	} else {
		const id = randomUUID();
		await writeFile(sessionFile, id);
		argv.push("--session-id", id);
	}

	const systemPrompt = [
		`You are Ava's email triage step. One round, one decision — classify the email below and emit a single JSON object as your entire stdout. The \`email-triage\` skill in this cwd owns the full procedure; follow it.`,
		``,
		`Hard rules recap:`,
		`- Output is exactly ONE JSON object: {"route": "skip" | "coding_agent", "reason": "<one sentence>", "confidence": "low" | "high"}.`,
		`- No preamble, no code fence, no postamble. Just the JSON.`,
		`- When in doubt, route to "coding_agent" with low confidence. Silent skips are worse than redundant runs.`,
		`- Do NOT reply to the email, write code, or do anything beyond classifying.`,
	].join("\n");

	argv.push("--append-system-prompt", systemPrompt);

	const attachmentsLine = input.attachments.length
		? `\nAttachments (${input.attachments.length}): ${input.attachments.map((a) => a.filename).join(", ")}`
		: "";
	const userPrompt = [
		`From: ${input.from}`,
		`Subject: ${input.subject}${attachmentsLine}`,
		``,
		input.bodyText.trim(),
	].join("\n");
	argv.push("-p", userPrompt);

	const triageCwdContainer = join(deps.containerDataDir, "triage-cwd");
	try {
		const result = await deps.sandboxExec(argv, {
			timeoutMs: deps.timeoutMs,
			workdir: triageCwdContainer,
		});
		if (result.exitCode !== 0) {
			log.warn("triage: non-zero exit, defaulting to coding_agent", {
				threadId: input.threadId,
				exitCode: result.exitCode,
				stderr: result.stderr.slice(0, 500),
			});
			return fallback;
		}
		const decision = parseTriageDecision(result.stdout);
		if (!decision) {
			log.warn("triage: parse failed, defaulting to coding_agent", {
				threadId: input.threadId,
				stdoutSnippet: result.stdout.slice(0, 300),
			});
			return fallback;
		}
		return decision;
	} catch (e) {
		log.error("triage: invocation threw, defaulting to coding_agent", {
			threadId: input.threadId,
			error: String(e),
		});
		return fallback;
	}
}

/**
 * Extract and validate the triage JSON. Tolerates a surrounding code
 * fence or leading whitespace; rejects anything that doesn't have the
 * three required fields with valid enum values.
 */
export function parseTriageDecision(stdout: string): TriageDecision | null {
	const candidate = extractJsonObject(stdout);
	if (!candidate) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const obj = parsed as Record<string, unknown>;
	const route = obj.route;
	if (route !== "skip" && route !== "coding_agent") return null;
	const confidence = obj.confidence;
	if (confidence !== "low" && confidence !== "high") return null;
	const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
	if (!reason) return null;
	return { route, reason, confidence };
}

function extractJsonObject(s: string): string | null {
	const trimmed = stripCodeFence(s.trim());
	const start = trimmed.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return trimmed.slice(start, i + 1);
		}
	}
	return null;
}

function stripCodeFence(s: string): string {
	const m = /^```(?:json)?\s*\n([\s\S]+?)\n```\s*$/.exec(s);
	return m ? m[1] : s;
}
