import { describe, expect, it } from "vitest";
import { decideAllowlist } from "../../src/gmail/allowlist.js";
import type { ParsedInboundMessage } from "../../src/types.js";

function msg(over: Partial<ParsedInboundMessage>): ParsedInboundMessage {
	return {
		gmailMessageId: "<m@x>",
		threadId: "T",
		from: "brian@actualvoice.ai",
		to: ["claude@actualvoice.ai"],
		subject: "hi",
		bodyText: "",
		dkimResult: "pass",
		spfResult: "pass",
		attachments: [],
		receivedAt: "2026-04-16T12:00:00Z",
		headers: {},
		...over,
	};
}

describe("decideAllowlist", () => {
	const allow = ["brian@actualvoice.ai", "max@actualvoice.ai"];

	it("accepts allowlisted sender with DKIM+SPF pass", () => {
		expect(decideAllowlist(msg({}), allow)).toEqual({ allowed: true });
	});

	it("rejects sender not on allowlist", () => {
		const r = decideAllowlist(msg({ from: "stranger@evil.com" }), allow);
		expect(r.allowed).toBe(false);
		if (!r.allowed) expect(r.reason).toMatch(/not on allowlist/i);
	});

	it("rejects allowlisted sender if DKIM fails — suspicious", () => {
		const r = decideAllowlist(msg({ dkimResult: "fail" }), allow);
		expect(r.allowed).toBe(false);
		if (!r.allowed) {
			expect(r.reason).toMatch(/dkim/i);
			expect(r.suspicious).toBe(true);
		}
	});

	it("rejects allowlisted sender if SPF fails — suspicious", () => {
		const r = decideAllowlist(msg({ spfResult: "fail" }), allow);
		expect(r.allowed).toBe(false);
		if (!r.allowed) expect(r.suspicious).toBe(true);
	});

	it("normalises case on allowlist entries", () => {
		expect(decideAllowlist(msg({ from: "Brian@ActualVoice.ai" }), allow).allowed).toBe(true);
	});
});
