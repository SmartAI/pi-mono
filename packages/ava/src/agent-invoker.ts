import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildEmailBody, parseAgentContract } from "./agent-contract.js";
import { ClaudeCodeBackend } from "./backends/claude-code.js";
import { CodexBackend } from "./backends/codex.js";
import { PiBackend } from "./backends/pi.js";
import { parseBackendDirective, selectBackend } from "./backends/select.js";
import type { Backend, BackendRunOpts, BackendRunResult } from "./backends/types.js";
import { log } from "./log.js";
import { clearOutgoing, scanOutgoing } from "./outgoing.js";
import { type BuiltPrompt, buildPrompt, discoverSkills, type InboundAttachment } from "./prompt-builder.js";
import { normalizeReply } from "./reply-format.js";
import type { Store } from "./store.js";
import type { AvaSettings, BackendName, FailureKind, OutboundReply } from "./types.js";

export interface AgentInvokerDeps {
	store: Store;
	settings: AvaSettings;
	allowedBackends: Record<BackendName, Backend>;
	ensureWorktree: (tid: string) => Promise<string>;
	sandboxExec: BackendRunOpts["sandboxExec"];
	cwdInContainer: (tid: string) => string;
	containerDataDir: string; // e.g. "/workspace" — container-side path that mirrors Store.dataDir
	selfAddress: string; // Ava's own Gmail mailbox — excluded from reply-all CC list
	sendReply: (reply: OutboundReply) => Promise<string>;
	sendStatus: (
		tid: string,
		text: string,
		to: string,
		cc: string[],
		inReplyTo: string,
		subject: string,
	) => Promise<void>;
}

export function defaultBackends(): Record<BackendName, Backend> {
	return {
		"claude-code": new ClaudeCodeBackend(),
		codex: new CodexBackend(),
		pi: new PiBackend(),
	};
}

