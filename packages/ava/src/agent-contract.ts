/**
 * Structured contract that every email-driven agent run is required to
 * emit on stdout. The prompt-builder documents the schema to the agent;
 * the parser here enforces it on the Ava side before anything is sent
 * as an email.
 */

export type AgentStatus = "done" | "partial" | "blocked";

export interface AgentAction {
	kind: string;
	[field: string]: unknown;
}

export interface AgentAttachment {
	path: string; // absolute path the file lives at (sandbox-visible, e.g. /workspace/.../foo.md)
	filename?: string; // optional display name; defaults to basename(path)
}

export interface AgentContract {
	status: AgentStatus;
	email_body: string;
	summary?: string;
	actions: AgentAction[];
	unfinished?: Array<{ what: string; reason: string }>;
	// Artifacts the agent explicitly wants attached to the outbound email.
	// Declaring them here is the robust contract path — Ava doesn't have to
	// guess from directory conventions. Paths must be sandbox-visible
	// absolute paths; Ava translates them back to host paths via the
	// containerDataDir prefix mapping.
	attachments?: AgentAttachment[];
}

export interface ContractParseOk {
	ok: true;
	contract: AgentContract;
}

export interface ContractParseFail {
	ok: false;
	reason: string;
	rawStdout: string;
}

export type ContractParseResult = ContractParseOk | ContractParseFail;

/**
 * Parse the agent's stdout as the required JSON contract.
 *
 * Be liberal in what we accept at the edges: the agent may add a prose
 * preamble, wrap the JSON in a ```json fence, or inline `{word}`-style
 * literals that aren't JSON at all. We try candidate JSON regions in
 * order of likelihood — code-fenced first, then every balanced
 * `{...}` in the text — and pick the first that parses AND has the
 * required contract fields. If nothing qualifies we return a structured
 * error so Ava can emit a diagnostic reply instead of forwarding garbage.
 */
export function parseAgentContract(stdout: string): ContractParseResult {
	const candidates = extractJsonCandidates(stdout);
	if (candidates.length === 0) {
		return { ok: false, reason: "no JSON object found in stdout", rawStdout: stdout };
	}
	let lastReason = "no parseable contract object found in stdout";
	for (const candidate of candidates) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch (e) {
			lastReason = `JSON.parse failed: ${String(e)}`;
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			lastReason = "top-level value is not an object";
			continue;
		}
		const obj = parsed as Record<string, unknown>;
		const result = validateContractObject(obj);
		if (!result.ok) {
			lastReason = result.reason;
			continue;
		}
		return { ok: true, contract: result.contract };
	}
	return { ok: false, reason: lastReason, rawStdout: stdout };
}

function validateContractObject(
	obj: Record<string, unknown>,
): { ok: true; contract: AgentContract } | { ok: false; reason: string } {
	const status = obj.status;
	if (status !== "done" && status !== "partial" && status !== "blocked") {
		return { ok: false, reason: `invalid status: ${JSON.stringify(status)}` };
	}
	if (typeof obj.email_body !== "string" || !obj.email_body.trim()) {
		return { ok: false, reason: "email_body missing or empty" };
	}
	if (!Array.isArray(obj.actions)) {
		return { ok: false, reason: "actions is not an array" };
	}
	const actions: AgentAction[] = [];
	for (const [i, a] of (obj.actions as unknown[]).entries()) {
		if (!a || typeof a !== "object" || Array.isArray(a)) {
			return { ok: false, reason: `actions[${i}] is not an object` };
		}
		const ao = a as Record<string, unknown>;
		if (typeof ao.kind !== "string" || !ao.kind) {
			return { ok: false, reason: `actions[${i}].kind missing` };
		}
		actions.push(ao as AgentAction);
	}
	let unfinished: AgentContract["unfinished"];
	if (obj.unfinished !== undefined) {
		if (!Array.isArray(obj.unfinished)) {
			return { ok: false, reason: "unfinished is not an array" };
		}
		unfinished = (obj.unfinished as unknown[]).map((u, i) => {
			if (!u || typeof u !== "object") throw new Error(`unfinished[${i}] invalid`);
			const uo = u as Record<string, unknown>;
			return {
				what: typeof uo.what === "string" ? uo.what : "",
				reason: typeof uo.reason === "string" ? uo.reason : "",
			};
		});
	}
	let attachments: AgentAttachment[] | undefined;
	if (obj.attachments !== undefined) {
		if (!Array.isArray(obj.attachments)) {
			return { ok: false, reason: "attachments is not an array" };
		}
		attachments = [];
		for (const [i, a] of (obj.attachments as unknown[]).entries()) {
			if (!a || typeof a !== "object" || Array.isArray(a)) {
				return { ok: false, reason: `attachments[${i}] is not an object` };
			}
			const ao = a as Record<string, unknown>;
			if (typeof ao.path !== "string" || !ao.path) {
				return { ok: false, reason: `attachments[${i}].path missing` };
			}
			attachments.push({
				path: ao.path,
				filename: typeof ao.filename === "string" && ao.filename ? ao.filename : undefined,
			});
		}
	}
	return {
		ok: true,
		contract: {
			status,
			email_body: obj.email_body as string,
			summary: typeof obj.summary === "string" ? obj.summary : undefined,
			actions,
			unfinished,
			attachments,
		},
	};
}

