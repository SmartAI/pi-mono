import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Backend, BackendRunOpts } from "./backends/types.js";
import { type CronMatch, parseCron } from "./cron.js";
import type { GmailClient } from "./gmail/client.js";
import { log } from "./log.js";
import { clearOutgoing, scanOutgoing } from "./outgoing.js";
import { discoverSkills } from "./prompt-builder.js";
import type { Store } from "./store.js";
import type { AvaSettings, BackendName, ScheduleEntry } from "./types.js";

export interface SchedulerDeps {
	dataDir: string;
	store: Store;
	settings: AvaSettings;
	backends: Record<BackendName, Backend>;
	ensureWorktree: (tid: string) => Promise<string>;
	sandboxExec: BackendRunOpts["sandboxExec"];
	cwdInContainer: (tid: string) => string;
	containerDataDir: string;
	gmail: GmailClient;
	signal: AbortSignal;
}

interface CompiledEntry extends ScheduleEntry {
	matcher: CronMatch;
	lastFiredKey: string | null;
}

export async function loadSchedules(dataDir: string): Promise<ScheduleEntry[]> {
	const p = join(dataDir, "schedules.json");
	if (!existsSync(p)) return [];
	const raw = JSON.parse(await readFile(p, "utf-8"));
	if (!Array.isArray(raw)) throw new Error(`schedules.json must be a JSON array`);
	return raw as ScheduleEntry[];
}

/**
 * Starts the scheduler loop. Resolves when `deps.signal` aborts.
 *
 * Design notes:
 * - Each schedule has a stable threadId (`sched-<name>`) so the worktree is
 *   reused across fires — we don't pay the npm-install cost every daily tick.
 * - Each fire runs the backend with a FRESH session (any existing session-id
 *   files are deleted first). Scheduled jobs are self-contained; we don't want
 *   "yesterday's standup" accumulating in the agent's conversation memory.
 * - Sends go out as new Gmail threads (no inReplyTo), not replies.
 */
export async function runScheduler(deps: SchedulerDeps): Promise<void> {
	if (!deps.settings.schedules.enabled) {
		log.info("scheduler disabled in settings — no scheduled jobs will fire");
		await waitForAbort(deps.signal);
		return;
	}
	let raw: ScheduleEntry[];
	try {
		raw = await loadSchedules(deps.dataDir);
	} catch (e) {
		log.error("scheduler: failed to load schedules.json", { error: String(e) });
		await waitForAbort(deps.signal);
		return;
	}
	const compiled: CompiledEntry[] = [];
	const seenNames = new Set<string>();
	for (const e of raw) {
		try {
			validateEntry(e);
			if (seenNames.has(e.name)) throw new Error(`duplicate schedule name: ${e.name}`);
			seenNames.add(e.name);
			compiled.push({ ...e, matcher: parseCron(e.cron), lastFiredKey: null });
		} catch (err) {
			log.error("scheduler: skipping invalid entry", { name: e?.name, error: String(err) });
		}
	}
	if (compiled.length === 0) {
		log.info("scheduler: no valid schedules configured");
		await waitForAbort(deps.signal);
		return;
	}
	log.info("scheduler started", { count: compiled.length, names: compiled.map((c) => c.name) });

	const tick = (): void => {
		const now = new Date();
		const key = minuteKey(now);
		for (const entry of compiled) {
			if (!entry.matcher.match(now)) continue;
			if (entry.lastFiredKey === key) continue;
			entry.lastFiredKey = key;
			void fireOne(entry, deps, now).catch((err) =>
				log.error("scheduled job threw", { name: entry.name, error: String(err) }),
			);
		}
	};
	const tickMs = Math.max(5_000, deps.settings.schedules.tickMs);
	const interval = setInterval(tick, tickMs);
	tick(); // catch the current minute if any schedule matches right now

	await waitForAbort(deps.signal);
	clearInterval(interval);
}