export async function runThread(tid: string, deps: AgentInvokerDeps): Promise<void> {
	const { store, settings } = deps;
	const newestInbound = await readNewestInbound(store, tid);
	if (!newestInbound) return;

	const recipients = buildReplyRecipients(newestInbound, deps.selfAddress, deps.settings.replyDefaults.alwaysCc);

	await deps.ensureWorktree(tid);
	await clearOutgoing(store.threadPathAbs(tid));

	const directive = parseBackendDirective(newestInbound.bodyText);
	const { primary, fallback } = selectBackend({
		settingsDefault: settings.backend.default,
		settingsFallback: settings.backend.fallback,
		directive,
	});

	// Inject persona + memory every turn (not just first-run) so edits to
	// any of these files land in the next invocation without waiting for
	// a fresh thread. Persona defines WHO Ava is; memory is what she knows.
	const persona = await readIf(join(store.dataDir, "SOUL.md"));
	const globalMemory = await readIf(join(store.dataDir, "MEMORY.md"));
	const threadMemory = await readIf(join(store.threadPathAbs(tid), "MEMORY.md"));

	// Enumerate skills from the worktree's .claude/skills/ so the agent
	// knows by name+description what's available, not just that a dir exists.
	const worktreeHostPath = store.threadPathAbs(tid, "worktree");
	const skills = await discoverSkills(worktreeHostPath);

	// Translate attachment paths from host-absolute to container-absolute
	// so the listing we hand to the agent actually resolves in its shell.
	const attachmentsForPrompt: InboundAttachment[] = (newestInbound.attachments ?? []).map((a) => ({
		filename: a.filename,
		bytes: a.bytes,
		containerPath: a.path.startsWith(store.dataDir)
			? `${deps.containerDataDir}${a.path.slice(store.dataDir.length)}`
			: a.path,
	}));

	const prompt = buildPrompt({
		newestMessage: {
			from: newestInbound.from,
			subject: newestInbound.subject,
			bodyText: newestInbound.bodyText,
			attachments: attachmentsForPrompt,
		},
		worktreePath: deps.cwdInContainer(tid),
		outgoingPath: "./outgoing",
		persona,
		globalMemory,
		threadMemory,
		skills,
	});

	let result = await runBackend(primary, deps, tid, prompt);
	let backendUsed: BackendName = primary;
	let kind: FailureKind = deps.allowedBackends[primary].classify(result);
	if (kind === "rate-limit" && fallback) {
		await deps.sendStatus(
			tid,
			`${primary} is rate-limited. Trying ${fallback} as fallback; I'll continue this thread automatically.`,
			recipients.to,
			recipients.cc,
			newestInbound.gmailMessageId,
			reSubject(newestInbound.subject),
		);
		result = await runBackend(fallback, deps, tid, prompt);
		backendUsed = fallback;
		kind = deps.allowedBackends[fallback].classify(result);
	}

	if (kind !== "ok") {
		await handleFailure(kind, { deps, tid, newestInbound, primary, fallback, result });
		return;
	}

	const parsed = parseAgentContract(result.stdout);
	if (!parsed.ok) {
		log.error("agent contract parse failed", { threadId: tid, reason: parsed.reason });
		await deps.sendStatus(
			tid,
			[
				`Ava couldn't parse the agent's response as the required JSON contract.`,
				``,
				`Parse failure: ${parsed.reason}`,
				``,
				`This means the reply wasn't sent — the raw agent output is logged server-side at data/threads/${tid}/ for review.`,
				`Please reply to this email to retry; I'll re-run the agent on the same thread.`,
			].join("\n"),
			recipients.to,
			recipients.cc,
			newestInbound.gmailMessageId,
			reSubject(newestInbound.subject),
		);
		return;
	}
	const contract = parsed.contract;

	const replyBody = normalizeReply(buildEmailBody(contract));
	const { attached, overflow } = await scanOutgoing(store.threadPathAbs(tid), settings.attachments.perReplyMaxBytes);
	const finalBody = overflow.length
		? `${replyBody}\n\n---\n(Some files exceeded the ${Math.floor(settings.attachments.perReplyMaxBytes / (1024 * 1024))}MB attachment cap and were not attached: ${overflow.map((f) => f.filename).join(", ")}. Push these to the PR instead.)`
		: replyBody;

	const sentId = await deps.sendReply({
		threadId: tid,
		to: recipients.to,
		cc: recipients.cc,
		inReplyToMessageId: newestInbound.gmailMessageId,
		subject: reSubject(newestInbound.subject),
		bodyText: finalBody,
		attachments: attached.map((a) => ({ filename: a.filename, path: a.path, bytes: a.bytes })),
	});

	await store.appendOutbound(tid, {
		kind: "outbound",
		gmailMessageId: sentId,
		inReplyToMessageId: newestInbound.gmailMessageId,
		at: new Date().toISOString(),
		backendUsed,
		attachments: attached.map((a) => ({ filename: a.filename, bytes: a.bytes })),
		contract: {
			status: contract.status,
			summary: contract.summary,
			actionCount: contract.actions.length,
			actionKinds: contract.actions.map((a) => a.kind),
			unfinishedCount: contract.unfinished?.length ?? 0,
		},
	});
}

async function runBackend(
	name: BackendName,
	deps: AgentInvokerDeps,
	tid: string,
	prompt: BuiltPrompt,
): Promise<BackendRunResult> {
	const backend = deps.allowedBackends[name];
	return backend.run({
		threadId: tid,
		cwdInContainer: deps.cwdInContainer(tid),
		systemPrompt: prompt.systemPrompt,
		userPrompt: prompt.userPrompt,
		dataDir: deps.store.dataDir,
		containerDataDir: deps.containerDataDir,
		timeoutMs: deps.settings.timeouts.perRunMs,
		sandboxExec: deps.sandboxExec,
	});
}

