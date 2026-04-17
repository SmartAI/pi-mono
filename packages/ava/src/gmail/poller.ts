import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../log.js";
import type { Store } from "../store.js";
import { decideAllowlist } from "./allowlist.js";
import type { GmailClient } from "./client.js";
import { parseRaw } from "./parse.js";

export interface PollerOptions {
	client: GmailClient;
	store: Store;
	allowlist: string[];
	intervalMs: number;
	query: string;
	onAccepted: (threadId: string) => void;
	onStopSignal: AbortSignal;
}

export async function runPoller(opts: PollerOptions): Promise<void> {
	let backoffMs = opts.intervalMs;
	while (!opts.onStopSignal.aborted) {
		try {
			await tick(opts);
			backoffMs = opts.intervalMs; // success: reset backoff
		} catch (e) {
			log.warn("poll tick failed", { error: String(e), nextInMs: backoffMs });
			backoffMs = Math.min(backoffMs * 2, 5 * 60_000);
		}
		await sleep(backoffMs, opts.onStopSignal);
	}
}

async function tick(opts: PollerOptions): Promise<void> {
	const ids = await opts.client.listUnread(opts.query);
	for (const id of ids) {
		const { raw, threadId } = await opts.client.getRaw(id);
		if (!threadId) continue;

		// Parse first so dedup is keyed on the RFC-822 Message-Id header,
		// not the Gmail internal message id (a different hex string).
		const parsed = await parseRaw(raw, { threadId });

		if (await opts.store.hasMessageId(threadId, parsed.gmailMessageId)) {
			await opts.client.markRead(id);
			continue;
		}

		const attDir = opts.store.threadPathAbs(threadId, `attachments/${parsed.gmailMessageId.replace(/[<>]/g, "")}`);
		await mkdir(attDir, { recursive: true });
		// Attachments: we write zero-byte placeholders matching filenames so downstream paths are
		// stable. A follow-up task can fetch bytes via users.messages.attachments.get if needed.
		for (const a of parsed.attachments) {
			const abs = join(attDir, a.filename);
			await writeFile(abs, Buffer.alloc(0));
			a.path = abs;
		}

		const decision = decideAllowlist(parsed, opts.allowlist);
		if (!decision.allowed) {
			log.warn("allowlist reject", { from: parsed.from, reason: decision.reason, suspicious: decision.suspicious });
			await opts.store.appendReject(threadId, {
				kind: "allowlist-reject",
				gmailMessageId: parsed.gmailMessageId,
				from: parsed.from,
				reason: decision.reason,
				at: parsed.receivedAt,
			});
			await opts.client.markRead(id);
			continue;
		}

		await opts.store.appendInbound(threadId, {
			kind: "inbound",
			gmailMessageId: parsed.gmailMessageId,
			from: parsed.from,
			at: parsed.receivedAt,
			subject: parsed.subject,
			bodyText: parsed.bodyText,
			attachments: parsed.attachments,
		});
		await opts.client.markRead(id);
		opts.onAccepted(threadId);
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true },
		);
	});
}
