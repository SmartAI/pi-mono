import { type Dirent, existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const DIRECTIVE_STRIP = /@ava:use=[a-z-]+/gi;

export interface SkillMeta {
	name: string;
	description: string;
}

export interface InboundAttachment {
	filename: string;
	containerPath: string; // absolute path as the agent will see it inside the sandbox
	bytes: number;
}

export interface BuildPromptInput {
	newestMessage: {
		from: string;
		subject: string;
		bodyText: string;
		attachments: InboundAttachment[];
	};
	worktreePath: string; // container path to the voicepulse worktree (e.g. /workspace/threads/<tid>/worktree)
	outgoingPath: string; // relative — e.g. "./outgoing"
	persona: string; // contents of data/SOUL.md (voice, tone, identity) — injected every turn
	globalMemory: string; // contents of data/MEMORY.md (operational facts) — injected every turn
	threadMemory: string; // contents of data/threads/<tid>/MEMORY.md (per-thread notes)
	skills: SkillMeta[]; // discovered from <worktree>/.claude/skills/*/SKILL.md
}

export interface BuiltPrompt {
	systemPrompt: string;
	userPrompt: string;
}

/**
 * Builds the two-part prompt for every email-driven agent run.
 *
 * - `systemPrompt`: ambient Ava state the model needs on every turn —
 *   role framing, system facts, enumerated skills, memory content,
 *   and the required JSON response contract. Injected every turn
 *   (not just first-run) so memory updates land immediately.
 * - `userPrompt`: strictly the sender's email — From/Subject header
 *   plus the body, plus a list of attachment paths if any. Ava does
 *   NOT paraphrase, expand, or inject her own instructions here.
 */
export function buildPrompt(input: BuildPromptInput): BuiltPrompt {
	return {
		systemPrompt: buildSystemPrompt(input),
		userPrompt: buildUserPrompt(input),
	};
}

function buildSystemPrompt(input: BuildPromptInput): string {
	const sections: string[] = [];

	sections.push(
		[
			`You are Ava, orchestrating engineering work for ActualVoice. Max and Brian email you; your job is to execute what they ask, using your tools (Bash, Edit, Write, Grep, Read, Glob, Task, etc.). When in doubt, do what a capable engineer at a small startup would do in your shoes.`,
			``,
			`Working directory: ${input.worktreePath}.`,
		].join("\n"),
	);

	const persona = input.persona.trim();
	if (persona) sections.push(`## Who you are (voice, tone, identity)\n${persona}`);

	sections.push(
		[
			`## System facts`,
			`- You have no background workers and no runtime between turns. This turn ends the moment you stop emitting stdout. Nothing runs after you exit — anything you claim in \`email_body\` or \`actions\` must be produced by tool calls in this turn.`,
			`- Skills are auto-discovered from \`.claude/skills/\` — see the enumerated list below. Use them when relevant; do not reimplement their logic.`,
			`- \`${input.outgoingPath}/\` is for binary attachments only (screenshots, diffs, PDFs, generated reports). Do NOT write your reply text to a file anywhere — the reply lives inside the JSON \`email_body\` field of your response.`,
			`- Sender attachments (if any) are listed in the user message with absolute paths inside this sandbox — just \`cat\` / \`read\` them directly.`,
		].join("\n"),
	);

	if (input.skills.length > 0) {
		const lines = [`## Skills (${input.skills.length} available — discovered from .claude/skills/)`];
		for (const s of input.skills) {
			lines.push(`- **${s.name}**: ${s.description}`);
		}
		sections.push(lines.join("\n"));
	}

	const gm = input.globalMemory.trim();
	if (gm) sections.push(`## Ava memory (global)\n${gm}`);
	const tm = input.threadMemory.trim();
	if (tm) sections.push(`## Ava memory (this thread)\n${tm}`);

	sections.push(
		[
			`## Response format (required — Ava parses this)`,
			``,
			`Your stdout MUST be exactly ONE JSON object, nothing else before or after it. Schema:`,
			``,
			"```json",
			`{`,
			`  "status": "done" | "partial" | "blocked",`,
			`  "email_body": "<plain-text reply Ava forwards verbatim to the sender; may contain code fences>",`,
			`  "summary": "<one-line machine summary, logged for audit — not emailed>",`,
			`  "actions": [`,
			`    {"kind": "commit", "sha": "<7+ char hex>", "branch": "<name>", "message": "<subject line>"},`,
			`    {"kind": "pr_opened", "number": <int>, "url": "https://github.com/...", "branch": "<name>"},`,
			`    {"kind": "pr_updated", "number": <int>, "url": "..."},`,
			`    {"kind": "issue_comment", "issue": <int>, "url": "..."},`,
			`    {"kind": "issue_create", "number": <int>, "url": "..."},`,
			`    {"kind": "file_write", "path": "<absolute path>"},`,
			`    {"kind": "shell", "cmd": "<first 100 chars>", "exit": <int>}`,
			`  ],`,
			`  "unfinished": [ {"what": "<short description>", "reason": "<why not done this turn>"} ]`,
			`}`,
			"```",
			``,
			`Rules:`,
			`- \`actions\` lists things you physically did in this turn. Empty \`actions\` means you did no work — set \`status: "blocked"\` and explain in \`email_body\`. Do not claim "done" with empty actions; Ava will flag that mismatch to the sender.`,
			`- \`email_body\` is the reply text. Write what a careful engineer would write to a teammate — direct, specific, no preambles ("Here is my reply:"), no future-promises ("ETA 45 min", "I'll ping you when done"). If you couldn't finish, say so.`,
			`- \`unfinished\` captures work that was planned but didn't land this turn. OK to be non-empty with \`status: "partial"\`.`,
			`- If the request can't reasonably be done in one turn, set \`status: "blocked"\`, put the reason in \`email_body\`, and suggest a split. Do not start and abandon.`,
		].join("\n"),
	);

	return sections.join("\n\n");
}

function buildUserPrompt(input: BuildPromptInput): string {
	const cleanBody = input.newestMessage.bodyText.replace(DIRECTIVE_STRIP, "").trim();
	const lines: string[] = [`From: ${input.newestMessage.from}`, `Subject: ${input.newestMessage.subject}`];
	if (input.newestMessage.attachments.length > 0) {
		lines.push("");
		lines.push(`Attachments (${input.newestMessage.attachments.length}):`);
		for (const a of input.newestMessage.attachments) {
			const size = formatBytes(a.bytes);
			lines.push(`- ${a.filename} (${size}) → ${a.containerPath}`);
		}
	}
	lines.push("");
	lines.push(cleanBody);
	return lines.join("\n");
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Enumerate skills under `<worktreeAbsPath>/.claude/skills/`.
 * Each skill directory must contain a SKILL.md with YAML-ish frontmatter
 * (`--- ... ---`) exposing at least `name` and `description`.
 *
 * Returns an empty list if the skills dir doesn't exist or contains no
 * parseable skill files. Never throws — silent-fails individual skills.
 */
export async function discoverSkills(worktreeAbsPath: string): Promise<SkillMeta[]> {
	const skillsDir = join(worktreeAbsPath, ".claude/skills");
	if (!existsSync(skillsDir)) return [];
	let entries: Dirent[];
	try {
		entries = await readdir(skillsDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const skills: SkillMeta[] = [];
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const skillPath = join(skillsDir, e.name, "SKILL.md");
		if (!existsSync(skillPath)) continue;
		let content: string;
		try {
			content = await readFile(skillPath, "utf-8");
		} catch {
			continue;
		}
		const fm = parseFrontmatter(content);
		skills.push({
			name: fm.name ?? e.name,
			description: fm.description ?? "(no description)",
		});
	}
	skills.sort((a, b) => a.name.localeCompare(b.name));
	return skills;
}

function parseFrontmatter(md: string): Record<string, string> {
	const m = /^---\s*\r?\n([\s\S]+?)\r?\n---/.exec(md.trimStart());
	if (!m) return {};
	const out: Record<string, string> = {};
	const lines = m[1].split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		const kv = /^([a-z_][a-z0-9_-]*)\s*:\s*(.*?)\s*$/i.exec(lines[i]);
		if (!kv) {
			i++;
			continue;
		}
		const key = kv[1];
		let val = kv[2];
		// YAML folded-block scalar (`key: >` or `key: |`) — subsequent indented
		// lines are the value, joined with spaces (for `>`) until we hit a line
		// that isn't indented or is empty at the outer level.
		if (val === ">" || val === "|") {
			const folded: string[] = [];
			i++;
			while (i < lines.length && (lines[i].startsWith("  ") || lines[i].trim() === "")) {
				if (lines[i].trim()) folded.push(lines[i].trim());
				i++;
			}
			out[key] = folded.join(val === ">" ? " " : "\n");
			continue;
		}
		const quoted = /^"(.*)"$/.exec(val) ?? /^'(.*)'$/.exec(val);
		if (quoted) val = quoted[1];
		out[key] = val;
		i++;
	}
	return out;
}