async function handleFailure(
	kind: FailureKind,
	ctx: {
		deps: AgentInvokerDeps;
		tid: string;
		newestInbound: NewestInbound;
		primary: BackendName;
		fallback: BackendName | null;
		result: BackendRunResult;
	},
): Promise<void> {
	const { deps, tid, newestInbound, primary, result } = ctx;
	const subject = reSubject(newestInbound.subject);
	const recipients = buildReplyRecipients(newestInbound, deps.selfAddress, deps.settings.replyDefaults.alwaysCc);
	if (kind === "auth") {
		await deps.sendStatus(
			tid,
			`My ${primary} auth is broken. Please re-authenticate ${primary} on the host. I'll retry automatically once the credentials are refreshed.`,
			recipients.to,
			recipients.cc,
			newestInbound.gmailMessageId,
			subject,
		);
		return;
	}
	if (kind === "rate-limit") {
		await deps.sendStatus(
			tid,
			`Hit rate limits on all configured backends. I'll resume this thread when quotas reset. Reply again any time to bump the queue.`,
			recipients.to,
			recipients.cc,
			newestInbound.gmailMessageId,
			subject,
		);
		return;
	}
	log.error("agent crash", { threadId: tid, exitCode: result.exitCode, stderr: result.stderr.slice(0, 4_000) });
	await deps.sendStatus(
		tid,
		`The agent subprocess exited with code ${result.exitCode}. Logs have been written to the thread directory. Reply to this email to retry.`,
		recipients.to,
		recipients.cc,
		newestInbound.gmailMessageId,
		subject,
	);
}

interface NewestInbound {
	gmailMessageId: string;
	from: string;
	to: string[];
	cc: string[];
	subject: string;
	bodyText: string;
	attachments: Array<{ filename: string; path: string; bytes: number }>;
}

async function readNewestInbound(store: Store, tid: string): Promise<NewestInbound | null> {
	const logPath = join(store.threadPathAbs(tid), "log.jsonl");
	if (!existsSync(logPath)) return null;
	const content = await readFile(logPath, "utf-8");
	const rows = content.split("\n").filter(Boolean);
	for (let i = rows.length - 1; i >= 0; i--) {
		try {
			const row = JSON.parse(rows[i]);
			if (row.kind === "inbound") {
				return {
					gmailMessageId: row.gmailMessageId,
					from: row.from,
					to: row.to ?? [],
					cc: row.cc ?? [],
					subject: row.subject,
					bodyText: row.bodyText,
					attachments: row.attachments ?? [],
				};
			}
		} catch {
			// skip corrupt line
		}
	}
	return null;
}

/**
 * Build reply-all recipient set per RFC 5322 conventions:
 * - `to` = original sender
 * - `cc` = everyone from the original To: + Cc: minus Ava's own address and minus the sender
 *
 * Ava's own address is detected from the outbound inbox identity (claude@actualvoice.ai
 * in production). We pass it in as `selfAddress`.
 */
export function buildReplyRecipients(
	inbound: { from: string; to: string[]; cc: string[] },
	selfAddress: string,
	alwaysCc: string[] = [],
): { to: string; cc: string[] } {
	const self = selfAddress.toLowerCase();
	const sender = inbound.from.toLowerCase();
	const seen = new Set<string>([sender, self]);
	const cc: string[] = [];
	// Reply-all: everyone else from the original To + Cc.
	for (const addr of [...inbound.to, ...inbound.cc]) {
		const a = addr.toLowerCase();
		if (seen.has(a)) continue;
		seen.add(a);
		cc.push(a);
	}
	// Always-Cc defaults (e.g. "CC max@ on every reply to Brian"): merged in
	// AFTER reply-all so they can't dup with sender or self.
	for (const addr of alwaysCc) {
		const a = addr.toLowerCase();
		if (seen.has(a)) continue;
		seen.add(a);
		cc.push(a);
	}
	return { to: sender, cc };
}

async function readIf(path: string): Promise<string> {
	if (!existsSync(path)) return "";
	return readFile(path, "utf-8");
}

function reSubject(subject: string): string {
	return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}
