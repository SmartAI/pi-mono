import { describe, expect, it } from "vitest";
import { buildReplyRecipients } from "../src/agent-invoker.js";

const SELF = "claude@actualvoice.ai";

describe("buildReplyRecipients", () => {
	it("reply-all: sender → to, remaining recipients → cc, self is stripped", () => {
		const r = buildReplyRecipients(
			{
				from: "brian@actualvoice.ai",
				to: ["claude@actualvoice.ai", "max@actualvoice.ai"],
				cc: [],
			},
			SELF,
		);
		expect(r.to).toBe("brian@actualvoice.ai");
		expect(r.cc).toEqual(["max@actualvoice.ai"]);
	});

	it("handles both to and cc lists", () => {
		const r = buildReplyRecipients(
			{
				from: "brian@actualvoice.ai",
				to: ["claude@actualvoice.ai"],
				cc: ["max@actualvoice.ai", "someone-else@example.com"],
			},
			SELF,
		);
		expect(r.to).toBe("brian@actualvoice.ai");
		expect(r.cc).toEqual(["max@actualvoice.ai", "someone-else@example.com"]);
	});

	it("dedupes duplicate addresses across to/cc", () => {
		const r = buildReplyRecipients(
			{
				from: "brian@actualvoice.ai",
				to: ["claude@actualvoice.ai", "max@actualvoice.ai"],
				cc: ["max@actualvoice.ai", "brian@actualvoice.ai"],
			},
			SELF,
		);
		expect(r.to).toBe("brian@actualvoice.ai");
		expect(r.cc).toEqual(["max@actualvoice.ai"]);
	});

	it("empty cc when nobody else was on the thread", () => {
		const r = buildReplyRecipients({ from: "brian@actualvoice.ai", to: ["claude@actualvoice.ai"], cc: [] }, SELF);
		expect(r.to).toBe("brian@actualvoice.ai");
		expect(r.cc).toEqual([]);
	});

	it("case-insensitive address match for self detection", () => {
		const r = buildReplyRecipients(
			{
				from: "Brian@ActualVoice.ai",
				to: ["Claude@ActualVoice.AI", "Max@ActualVoice.ai"],
				cc: [],
			},
			SELF,
		);
		expect(r.to).toBe("brian@actualvoice.ai");
		expect(r.cc).toEqual(["max@actualvoice.ai"]);
	});

	describe("alwaysCc default (e.g. CC max@ on every reply to brian@)", () => {
		it("adds always-cc addresses to cc when not already present", () => {
			const r = buildReplyRecipients({ from: "brian@actualvoice.ai", to: ["claude@actualvoice.ai"], cc: [] }, SELF, [
				"max@actualvoice.ai",
			]);
			expect(r.to).toBe("brian@actualvoice.ai");
			expect(r.cc).toEqual(["max@actualvoice.ai"]);
		});

		it("does not add always-cc when recipient is the sender (avoid self-cc)", () => {
			const r = buildReplyRecipients({ from: "max@actualvoice.ai", to: ["claude@actualvoice.ai"], cc: [] }, SELF, [
				"max@actualvoice.ai",
			]);
			expect(r.to).toBe("max@actualvoice.ai");
			expect(r.cc).toEqual([]);
		});

		it("does not duplicate when always-cc is already on the original to/cc", () => {
			const r = buildReplyRecipients(
				{
					from: "brian@actualvoice.ai",
					to: ["claude@actualvoice.ai", "max@actualvoice.ai"],
					cc: [],
				},
				SELF,
				["max@actualvoice.ai"],
			);
			expect(r.cc).toEqual(["max@actualvoice.ai"]);
		});

		it("does not add self even if it's in always-cc by mistake", () => {
			const r = buildReplyRecipients({ from: "brian@actualvoice.ai", to: ["claude@actualvoice.ai"], cc: [] }, SELF, [
				"claude@actualvoice.ai",
				"max@actualvoice.ai",
			]);
			expect(r.cc).toEqual(["max@actualvoice.ai"]);
		});
	});
});
