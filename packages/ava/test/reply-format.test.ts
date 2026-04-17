import { describe, expect, it } from "vitest";
import { normalizeReply } from "../src/reply-format.js";

describe("normalizeReply", () => {
	it("passes short plain text through untouched", () => {
		expect(normalizeReply("hello world")).toBe("hello world");
	});

	it("strips ANSI escape codes", () => {
		const input = "\x1b[31mred\x1b[0m text";
		expect(normalizeReply(input)).toBe("red text");
	});

	it("truncates very long lines with an ellipsis marker", () => {
		const long = "x".repeat(30_000);
		const out = normalizeReply(long);
		expect(out.length).toBeLessThan(30_000);
		expect(out).toContain("[... 1 lines truncated");
	});

	it("preserves triple-backtick code fences", () => {
		const input = "see below:\n```js\nconst x = 1;\n```\n";
		expect(normalizeReply(input)).toBe(input);
	});

	it("trims long output blocks but keeps surrounding prose", () => {
		const block = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
		const input = `before\n${block}\nafter`;
		const out = normalizeReply(input);
		expect(out).toContain("before");
		expect(out).toContain("after");
		expect(out).toContain("lines truncated");
	});
});
