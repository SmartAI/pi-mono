import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentContract } from "./agent-contract.js";
import { buildEmailBody, parseAgentContract, resolveContractAttachments } from "./agent-contract.js";
import { ClaudeCodeBackend } from "./backends/claude-code.js";
import { CodexBackend } from "./backends/codex.js";
import { PiBackend } from "./backends/pi.js";
import { parseBackendDirective, selectBackend } from "./backends/select.js";
import type { Backend, BackendRunOpts, BackendRunResult } from "./backends/types.js";
import { formatUsageFooter } from "./backends/usage.js";
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

	// Enumerate Ava-level skills from data/skills/. Project skills
	// (voicepulse/.claude/skills/) are auto-loaded by Claude Code in the
	// worktree; re-listing them here would duplicate and potentially
	// contradict Claude Code's own skill index.
	const skills = await discoverSkills(join(store.dataDir, "skills"));

	// Translate attachment paths from host-absolute to container-absolute
	// so the listing we hand to the agent actually resolves in its shell.
	const attachmentsForPrompt: InboundAttachment[] = (newestInbound.attachments ?? []).map((a) => ({
		filename: a.filename,
		bytes: a.bytes,
		containerPath: a.path.startsWith(store.dataDir)
			? `${deps.containerDataDir}${a.path.slice(store.dataDir.length)}`
			: a.path,
	}));

	// Scan log.jsonl for issue/PR numbers previously linked to this thread
	// so the agent can reference them (and knows NOT to re-file a new issue
	// when one already exists — see the SOUL force-rule on auto-filing).
	const { linkedIssueNumbers, linkedPrNumbers } = await scanLinkedResources(store, tid);
	const gmailThreadUrl = `https://mail.google.com/mail/u/0/#all/${tid}`;

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
		gmailThreadUrl,
		linkedIssueNumbers,
		linkedPrNumbers,
	});

	// Use the thread's FIRST inbound subject for all outgoing mail. Gmail's
	// threadId honoring requires subject match; Max has been known to edit
	// the subject mid-thread which otherwise causes new-thread spawning.
	const canonicalSubject = (await threadCanonicalSubject(store, tid)) || newestInbound.subject;
	const replySubject = reSubject(canonicalSubject);

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
			replySubject,
		);
		result = await runBackend(fallback, deps, tid, prompt);
		backendUsed = fallback;
		kind = deps.allowedBackends[fallback].classify(result);
	}

	if (kind !== "ok") {
		await handleFailure(kind, { deps, tid, newestInbound, primary, fallback, result, replySubject });
		return;
	}

	const parsed = parseAgentContract(result.stdout);
	let contract: AgentContract;
	if (parsed.ok) {
		contract = parsed.contract;
	} else {
		// Parse failed. Before giving up and sending a diagnostic, see if the
		// stdout is a substantive prose reply we can recover — the agent
		// sometimes ignores the JSON contract on long sessions and emits a
		// clean human reply instead. Losing that reply is a bigger cost than
		// sending it wrapped in a "partial" contract with a warning prefix.
		const prose = result.stdout.trim();
		const looksLikeProseReply =
			prose.length >= 100 && !prose.startsWith("Error") && !prose.startsWith("Traceback") && !/^\s*\{/.test(prose); // don't try to "recover" malformed JSON — that's a different failure
		if (looksLikeProseReply) {
			log.warn("agent contract parse failed; recovering prose reply", {
				threadId: tid,
				reason: parsed.reason,
				stdoutChars: prose.length,
			});
			await store.appendFailure(tid, {
				kind: "failure",
				gmailMessageId: newestInbound.gmailMessageId,
				category: "parse",
				reason: `agent did not emit JSON contract; prose reply recovered (${parsed.reason})`,
				detail: prose.slice(0, 500),
				at: new Date().toISOString(),
			});
			contract = {
				status: "partial",
				email_body: `⚠ Agent did not emit the required JSON contract — actions/attachments metadata is missing. Recovered reply below.\n\n---\n\n${prose}`,
				summary: "agent did not emit contract; prose recovered",
				actions: [],
				unfinished: [],
				attachments: undefined,
			};
		} else {
			log.error("agent contract parse failed and stdout not recoverable", {
				threadId: tid,
				reason: parsed.reason,
			});
			await store.appendFailure(tid, {
				kind: "failure",
				gmailMessageId: newestInbound.gmailMessageId,
				category: "parse",
				reason: `agent contract parse failed: ${parsed.reason}`,
				detail: parsed.rawStdout.slice(0, 500),
				at: new Date().toISOString(),
			});
			await deps.sendStatus(
				tid,
				[
					`Ava couldn't parse the agent's response as the required JSON contract, and the stdout wasn't a recoverable prose reply either.`,
					``,
					`Parse failure: ${parsed.reason}`,
					``,
					`This means the reply wasn't sent — the raw agent output is logged server-side at data/threads/${tid}/ for review.`,
					`Please reply to this email to retry; I'll re-run the agent on the same thread.`,
				].join("\n"),
				recipients.to,
				recipients.cc,
				newestInbound.gmailMessageId,
				replySubject,
			);
			return;
		}
	}

	const replyBody = normalizeReply(buildEmailBody(contract));

	// Resolve attachments from the contract's declared list — the robust
	// path. Falls back to scanning <threadDir>/outgoing/ for anything the
	// agent may have dropped there without declaring (safety net against
	// forgotten declarations; will be deprecated once the contract path
	// is proven stable across all inbound agents' resumed sessions).
	const declared = contract.attachments ?? [];
	const { resolved, errors, overCap } = await resolveContractAttachments(declared, {
		hostDataDir: store.dataDir,
		containerDataDir: deps.containerDataDir,
		perReplyCapBytes: settings.attachments.perReplyMaxBytes,
	});
	if (errors.length) {
		log.warn("agent declared attachments that failed to resolve", { threadId: tid, errors });
	}
	const remainingCap = settings.attachments.perReplyMaxBytes - resolved.reduce((n, a) => n + a.bytes, 0);
	const scanned = await scanOutgoing(store.threadPathAbs(tid), remainingCap);
	// Dedupe against contract-declared entries by filename (the most common
	// overlap case) and by resolved host path.
	const seenPaths = new Set(resolved.map((a) => a.hostPath));
	const seenFilenames = new Set(resolved.map((a) => a.filename));
	const fallbackAttached = scanned.attached.filter((f) => !seenPaths.has(f.path) && !seenFilenames.has(f.filename));
	const attached = [
		...resolved.map((a) => ({ filename: a.filename, path: a.hostPath, bytes: a.bytes })),
		...fallbackAttached,
	];
	const overflow = [...overCap.map((o) => ({ filename: o.filename, bytes: o.bytes, path: "" })), ...scanned.overflow];
	const capMB = Math.floor(settings.attachments.perReplyMaxBytes / (1024 * 1024));
	let finalBody = overflow.length
		? `${replyBody}\n\n---\n(Some files exceeded the ${capMB}MB attachment cap and were not attached: ${overflow.map((f) => f.filename).join(", ")}. Push these to the PR instead.)`
		: replyBody;
	// Opt-in cost footer — telemetry on per-reply token usage for rate-limit
	// awareness. Only appended when the backend produced usage data (claude
	// today) and the setting is on.
	if (settings.replyDefaults.includeCostFooter && result.usage) {
		finalBody = `${finalBody}\n\n${formatUsageFooter(result.usage)}`;
	}

	const sentId = await deps.sendReply({
		threadId: tid,
		to: recipients.to,
		cc: recipients.cc,
		inReplyToMessageId: newestInbound.gmailMessageId,
		subject: replySubject,
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
			linkedIssueNumbers: extractNumbersByKinds(contract.actions, ["issue_create", "issue_comment"]),
			linkedPrNumbers: extractNumbersByKinds(contract.actions, ["pr_opened", "pr_updated"]),
		},
		usage: result.usage,
	});
}

