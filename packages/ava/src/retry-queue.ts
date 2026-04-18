import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./log.js";
import type { Store } from "./store.js";

/**
 * Retry queue — a file-based signal the coding agent uses to ask the daemon
 * to re-enqueue a thread on behalf of a meta-command like "retry all parse
 * failures." Agent drops a marker at `/workspace/retry-queue/<tid>.json`;
 * this loop picks it up, synthesizes a "please retry" inbound on that
 * thread's log.jsonl (so the agent sees a user-facing trigger on resume),
 * enqueues the dispatcher, and deletes the marker.
 *
 * Why not have the agent directly enqueue via an HTTP/IPC call? Files are
 * the simplest durable signal that survives daemon restarts and sandbox
 * boundaries — the agent only has filesystem access to /workspace anyway.
 */

export interface RetryQueueDeps {
	dataDir: string; // host absolute path, e.g. /home/mliu/.../data
	store: Store;
	enqueue: (threadId: string) => void; // dispatcher.enqueue
	signal: AbortSignal;
	intervalMs?: number; // default 30s — low cost, the agent's marker is durable
}

interface MarkerFile {
	reason?: string; // free-form, written to the synthetic inbound body
}

export async function runRetryQueue(deps: RetryQueueDeps): Promise<void> {
	const queueDir = join(deps.dataDir, "retry-queue");
	await mkdir(queueDir, { recursive: true });
	const interval = Math.max(5_000, deps.intervalMs ?? 30_000);
	log.info("retry-queue watcher started", { queueDir, intervalMs: interval });

	const tick = async (): Promise<void> => {
		let entries: string[];
		try {
			entries = (await readdir(queueDir, { withFileTypes: true }))
				.filter((e) => e.isFile() && e.name.endsWith(".json"))
				.map((e) => e.name);
		} catch (e) {
			log.warn("retry-queue readdir failed", { error: String(e) });
			return;
		}
		for (const name of entries) {
			const tid = name.slice(0, -".json".length);
			const markerPath = join(queueDir, name);
			try {
				await processMarker({ ...deps, tid, markerPath });
			} catch (e) {
				log.error("retry-queue entry failed; leaving marker in place", {
					tid,
					error: String(e),
				});
			}
		}
	};

	await tick();
	const handle = setInterval(() => {
		void tick();
	}, interval);
	await new Promise<void>((resolve) => {
		if (deps.signal.aborted) {
			resolve();
			return;
		}
		deps.signal.addEventListener("abort", () => resolve(), { once: true });
	});
	clearInterval(handle);
}

async function processMarker(opts: {
	store: Store;
	tid: string;
	markerPath: string;
	enqueue: (tid: string) => void;
}): Promise<void> {
	const { store, tid, markerPath, enqueue } = opts;

	// Sanity: the target thread must actually exist (have a log.jsonl).
	// Otherwise this marker is bogus and we drop it with a warning rather
	// than creating empty threads.
	const logPath = join(store.threadPathAbs(tid), "log.jsonl");
	if (!existsSync(logPath)) {
		log.warn("retry-queue: marker references non-existent thread; dropping", { tid });
		await unlink(markerPath).catch(() => {
			/* ignore */
		});
		return;
	}

	// Pull sender metadata from the latest real inbound. The synthetic
	// retry-inbound needs to carry the same from/to/cc so buildReplyRecipients
	// routes the agent's reply back to the original humans — not into /dev/null.
	const inbound = await findLatestInbound(logPath);
	if (!inbound) {
		log.warn("retry-queue: thread has no inbound to mirror; dropping", { tid });
		await unlink(markerPath).catch(() => {
			/* ignore */
		});
		return;
	}

	let markerContent: MarkerFile = {};
	try {
		const raw = await readFile(markerPath, "utf-8");
		markerContent = raw.trim() ? (JSON.parse(raw) as MarkerFile) : {};
	} catch {
		// Accept empty or malformed markers — they're signals, not payloads.
	}

	const reason = markerContent.reason?.trim() || "retry requested by meta-command";
	const syntheticMsgId = `<retry-${randomUUID()}@ava.local>`;
	const subject = /^re:/i.test(inbound.subject) ? inbound.subject : `Re: ${inbound.subject}`;
	const synthetic = {
		kind: "inbound" as const,
		gmailMessageId: syntheticMsgId,
		from: inbound.from,
		to: inbound.to,
		cc: inbound.cc,
		at: new Date().toISOString(),
		subject,
		bodyText: `[synthetic retry trigger] ${reason}\n\n— previously on this thread, Ava short-circuited or was asked to pause. Please resume from the last known state and complete the work.`,
		attachments: [] as Array<{ filename: string; path: string; bytes: number }>,
	};
	await appendFile(logPath, `${JSON.stringify(synthetic)}\n`);

	enqueue(tid);
	log.info("retry-queue: enqueued thread with synthetic retry inbound", { tid, reason });

	await unlink(markerPath).catch(() => {
		/* ignore */
	});
}

interface LatestInboundMeta {
	from: string;
	to: string[];
	cc: string[];
	subject: string;
}

async function findLatestInbound(logPath: string): Promise<LatestInboundMeta | null> {
	const text = await readFile(logPath, "utf-8");
	const lines = text.split("\n").filter((l) => l.trim());
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const row = JSON.parse(lines[i]);
			if (row.kind === "inbound") {
				return {
					from: row.from,
					to: row.to ?? [],
					cc: row.cc ?? [],
					subject: row.subject ?? "",
				};
			}
		} catch {
			// skip malformed line
		}
	}
	return null;
}

/**
 * Convenience helper for tests and any future programmatic retry path:
 * drop a marker file that the running daemon will pick up on its next
 * tick. Callers pass the host-side data dir (NOT container path).
 */
export async function enqueueRetry(opts: { dataDir: string; threadId: string; reason?: string }): Promise<void> {
	const queueDir = join(opts.dataDir, "retry-queue");
	await mkdir(queueDir, { recursive: true });
	const payload = JSON.stringify({ reason: opts.reason ?? "" });
	await writeFile(join(queueDir, `${opts.threadId}.json`), payload);
}
