export interface ParsedInboundMessage {
	gmailMessageId: string; // Gmail's Message-Id header value
	threadId: string; // Gmail threadId
	from: string; // email address (normalised lowercase)
	to: string[]; // all addresses from the To: header, lowercased
	cc: string[]; // all addresses from the Cc: header, lowercased
	subject: string;
	bodyText: string; // quoted-history stripped
	dkimResult: "pass" | "fail" | "none";
	spfResult: "pass" | "fail" | "none";
	attachments: Array<{ filename: string; path: string; bytes: number }>;
	receivedAt: string; // ISO 8601
	headers: Record<string, string>; // lowercased keys
}

export interface OutboundReply {
	threadId: string;
	to: string; // primary recipient (usually the original sender)
	cc: string[]; // everyone else from the original To: + Cc: minus Ava's own address
	inReplyToMessageId: string;
	subject: string;
	bodyText: string;
	attachments: Array<{ filename: string; path: string; bytes: number }>;
}

export type BackendName = "claude-code" | "codex" | "pi";

export type FailureKind = "ok" | "rate-limit" | "auth" | "crash";

export interface AvaSettings {
	backend: {
		default: BackendName;
		fallback: BackendName | null;
	};
	prune: {
		maxInactiveDays: number; // default 14
	};
	timeouts: {
		perRunMs: number; // default 20 * 60_000
		gmailPollMs: number; // default 30_000
	};
	attachments: {
		perReplyMaxBytes: number; // default 20 * 1024 * 1024
	};
	dispatcher: {
		maxConcurrency: number; // default 2 — cross-thread parallelism cap; same-thread is always sequential
	};
	replyDefaults: {
		// Addresses always added to every outbound Cc (ack, status, final reply).
		// De-duped against To and against self, so self-as-sender never CCs itself.
		alwaysCc: string[];
		// Append a one-line cost/usage footer to each coding-agent reply.
		// Useful early on for rate-limit awareness; can flip off when
		// noise outweighs signal.
		includeCostFooter: boolean;
	};
	schedules: {
		enabled: boolean; // default true — flip false to pause all cron jobs without removing the config
		tickMs: number; // default 30_000 — how often the scheduler checks cron matches
	};
	triage: {
		enabled: boolean; // default true — flip false to disable the triage step (every allowlisted email goes to the coding agent)
		timeoutMs: number; // default 60_000 — triage should be fast; extend if your model is slow
	};
	webUi: {
		enabled: boolean; // default true — local dashboard at http://127.0.0.1:<port>
		host: string; // default "127.0.0.1" — bind address; DO NOT change without auth
		port: number; // default 3333
	};
	gitFetchIntervalMs: number; // default 10 * 60_000
}

export interface ScheduleEntry {
	name: string; // filesystem-safe id ([a-z0-9][a-z0-9-]*); used as thread id prefix
	cron: string; // 5-field crontab expression — evaluated in host local time
	to: string[]; // primary recipients (joined with ", " for the To: header)
	cc?: string[]; // optional extra Cc
	subject: string; // supports {date} token → today's YYYY-MM-DD
	prompt: string; // instructions for Ava; stdout becomes the email body
	backend?: BackendName; // optional override of settings.backend.default
}

export const DEFAULT_SETTINGS: AvaSettings = {
	backend: { default: "claude-code", fallback: "codex" },
	prune: { maxInactiveDays: 14 },
	timeouts: { perRunMs: 20 * 60_000, gmailPollMs: 30_000 },
	attachments: { perReplyMaxBytes: 20 * 1024 * 1024 },
	dispatcher: { maxConcurrency: 2 },
	replyDefaults: { alwaysCc: [], includeCostFooter: true },
	schedules: { enabled: true, tickMs: 30_000 },
	triage: { enabled: true, timeoutMs: 60_000 },
	webUi: { enabled: true, host: "127.0.0.1", port: 3333 },
	gitFetchIntervalMs: 10 * 60_000,
};