function extractNumbersByKinds(actions: Array<{ kind: string; [k: string]: unknown }>, kinds: string[]): number[] {
	const set = new Set<number>();
	for (const a of actions) {
		if (!kinds.includes(a.kind)) continue;
		const n = (a as { number?: unknown; issue?: unknown }).number ?? (a as { issue?: unknown }).issue;
		if (typeof n === "number" && Number.isFinite(n)) set.add(n);
	}
	return Array.from(set).sort((a, b) => a - b);
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
		replySubject: string;
	},
): Promise<void> {
	const { deps, tid, newestInbound, primary, result, replySubject } = ctx;
	const subject = replySubject;
	const recipients = buildReplyRecipients(newestInbound, deps.selfAddress, deps.settings.replyDefaults.alwaysCc);
	if (kind === "auth") {
		await deps.store.appendFailure(tid, {
			kind: "failure",
			gmailMessageId: newestInbound.gmailMessageId,
			category: "auth",
			reason: `${primary} auth is broken — credentials need refresh`,
			at: new Date().toISOString(),
		});
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
		await deps.store.appendFailure(tid, {
			kind: "failure",
			gmailMessageId: newestInbound.gmailMessageId,
			category: "rate-limit",
			reason: `hit rate limits on all configured backends`,
			at: new Date().toISOString(),
		});
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
	await deps.store.appendFailure(tid, {
		kind: "failure",
		gmailMessageId: newestInbound.gmailMessageId,
		category: "crash",
		reason: `agent subprocess exited with code ${result.exitCode}`,
		detail: result.stderr.slice(0, 500),
		at: new Date().toISOString(),
	});
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

/**
 * Walk the thread's log.jsonl and collect every issue / PR number that a
 * prior agent turn wrote to the outbound contract. Deduped. Used to tell
 * the current agent which resources it can comment on rather than
 * creating new duplicates.
 */
export async function scanLinkedResources(
	store: Store,
	tid: string,
): Promise<{ linkedIssueNumbers: number[]; linkedPrNumbers: number[] }> {
	const logPath = join(store.threadPathAbs(tid), "log.jsonl");
	if (!existsSync(logPath)) return { linkedIssueNumbers: [], linkedPrNumbers: [] };
	const content = await readFile(logPath, "utf-8");
	const issues = new Set<number>();
	const prs = new Set<number>();
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line);
			if (row.kind !== "outbound") continue;
			for (const n of row.contract?.linkedIssueNumbers ?? []) {
				if (Number.isFinite(n)) issues.add(n);
			}
			for (const n of row.contract?.linkedPrNumbers ?? []) {
				if (Number.isFinite(n)) prs.add(n);
			}
		} catch {
			// skip malformed line
		}
	}
	return {
		linkedIssueNumbers: Array.from(issues).sort((a, b) => a - b),
		linkedPrNumbers: Array.from(prs).sort((a, b) => a - b),
	};
}

