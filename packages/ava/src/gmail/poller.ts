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

		// Parse with attachmentsDir so parseRaw writes REAL bytes to disk
		// (mailparser already has them in .content — we just need a target).
		// Dedup is keyed on the RFC-822 Message-Id header, not Gmail's
		// internal message id.
		const tmpParsed = await parseRaw(raw, { threadId });
		if (await opts.store.hasMessageId(threadId, tmpParsed.gmailMessageId)) {
			await opts.client.markRead(id);
			continue;
		}
		const attDir = opts.store.threadPathAbs(threadId, `attachments/${tmpParsed.gmailMessageId.replace(/[<>]/g, "")}`);
		const parsed = await parseRaw(raw, { threadId, attachmentsDir: attDir });

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
			to: parsed.to,
			cc: parsed.cc,
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
