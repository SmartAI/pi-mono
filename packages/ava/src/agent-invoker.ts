import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClaudeCodeBackend } from "./backends/claude-code.js";
import { CodexBackend } from "./backends/codex.js";
import { PiBackend } from "./backends/pi.js";
import { parseBackendDirective, selectBackend } from "./backends/select.js";
import type { Backend, BackendRunOpts, BackendRunResult } from "./backends/types.js";
import { log } from "./log.js";
import { clearOutgoing, scanOutgoing } from "./outgoing.js";
import { buildPrompt } from "./prompt-builder.js";
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
	sendAck: (tid: string, originalMessageId: string, to: string, subject: string) => Promise<void>;
	sendReply: (reply: OutboundReply) => Promise<string>;
	sendStatus: (tid: string, text: string, to: string, inReplyTo: string, subject: string) => Promise<void>;
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

	await deps.sendAck(tid, newestInbound.gmailMessageId, newestInbound.from, reSubject(newestInbound.subject));

	await deps.ensureWorktree(tid);
	await clearOutgoing(store.threadPathAbs(tid));

	const directive = parseBackendDirective(newestInbound.bodyText);
	const { primary, fallback } = selectBackend({
		settingsDefault: settings.backend.default,
		settingsFallback: settings.backend.fallback,
		directive,
	});

	const globalMemory = await readIf(join(store.dataDir, "MEMORY.md"));
	const threadMemory = await readIf(join(store.threadPathAbs(tid), "MEMORY.md"));
	const isFirstRun =
		!existsSync(join(store.threadPathAbs(tid), "claude-session-id")) &&
		!existsSync(join(store.threadPathAbs(tid), "codex-session-id")) &&
		!existsSync(join(store.threadPathAbs(tid), "pi-session.jsonl"));
	const prompt = buildPrompt({
		isFirstRun,
		newestMessage: newestInbound,
		worktreePath: deps.cwdInContainer(tid),
		outgoingPath: "./outgoing",
		globalMemory,
		threadMemory,
	});

	let result = await runBackend(primary, deps, tid, prompt);
	let backendUsed: BackendName = primary;
	let kind: FailureKind = deps.allowedBackends[primary].classify(result);
	if (kind === "rate-limit" && fallback) {
		await deps.sendStatus(
			tid,
			`${primary} is rate-limited. Trying ${fallback} as fallback; I'll continue this thread automatically.`,
			newestInbound.from,
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

	const replyBody = normalizeReply(result.stdout);
	const { attached, overflow } = await scanOutgoing(store.threadPathAbs(tid), settings.attachments.perReplyMaxBytes);
	const finalBody = overflow.length
		? `${replyBody}\n\n---\n(Some files exceeded the ${Math.floor(settings.attachments.perReplyMaxBytes / (1024 * 1024))}MB attachment cap and were not attached: ${overflow.map((f) => f.filename).join(", ")}. Push these to the PR instead.)`
		: replyBody;

	const sentId = await deps.sendReply({
		threadId: tid,
		to: newestInbound.from,
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
	});
}

async function runBackend(
	name: BackendName,
	deps: AgentInvokerDeps,
	tid: string,
	prompt: string,
): Promise<BackendRunResult> {
	const backend = deps.allowedBackends[name];
	return backend.run({
		threadId: tid,
		cwdInContainer: deps.cwdInContainer(tid),
		prompt,
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
	if (kind === "auth") {
		await deps.sendStatus(
			tid,
			`My ${primary} auth is broken. Please re-authenticate ${primary} on the host. I'll retry automatically once the credentials are refreshed.`,
			newestInbound.from,
			newestInbound.gmailMessageId,
			subject,
		);
		return;
	}
	if (kind === "rate-limit") {
		await deps.sendStatus(
			tid,
			`Hit rate limits on all configured backends. I'll resume this thread when quotas reset. Reply again any time to bump the queue.`,
			newestInbound.from,
			newestInbound.gmailMessageId,
			subject,
		);
		return;
	}
	log.error("agent crash", { threadId: tid, exitCode: result.exitCode, stderr: result.stderr.slice(0, 4_000) });
	await deps.sendStatus(
		tid,
		`The agent subprocess exited with code ${result.exitCode}. Logs have been written to the thread directory. Reply to this email to retry.`,
		newestInbound.from,
		newestInbound.gmailMessageId,
		subject,
	);
}

interface NewestInbound {
	gmailMessageId: string;
	from: string;
	subject: string;
	bodyText: string;
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
					subject: row.subject,
					bodyText: row.bodyText,
				};
			}
		} catch {
			// skip corrupt line
		}
	}
	return null;
}

async function readIf(path: string): Promise<string> {
	if (!existsSync(path)) return "";
	return readFile(path, "utf-8");
}

function reSubject(subject: string): string {
	return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}
