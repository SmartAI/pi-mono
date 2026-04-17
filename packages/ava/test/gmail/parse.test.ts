import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRaw } from "../../src/gmail/parse.js";

const fixturesDir = join(fileURLToPath(new URL("../fixtures/emails/", import.meta.url)));

describe("parseRaw", () => {
	it("parses a plain message with auth results, empty cc", async () => {
		const raw = await readFile(join(fixturesDir, "plain.eml"));
		const p = await parseRaw(raw, { threadId: "T-1" });
		expect(p.from).toBe("brian@actualvoice.ai");
		expect(p.to).toContain("claude@actualvoice.ai");
		expect(p.cc).toEqual([]);
		expect(p.subject).toBe("hello");
		expect(p.bodyText.trim()).toBe("this is the body");
		expect(p.dkimResult).toBe("pass");
		expect(p.spfResult).toBe("pass");
		expect(p.gmailMessageId).toBe("<m1@mail.example>");
	});

	it("returns attachment metadata with 0 bytes when no dir given", async () => {
		const raw = await readFile(join(fixturesDir, "multipart-attach.eml"));
		const p = await parseRaw(raw, { threadId: "T-2" });
		expect(p.attachments).toHaveLength(1);
		expect(p.attachments[0].filename).toBe("note.txt");
		expect(p.attachments[0].path).toBe("");
		expect(p.bodyText.trim()).toBe("see attached");
	});

	describe("with attachmentsDir", () => {
		let dir: string;
		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "ava-parse-att-"));
		});
		afterEach(() => rmSync(dir, { recursive: true, force: true }));

		it("writes real attachment bytes to disk (not zero-byte placeholders)", async () => {
			const raw = await readFile(join(fixturesDir, "multipart-attach.eml"));
			const p = await parseRaw(raw, { threadId: "T-2", attachmentsDir: dir });
			expect(p.attachments).toHaveLength(1);
			const a = p.attachments[0];
			expect(a.filename).toBe("note.txt");
			expect(a.path).toBe(join(dir, "note.txt"));
			expect(a.bytes).toBeGreaterThan(0);
			const written = readFileSync(a.path, "utf-8");
			expect(written).toContain("payload-bytes");
		});
	});

	it("strips quoted-history from reply bodies", async () => {
		const raw = await readFile(join(fixturesDir, "quoted-history.eml"));
		const p = await parseRaw(raw, { threadId: "T-3" });
		expect(p.bodyText.trim()).toBe("retake the screenshot please");
		expect(p.bodyText).not.toContain("here's the first screenshot");
	});
});
