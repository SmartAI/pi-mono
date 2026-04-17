import type { ParsedInboundMessage } from "../types.js";

export type AllowlistDecision = { allowed: true } | { allowed: false; reason: string; suspicious: boolean };

export function decideAllowlist(msg: ParsedInboundMessage, allowlist: string[]): AllowlistDecision {
	const allow = new Set(allowlist.map((e) => e.toLowerCase()));
	const from = msg.from.toLowerCase();
	const isAllowed = allow.has(from);
	if (!isAllowed) {
		return { allowed: false, reason: "sender not on allowlist", suspicious: false };
	}
	if (msg.dkimResult !== "pass") {
		return { allowed: false, reason: `dkim=${msg.dkimResult} on allowlisted sender`, suspicious: true };
	}
	if (msg.spfResult !== "pass") {
		return { allowed: false, reason: `spf=${msg.spfResult} on allowlisted sender`, suspicious: true };
	}
	return { allowed: true };
}
