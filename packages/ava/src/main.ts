#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultBackends, runThread } from "./agent-invoker.js";
import { shouldEmitPiTosWarning } from "./backends/select.js";
import { Dispatcher } from "./dispatcher.js";
import { GmailClient } from "./gmail/client.js";
import { gmailAuthSetup } from "./gmail/oauth-setup.js";
import { runPoller } from "./gmail/poller.js";
import { log } from "./log.js";
import { makeSandboxExec } from "./sandbox.js";
import { Store } from "./store.js";
import { type AvaSettings, DEFAULT_SETTINGS } from "./types.js";
import { WorktreeManager } from "./worktree.js";

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const subcommand = argv[0];
	if (subcommand === "auth:gmail") {
		const dataDir = process.env.AVA_DATA_DIR ?? "./data";
		await gmailAuthSetup({
			credentialsPath: join(dataDir, "gmail-credentials.json"),
			tokenPath: join(dataDir, "gmail-token.json"),
		});
		return;
	}

	const { values } = parseArgs({
		args: argv,
		options: {
			"data-dir": { type: "string", default: "./data" },
			sandbox: { type: "string", default: "docker:ava-sandbox" },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help) {
		console.log(`Usage:
  ava auth:gmail                                   # first-time OAuth
  ava --data-dir <dir> --sandbox=docker:<name>     # run the service`);
		return;
	}

	const dataDir = values["data-dir"]!;
	const sandboxSpec = values.sandbox!;
	if (!sandboxSpec.startsWith("docker:")) {
		throw new Error(`Unsupported sandbox spec: ${sandboxSpec}. Use docker:<container-name>.`);
	}
	const containerName = sandboxSpec.slice("docker:".length);

	const settings = await loadSettings(dataDir);
	const store = new Store(dataDir);
	const allowlist = await loadAllowlist(dataDir);

	if (shouldEmitPiTosWarning(settings.backend)) {
		log.warn(
			"pi backend is configured as default or fallback. Anthropic's OAuth is not clearly sanctioned in third-party apps. Prefer claude-code unless you need pi's features.",
		);
	}

	const gmail = new GmailClient();
	await gmail.init({
		credentialsPath: join(dataDir, "gmail-credentials.json"),
		tokenPath: join(dataDir, "gmail-token.json"),
	});

	const wm = new WorktreeManager({
		bareRepoPath: join(dataDir, "repo.git"),
		threadsRoot: join(dataDir, "threads"),
	});

	const sandboxExec = makeSandboxExec({ containerName });
	const containerDataDir = "/workspace";
	const cwdInContainer = (tid: string) => `${containerDataDir}/threads/${tid}/worktree`;
	const backends = defaultBackends();

	const selfAddress = (await gmail.getProfileEmail()).toLowerCase();
	log.info("authenticated as", { mailbox: selfAddress });

	const dispatcher = new Dispatcher(
		async (tid) => {
			try {
				await runThread(tid, {
					store,
					settings,
					allowedBackends: backends,
					ensureWorktree: (id) => wm.ensureWorktree(id),
					sandboxExec,
					cwdInContainer,
					containerDataDir,
					selfAddress,
					sendAck: async (threadId, originalId, to, cc, subject) => {
						await gmail.send({
							threadId,
							to,
							cc,
							subject,
							bodyText: "On it. I'll reply when done.\n— Ava",
							inReplyTo: originalId,
							references: [originalId],
							attachments: [],
						});
					},
					sendReply: async (reply) => {
						return gmail.send({
							threadId: reply.threadId,
							to: reply.to,
							cc: reply.cc,
							subject: reply.subject,
							bodyText: reply.bodyText,
							inReplyTo: reply.inReplyToMessageId,
							references: [reply.inReplyToMessageId],
							attachments: reply.attachments.map((a) => ({ filename: a.filename, path: a.path })),
						});
					},
					sendStatus: async (threadId, text, to, cc, inReplyTo, subject) => {
						await gmail.send({
							threadId,
							to,
							cc,
							subject,
							bodyText: text,
							inReplyTo,
							references: [inReplyTo],
							attachments: [],
						});
					},
				});
			} catch (e) {
				log.error("runThread failed", { threadId: tid, error: String(e) });
			}
		},
		{ maxWorkers: settings.dispatcher.maxConcurrency },
	);

	const shutdown = new AbortController();
	process.on("SIGINT", () => shutdown.abort());
	process.on("SIGTERM", () => shutdown.abort());

	const pruneTimer = setInterval(
		async () => {
			try {
				const removed = await wm.prune(settings.prune.maxInactiveDays * 24 * 60 * 60 * 1000, store);
				if (removed > 0) log.info("pruned inactive worktrees", { removed });
			} catch (e) {
				log.warn("prune failed", { error: String(e) });
			}
		},
		24 * 60 * 60 * 1000,
	);

	try {
		await runPoller({
			client: gmail,
			store,
			allowlist,
			intervalMs: settings.timeouts.gmailPollMs,
			query: "is:unread newer_than:7d -in:sent",
			onAccepted: (tid) => dispatcher.enqueue(tid),
			onStopSignal: shutdown.signal,
		});
	} finally {
		clearInterval(pruneTimer);
		await dispatcher.drain();
	}
}

async function loadSettings(dataDir: string): Promise<AvaSettings> {
	const p = join(dataDir, "settings.json");
	if (!existsSync(p)) return DEFAULT_SETTINGS;
	const raw = JSON.parse(await readFile(p, "utf-8")) as Partial<AvaSettings>;
	return {
		...DEFAULT_SETTINGS,
		...raw,
		backend: { ...DEFAULT_SETTINGS.backend, ...(raw.backend ?? {}) },
		dispatcher: { ...DEFAULT_SETTINGS.dispatcher, ...(raw.dispatcher ?? {}) },
	};
}

async function loadAllowlist(dataDir: string): Promise<string[]> {
	const p = join(dataDir, "allowlist.json");
	if (!existsSync(p)) {
		log.error("allowlist.json missing — exiting to avoid open-to-internet state");
		process.exit(2);
	}
	const raw = JSON.parse(await readFile(p, "utf-8")) as { emails: string[] };
	return raw.emails ?? [];
}

main().catch((e) => {
	log.error("fatal", { error: String(e) });
	process.exit(1);
});