async function fireOne(entry: CompiledEntry, deps: SchedulerDeps, now: Date): Promise<void> {
	const dateStr = now.toISOString().slice(0, 10);
	const threadId = `sched-${entry.name}`;
	const backendName = entry.backend ?? deps.settings.backend.default;
	const backend = deps.backends[backendName];
	if (!backend) {
		log.error("scheduler: unknown backend", { name: entry.name, backend: backendName });
		return;
	}
	const subject = entry.subject.replaceAll("{date}", dateStr);

	log.info("scheduled job firing", { name: entry.name, threadId, backend: backendName });

	await deps.ensureWorktree(threadId);
	const threadDir = deps.store.threadPathAbs(threadId);
	await clearOutgoing(threadDir);
	await resetBackendSessions(threadDir);

	const worktreeHost = deps.store.threadPathAbs(threadId, "worktree");
	const skills = await discoverSkills(worktreeHost);
	const globalMemory = await readIfExists(join(deps.store.dataDir, "MEMORY.md"));
	const { systemPrompt, userPrompt } = buildScheduledPrompt({
		entry,
		dateStr,
		worktreePath: deps.cwdInContainer(threadId),
		outgoingPath: "./outgoing",
		skills,
		globalMemory,
	});

	let result: Awaited<ReturnType<Backend["run"]>>;
	try {
		result = await backend.run({
			threadId,
			cwdInContainer: deps.cwdInContainer(threadId),
			systemPrompt,
			userPrompt,
			dataDir: deps.store.dataDir,
			containerDataDir: deps.containerDataDir,
			timeoutMs: deps.settings.timeouts.perRunMs,
			sandboxExec: deps.sandboxExec,
		});
	} catch (e) {
		log.error("scheduled backend threw", { name: entry.name, error: String(e) });
		await deps.store.appendScheduledFire(threadId, {
			kind: "scheduled-fire",
			name: entry.name,
			cron: entry.cron,
			at: now.toISOString(),
			backend: backendName,
			subject,
			outcome: "failed",
			failureKind: "exception",
		});
		return;
	}

	const kind = backend.classify(result);
	if (kind !== "ok") {
		log.error("scheduled backend failed", {
			name: entry.name,
			kind,
			exitCode: result.exitCode,
			stderr: result.stderr.slice(0, 2_000),
		});
		await deps.store.appendScheduledFire(threadId, {
			kind: "scheduled-fire",
			name: entry.name,
			cron: entry.cron,
			at: now.toISOString(),
			backend: backendName,
			subject,
			outcome: "failed",
			exitCode: result.exitCode,
			failureKind: kind,
		});
		try {
			await deps.gmail.send({
				to: entry.to.join(", "),
				cc: entry.cc ?? [],
				subject: `[FAILED] ${subject}`,
				bodyText:
					`Scheduled job "${entry.name}" (${entry.cron}) failed.\n\n` +
					`Backend: ${backendName}\n` +
					`Failure kind: ${kind}\n` +
					`Exit code: ${result.exitCode}\n\n` +
					`Logs: ./data/threads/${threadId}/`,
				attachments: [],
			});
		} catch (e) {
			log.error("scheduled failure-notification send errored", { name: entry.name, error: String(e) });
		}
		return;
	}

	const bodyText = result.stdout.trim();
	const { attached, overflow } = await scanOutgoing(threadDir, deps.settings.attachments.perReplyMaxBytes);

	// Silent-run contract: an empty body + no attachments means the agent
	// intentionally had nothing to report (e.g. the health-check skill stays
	// quiet when production didn't transition). Skip the send so the
	// scheduled inbox only lights up on signal.
	if (!bodyText && attached.length === 0) {
		await deps.store.appendScheduledFire(threadId, {
			kind: "scheduled-fire",
			name: entry.name,
			cron: entry.cron,
			at: now.toISOString(),
			backend: backendName,
			subject,
			outcome: "sent",
			gmailMessageId: "", // intentionally empty: nothing was sent
		});
		log.info("scheduled job ran silently (empty body, nothing to send)", { name: entry.name });
		return;
	}

	const capMB = Math.floor(deps.settings.attachments.perReplyMaxBytes / (1024 * 1024));
	const finalBody = overflow.length
		? `${bodyText}\n\n---\n(Some files exceeded the ${capMB}MB attachment cap and were not attached: ${overflow.map((f) => f.filename).join(", ")}.)`
		: bodyText;

	const sentId = await deps.gmail.send({
		to: entry.to.join(", "),
		cc: entry.cc ?? [],
		subject,
		bodyText: finalBody,
		attachments: attached.map((a) => ({ filename: a.filename, path: a.path })),
	});

	await deps.store.appendScheduledFire(threadId, {
		kind: "scheduled-fire",
		name: entry.name,
		cron: entry.cron,
		at: now.toISOString(),
		backend: backendName,
		subject,
		outcome: "sent",
		gmailMessageId: sentId,
	});
	log.info("scheduled job sent", { name: entry.name, messageId: sentId, to: entry.to });
}

