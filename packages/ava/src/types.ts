export interface ParsedInboundMessage {
	gmailMessageId: string; // Gmail's Message-Id header value
	threadId: string; // Gmail threadId
	from: string; // email address (normalised lowercase)
	to: string[];
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
	to: string;
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
	gitFetchIntervalMs: number; // default 10 * 60_000
}

export const DEFAULT_SETTINGS: AvaSettings = {
	backend: { default: "claude-code", fallback: "codex" },
	prune: { maxInactiveDays: 14 },
	timeouts: { perRunMs: 20 * 60_000, gmailPollMs: 30_000 },
	attachments: { perReplyMaxBytes: 20 * 1024 * 1024 },
	gitFetchIntervalMs: 10 * 60_000,
};