/**
 * Return the thread's canonical subject — the subject of the FIRST real
 * (non-synthetic) inbound in the log. Gmail threads by both threadId AND
 * subject when `users.messages.send` is called with a threadId — if our
 * outgoing subject doesn't match the thread's original, Gmail silently
 * ignores the threadId and creates a new thread.
 *
 * This bit us on threads where Max edited the subject mid-conversation
 * (e.g. "[Action Required]Re: ..."): the latest inbound's subject no
 * longer matched the thread's canonical, so Ava's reply spawned a new
 * Gmail thread. Using the first-inbound subject everywhere keeps Gmail's
 * threading rule satisfied regardless of drift in later messages.
 *
 * Skips synthetic retry-trigger inbounds (msgid `<retry-...@ava.local>`)
 * since their subject is derived from whatever the latest real inbound
 * was at retry time and doesn't represent the thread's true origin.
 */
export async function threadCanonicalSubject(store: Store, tid: string): Promise<string> {
	const logPath = join(store.threadPathAbs(tid), "log.jsonl");
	if (!existsSync(logPath)) return "";
	const content = await readFile(logPath, "utf-8");
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line);
			if (row.kind !== "inbound") continue;
			const msgId = (row.gmailMessageId ?? "") as string;
			if (msgId.startsWith("<retry-") && msgId.endsWith("@ava.local>")) continue;
			return (row.subject ?? "") as string;
		} catch {
			// skip malformed line
		}
	}
	return "";
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