import type { SkillMeta } from "./prompt-builder.js";

async function readIfExists(path: string): Promise<string> {
	if (!existsSync(path)) return "";
	try {
		return await readFile(path, "utf-8");
	} catch {
		return "";
	}
}

function buildScheduledPrompt(input: {
	entry: ScheduleEntry;
	dateStr: string;
	worktreePath: string;
	outgoingPath: string;
	skills: SkillMeta[];
	globalMemory: string;
}): { systemPrompt: string; userPrompt: string } {
	// Scheduled flows use plain-text output (not the JSON contract) because
	// the task body in the schedule entry already dictates output shape; the
	// operator who wrote the schedule owns it.
	const sys: string[] = [];
	sys.push(
		[
			`You are Ava running a scheduled job — NOT replying to an email.`,
			`Working directory: ${input.worktreePath}.`,
			`Today's date: ${input.dateStr}.`,
			`Schedule: ${input.entry.name} (cron: ${input.entry.cron}).`,
			`Recipients: ${input.entry.to.join(", ")}.`,
		].join("\n"),
	);
	sys.push(
		[
			`## System facts`,
			`- You have no background workers and no runtime between turns — everything you produce must happen in this turn's tool calls.`,
			`- \`${input.outgoingPath}/\` is only for binary or large attachments (screenshots, diffs, PDFs). Do NOT write your reply text to a file.`,
		].join("\n"),
	);
	if (input.skills.length > 0) {
		const lines = [`## Skills (${input.skills.length} available — discovered from .claude/skills/)`];
		for (const s of input.skills) {
			lines.push(`- **${s.name}**: ${s.description}`);
		}
		sys.push(lines.join("\n"));
	}
	const gm = input.globalMemory.trim();
	if (gm) sys.push(`## Ava memory (global)\n${gm}`);
	sys.push(
		[
			`## How to output`,
			`- Your **final stdout** becomes the email body verbatim. Plain text, code fences OK, no preambles, no "Here's the report:" framing — just the message.`,
			`- If you have nothing to report (e.g. the health-check skill's silent-when-stable case), emit **empty stdout** and Ava will skip sending entirely.`,
		].join("\n"),
	);
	return { systemPrompt: sys.join("\n\n"), userPrompt: input.entry.prompt };
}

function validateEntry(e: ScheduleEntry): void {
	if (!e || typeof e !== "object") throw new Error(`entry is not an object`);
	if (typeof e.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(e.name)) {
		throw new Error(`"name" must match /^[a-z0-9][a-z0-9-]{0,62}$/ (got ${JSON.stringify(e.name)})`);
	}
	if (typeof e.cron !== "string" || !e.cron.trim()) throw new Error(`"${e.name}": missing "cron"`);
	if (!Array.isArray(e.to) || e.to.length === 0) throw new Error(`"${e.name}": "to" must be a non-empty array`);
	if (typeof e.subject !== "string" || !e.subject) throw new Error(`"${e.name}": missing "subject"`);
	if (typeof e.prompt !== "string" || !e.prompt) throw new Error(`"${e.name}": missing "prompt"`);
}

async function resetBackendSessions(threadDir: string): Promise<void> {
	const candidates = ["claude-session-id", "codex-session-id", "pi-session.jsonl"];
	for (const f of candidates) {
		const p = join(threadDir, f);
		if (existsSync(p)) {
			await unlink(p).catch(() => {
				/* best-effort — next run will overwrite */
			});
		}
	}
}

function minuteKey(d: Date): string {
	return d.toISOString().slice(0, 16);
}

function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}
