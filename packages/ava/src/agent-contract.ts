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

export interface AgentContract {
	status: AgentStatus;
	email_body: string;
	summary?: string;
	actions: AgentAction[];
	unfinished?: Array<{ what: string; reason: string }>;
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
 * Be liberal in what we accept at the edges: the agent may prepend a log
 * line or wrap the JSON in a ```json fence. We extract the first top-level
 * JSON object we can find and validate its shape. If parsing fails we
 * return a structured error so Ava can emit a diagnostic reply instead of
 * blindly forwarding garbage.
 */
export function parseAgentContract(stdout: string): ContractParseResult {
	const candidate = extractJsonObject(stdout);
	if (!candidate) {
		return { ok: false, reason: "no JSON object found in stdout", rawStdout: stdout };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch (e) {
		return { ok: false, reason: `JSON.parse failed: ${String(e)}`, rawStdout: stdout };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, reason: "top-level value is not an object", rawStdout: stdout };
	}
	const obj = parsed as Record<string, unknown>;
	const status = obj.status;
	if (status !== "done" && status !== "partial" && status !== "blocked") {
		return { ok: false, reason: `invalid status: ${JSON.stringify(status)}`, rawStdout: stdout };
	}
	if (typeof obj.email_body !== "string" || !obj.email_body.trim()) {
		return { ok: false, reason: "email_body missing or empty", rawStdout: stdout };
	}
	if (!Array.isArray(obj.actions)) {
		return { ok: false, reason: "actions is not an array", rawStdout: stdout };
	}
	const actions: AgentAction[] = [];
	for (const [i, a] of (obj.actions as unknown[]).entries()) {
		if (!a || typeof a !== "object" || Array.isArray(a)) {
			return { ok: false, reason: `actions[${i}] is not an object`, rawStdout: stdout };
		}
		const ao = a as Record<string, unknown>;
		if (typeof ao.kind !== "string" || !ao.kind) {
			return { ok: false, reason: `actions[${i}].kind missing`, rawStdout: stdout };
		}
		actions.push(ao as AgentAction);
	}
	let unfinished: AgentContract["unfinished"];
	if (obj.unfinished !== undefined) {
		if (!Array.isArray(obj.unfinished)) {
			return { ok: false, reason: "unfinished is not an array", rawStdout: stdout };
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
	return {
		ok: true,
		contract: {
			status,
			email_body: obj.email_body,
			summary: typeof obj.summary === "string" ? obj.summary : undefined,
			actions,
			unfinished,
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
 * Pull the first balanced top-level JSON object out of a stdout blob.
 * Handles ```json fences and leading/trailing prose (which we don't want
 * but may get if the agent ignores the "exactly ONE JSON object" rule).
 */
function extractJsonObject(stdout: string): string | null {
	const s = stripCodeFence(stdout.trim());
	const start = s.indexOf("{");
	if (start === -1) return null;
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

function stripCodeFence(s: string): string {
	// Strip a leading/trailing ```json ... ``` wrapper if present.
	const m = /^```(?:json)?\s*\n([\s\S]+?)\n```\s*$/.exec(s);
	return m ? m[1] : s;
}
