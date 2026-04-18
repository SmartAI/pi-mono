import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type LogEntry =
	| {
			kind: "inbound";
			gmailMessageId: string;
			from: string;
			to?: string[];
			cc?: string[];
			at: string;
			subject: string;
			bodyText: string;
			attachments?: Array<{ filename: string; path: string; bytes: number }>;
	  }
	| {
			kind: "outbound";
			gmailMessageId: string; // the Message-Id of the reply we sent
			inReplyToMessageId: string;
			at: string;
			backendUsed: string;
			attachments: Array<{ filename: string; bytes: number }>;
			// Summary of the JSON contract the agent returned on this turn.
			// Full email body + action list isn't duplicated here — it's in
			// the Claude session transcript already. This is a compact audit
			// trail so `tail log.jsonl | jq .` tells you at a glance whether
			// the agent actually did anything on this turn.
			contract?: {
				status: "done" | "partial" | "blocked";
				summary?: string;
				actionCount: number;
				actionKinds: string[];
				unfinishedCount: number;
			};
	  }
	| {
			kind: "scheduled-fire";
			name: string; // schedule entry name
			cron: string;
			at: string;
			backend: string;
			subject: string;
			outcome: "sent" | "failed";
			gmailMessageId?: string; // present when outcome=sent
			exitCode?: number; // present when outcome=failed
			failureKind?: string; // present when outcome=failed
	  }
	| { kind: "allowlist-reject"; gmailMessageId: string; from: string; reason: string; at: string }
	| {
			kind: "triage";
			gmailMessageId: string; // the inbound message that was triaged
			route: "skip" | "coding_agent";
			reason: string;
			confidence: "low" | "high";
			at: string;
	  };

export class Store {
	constructor(public readonly dataDir: string) {}

	private threadDir(threadId: string): string {
		return join(this.dataDir, "threads", threadId);
	}

	async ensureThread(threadId: string): Promise<string> {
		const dir = this.threadDir(threadId);
		await mkdir(join(dir, "attachments"), { recursive: true });
		await mkdir(join(dir, "outgoing"), { recursive: true });
		return dir;
	}

	async appendInbound(threadId: string, entry: Extract<LogEntry, { kind: "inbound" }>): Promise<void> {
		await this.ensureThread(threadId);
		if (await this.hasMessageId(threadId, entry.gmailMessageId)) return;
		await appendFile(join(this.threadDir(threadId), "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	async appendOutbound(threadId: string, entry: Extract<LogEntry, { kind: "outbound" }>): Promise<void> {
		await this.ensureThread(threadId);
		await appendFile(join(this.threadDir(threadId), "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	async appendReject(threadId: string, entry: Extract<LogEntry, { kind: "allowlist-reject" }>): Promise<void> {
		await this.ensureThread(threadId);
		await appendFile(join(this.threadDir(threadId), "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	async appendScheduledFire(threadId: string, entry: Extract<LogEntry, { kind: "scheduled-fire" }>): Promise<void> {
		await this.ensureThread(threadId);
		await appendFile(join(this.threadDir(threadId), "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	async appendTriage(threadId: string, entry: Extract<LogEntry, { kind: "triage" }>): Promise<void> {
		await this.ensureThread(threadId);
		await appendFile(join(this.threadDir(threadId), "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	async hasMessageId(threadId: string, messageId: string): Promise<boolean> {
		const path = join(this.threadDir(threadId), "log.jsonl");
		if (!existsSync(path)) return false;
		const content = await readFile(path, "utf-8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const row = JSON.parse(line) as LogEntry;
				if (row.kind === "inbound" && row.gmailMessageId === messageId) return true;
			} catch {
				// corrupt line, skip
			}
		}
		return false;
	}

	async listThreadIds(): Promise<string[]> {
		const dir = join(this.dataDir, "threads");
		if (!existsSync(dir)) return [];
		return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
	}

	async threadLastActivityMs(threadId: string): Promise<number> {
		const path = join(this.threadDir(threadId), "log.jsonl");
		if (!existsSync(path)) return 0;
		const s = await stat(path);
		return s.mtimeMs;
	}

	async readSessionPointer(threadId: string, backend: string): Promise<string | null> {
		const path = join(this.threadDir(threadId), `${backend}-session-id`);
		if (!existsSync(path)) return null;
		return (await readFile(path, "utf-8")).trim();
	}

	async writeSessionPointer(threadId: string, backend: string, sessionId: string): Promise<void> {
		await this.ensureThread(threadId);
		await writeFile(join(this.threadDir(threadId), `${backend}-session-id`), sessionId);
	}

	threadPathAbs(threadId: string, sub = ""): string {
		return sub ? join(this.threadDir(threadId), sub) : this.threadDir(threadId);
	}
}
