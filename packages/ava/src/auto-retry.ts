import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./log.js";
import { enqueueRetry } from "./retry-queue.js";

/**
 * Background auto-retry — periodically walks every Ava thread dir and, for
 * any thread whose latest log.jsonl event is a fixable internal failure
 * (parse errors today), drops a retry marker so the retry-queue loop
 * re-enqueues the thread. No user email needed. Max gets a normal reply
 * when the retried agent run finishes.
 *
 * Safety rules:
 *   - Only `category: "parse"` failures auto-retry. auth / crash / rate-
 *     limit / triage need human attention (re-auth, investigate, wait for
 *     quota). Never auto-retry those — they'd just keep failing.
 *   - Debounce per-failure: if the newest failure already has a subsequent
 *     synthetic retry-trigger inbound in the log, we've already retried —
 *     skip. (The retry-queue watcher appends those inbounds on pickup.)
 *   - Min age 30s: give any in-flight recovery path a moment to finish
 *     before second-guessing it. Rate: tick every 5 min, so a parse
 *     failure surfaces as a retry within ~5 min.
 *   - Cap per-failure retries at 2 — after that, leave for human triage.
 *     Counts synthetic retry inbounds between failures as prior attempts.
 */

export interface AutoRetryDeps {
	dataDir: string;
	signal: AbortSignal;
	intervalMs?: number; // default 5 minutes
	minFailureAgeMs?: number; // default 30 seconds
	maxRetriesPerFailure?: number; // default 2
}

export async function runAutoRetry(deps: AutoRetryDeps): Promise<void> {
	const tickMs = Math.max(60_000, deps.intervalMs ?? 5 * 60_000);
	const minAgeMs = Math.max(5_000, deps.minFailureAgeMs ?? 30_000);
	const maxRetries = Math.max(1, deps.maxRetriesPerFailure ?? 2);
	const threadsRoot = join(deps.dataDir, "threads");
	log.info("auto-retry watcher started", { threadsRoot, tickMs });

	const tick = async (): Promise<void> => {
		if (!existsSync(threadsRoot)) return;
		let dirs: string[];
		try {
			dirs = (await readdir(threadsRoot, { withFileTypes: true }))
				.filter((e) => e.isDirectory() && !e.name.startsWith("sched-"))
				.map((e) => e.name);
		} catch (e) {
			log.warn("auto-retry readdir failed", { error: String(e) });
			return;
		}
		for (const tid of dirs) {
			try {
				await considerThread({
					tid,
					logPath: join(threadsRoot, tid, "log.jsonl"),
					dataDir: deps.dataDir,
					minAgeMs,
					maxRetries,
				});
			} catch (e) {
				log.warn("auto-retry thread consideration threw", { tid, error: String(e) });
			}
		}
	};

	await tick();
	const handle = setInterval(() => {
		void tick();
	}, tickMs);
	await new Promise<void>((resolve) => {
		if (deps.signal.aborted) {
			resolve();
			return;
		}
		deps.signal.addEventListener("abort", () => resolve(), { once: true });
	});
	clearInterval(handle);
}

interface Row {
	kind?: string;
	at?: string;
	gmailMessageId?: string;
	category?: string;
	reason?: string;
}

async function considerThread(opts: {
	tid: string;
	logPath: string;
	dataDir: string;
	minAgeMs: number;
	maxRetries: number;
}): Promise<void> {
	if (!existsSync(opts.logPath)) return;
	const content = await readFile(opts.logPath, "utf-8");
	const rows: Row[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			/* skip malformed */
		}
	}
	if (rows.length === 0) return;

	// Walk backward to find the newest failure. Everything after it tells us
	// whether someone's already retried, replied, or otherwise moved on.
	let lastFailureIdx = -1;
	for (let i = rows.length - 1; i >= 0; i--) {
		if (rows[i].kind === "failure") {
			lastFailureIdx = i;
			break;
		}
	}
	if (lastFailureIdx === -1) return;

	const failure = rows[lastFailureIdx];
	if (failure.category !== "parse") return; // only parse failures auto-retry

	const failureAgeMs = Date.now() - Date.parse(failure.at ?? "");
	if (!Number.isFinite(failureAgeMs) || failureAgeMs < opts.minAgeMs) return;

	// Count subsequent synthetic retries and detect any human/agent activity
	// after the failure — if there's an outbound or real inbound after it,
	// the thread has moved on and we don't need to intervene.
	let retriesAfter = 0;
	let movedOnAfter = false;
	for (let i = lastFailureIdx + 1; i < rows.length; i++) {
		const r = rows[i];
		if (r.kind === "outbound") {
			movedOnAfter = true;
			break;
		}
		if (r.kind === "inbound") {
			const msgId = r.gmailMessageId ?? "";
			if (msgId.startsWith("<retry-") && msgId.endsWith("@ava.local>")) {
				retriesAfter++;
			} else {
				movedOnAfter = true; // real human inbound — they're driving, stand down
				break;
			}
		}
	}
	if (movedOnAfter) return;
	if (retriesAfter >= opts.maxRetries) return;

	// Also skip if a marker is already pending in the retry queue — the
	// retry-queue watcher hasn't picked it up yet; don't double-queue.
	const markerPath = join(opts.dataDir, "retry-queue", `${opts.tid}.json`);
	if (existsSync(markerPath)) return;

	const reason = `auto-retry after parse failure: ${(failure.reason ?? "").slice(0, 200)}`;
	await enqueueRetry({ dataDir: opts.dataDir, threadId: opts.tid, reason });
	log.info("auto-retry: queued parse-failed thread", {
		tid: opts.tid,
		priorRetries: retriesAfter,
		failureAgeS: Math.round(failureAgeMs / 1000),
	});
}
