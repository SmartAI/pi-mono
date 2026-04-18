/**
 * JSON Schema describing the agent contract the model must emit as its
 * final response. Passed to codex via `--output-schema <file>` so codex
 * enforces the shape structurally — the model can't produce "almost JSON"
 * or add preambles. Claude Code doesn't have an equivalent flag, so this
 * is a codex-specific hardening. Our parser is still lenient enough to
 * handle stray wrappers, but --output-schema should eliminate the need.
 *
 * Kept in source (not a committed .json file) so it stays in lockstep
 * with the TypeScript AgentContract interface.
 */
export const CODEX_CONTRACT_SCHEMA = {
	$schema: "http://json-schema.org/draft-07/schema#",
	title: "Ava Agent Contract",
	type: "object",
	required: ["status", "email_body", "actions"],
	additionalProperties: false,
	properties: {
		status: {
			type: "string",
			enum: ["done", "partial", "blocked"],
			description:
				"`done` when you produced everything the sender asked for this turn, `partial` when some planned work didn't land, `blocked` when you couldn't make progress. Set `blocked` if `actions` would be empty.",
		},
		email_body: {
			type: "string",
			minLength: 1,
			description:
				"Plain-text reply Ava forwards verbatim to the sender. No preambles ('Here is my reply:'), no future-promises ('ETA 45 min'), no meta-commentary. Code fences OK.",
		},
		summary: {
			type: "string",
			description: "Optional one-line machine summary, logged for audit — not emailed.",
		},
		actions: {
			type: "array",
			description:
				"Concrete side effects you produced in this turn. Empty array means you did no work — pair with `status: blocked`.",
			items: {
				type: "object",
				required: ["kind"],
				properties: {
					kind: {
						type: "string",
						description: "e.g. commit, pr_opened, pr_updated, issue_comment, issue_create, file_write, shell",
					},
				},
				additionalProperties: true,
			},
		},
		unfinished: {
			type: "array",
			description:
				"Work that was planned for this turn but didn't land. Pairs well with `status: partial`. Empty or absent when nothing planned got cut.",
			items: {
				type: "object",
				required: ["what", "reason"],
				additionalProperties: false,
				properties: {
					what: { type: "string" },
					reason: { type: "string" },
				},
			},
		},
		attachments: {
			type: "array",
			description:
				"Files to attach to the outbound email. Path must be an absolute sandbox path (under /workspace). filename is optional display name.",
			items: {
				type: "object",
				required: ["path"],
				additionalProperties: false,
				properties: {
					path: { type: "string", description: "Absolute sandbox path, under /workspace." },
					filename: { type: "string", description: "Optional display name; defaults to basename(path)." },
				},
			},
		},
	},
} as const;