/**
 * Detect the classic lie: the agent says "done" but produced zero concrete
 * actions. Surface that to the recipient so they aren't misled into waiting
 * for follow-up work that isn't happening.
 */
export function detectDoneEmptyMismatch(contract: AgentContract): boolean {
	return contract.status === "done" && contract.actions.length === 0;
}

export interface ResolvedAttachment {
	filename: string;
	hostPath: string; // fully-resolved host path Ava can stat/read
	bytes: number;
}

export interface AttachmentResolveResult {
	resolved: ResolvedAttachment[];
	errors: Array<{ declaredPath: string; reason: string }>;
	overCap: Array<{ filename: string; bytes: number }>;
}

/**
 * Turn the contract's declared attachment paths (sandbox-visible) into host
 * paths Ava can actually open, with safety + existence + size checks.
 *
 * Rules:
 * - Path must be absolute (starts with /).
 * - Path must start with containerDataDir (e.g. /workspace) — we don't let
 *   the agent attach /etc/passwd. Conservative but covers every real use
 *   case since all Ava-visible state lives under /workspace.
 * - File must exist and fit under the per-reply cap.
 */
export async function resolveContractAttachments(
	declared: AgentAttachment[],
	opts: {
		hostDataDir: string; // e.g. /home/mliu/.../data
		containerDataDir: string; // e.g. /workspace
		perReplyCapBytes: number;
	},
): Promise<AttachmentResolveResult> {
	const { stat } = await import("node:fs/promises");
	const { basename } = await import("node:path");
	const resolved: ResolvedAttachment[] = [];
	const errors: AttachmentResolveResult["errors"] = [];
	const overCap: AttachmentResolveResult["overCap"] = [];
	let running = 0;
	for (const att of declared) {
		const p = att.path;
		if (!p.startsWith("/")) {
			errors.push({ declaredPath: p, reason: "path is not absolute" });
			continue;
		}
		if (!p.startsWith(`${opts.containerDataDir}/`) && p !== opts.containerDataDir) {
			errors.push({ declaredPath: p, reason: `path must be under ${opts.containerDataDir}` });
			continue;
		}
		const hostPath = `${opts.hostDataDir}${p.slice(opts.containerDataDir.length)}`;
		let size: number;
		try {
			const s = await stat(hostPath);
			if (!s.isFile()) {
				errors.push({ declaredPath: p, reason: "not a regular file" });
				continue;
			}
			size = s.size;
		} catch (e) {
			errors.push({ declaredPath: p, reason: `stat failed: ${(e as Error).message}` });
			continue;
		}
		const filename = att.filename || basename(hostPath);
		if (running + size > opts.perReplyCapBytes) {
			overCap.push({ filename, bytes: size });
			continue;
		}
		running += size;
		resolved.push({ filename, hostPath, bytes: size });
	}
	return { resolved, errors, overCap };
}

/**
 * Build the final email body from the parsed contract. Appends a visible
 * warning line if the agent claimed `done` with no actions.
 */
export function buildEmailBody(contract: AgentContract): string {
	if (detectDoneEmptyMismatch(contract)) {
		return `${contract.email_body}\n\n---\n⚠ Ava note: agent reported status="done" but zero concrete actions (no commits, PRs, or file changes). Please verify before relying on this reply.`;
	}
	return contract.email_body;
}

/**
 * Produce every JSON candidate string we could plausibly parse from the
 * stdout blob, ordered from most-likely-correct to least. Callers JSON.parse
 * each in turn and pick the first that validates as a full contract.
 *
 * Order:
 *   1. Content inside ```json ... ``` code fences (even if embedded in prose).
 *      Agents commonly do this when they want to separate a human note from
 *      the machine payload; treat the fenced block as authoritative.
 *   2. The whole stdout, if it's a single bare JSON object (no prose).
 *   3. Every balanced `{...}` substring found by scanning every `{` in stdout.
 *      Handles the case where the agent inlined a stray `{word}` in prose
 *      (the bug this function exists to work around): the first `{` in
 *      stdout wasn't JSON at all. We try each in sequence.
 */
function extractJsonCandidates(stdout: string): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();
	const push = (s: string | null): void => {
		if (!s) return;
		if (seen.has(s)) return;
		seen.add(s);
		candidates.push(s);
	};

	// 1. ```json ... ``` fences — anywhere in the text.
	const fenceRx = /```(?:json)?\s*\n([\s\S]+?)\n```/g;
	for (const fenceMatch of stdout.matchAll(fenceRx)) {
		const fenced = fenceMatch[1].trim();
		const balanced = firstBalancedObject(fenced, 0);
		if (balanced) push(balanced);
	}

	// 2. The full trimmed stdout as one object (no prose).
	const trimmed = stdout.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		push(trimmed);
	}

	// 3. Every balanced `{...}` in the raw text. Most prompts produce
	//    a handful of `{` at most, so O(n) scans is fine.
	for (let i = 0; i < stdout.length; i++) {
		if (stdout[i] !== "{") continue;
		const balanced = firstBalancedObject(stdout, i);
		if (balanced) push(balanced);
	}

	return candidates;
}

function firstBalancedObject(s: string, start: number): string | null {
	if (s[start] !== "{") return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < s.length; i++) {
		const ch = s[i];
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
			if (depth === 0) return s.slice(start, i + 1);
		}
	}
	return null;
}
