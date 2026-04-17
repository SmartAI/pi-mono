import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRaw } from "../../src/gmail/parse.js";

const fixturesDir = join(fileURLToPath(new URL("../fixtures/emails/", import.meta.url)));

describe("parseRaw", () => {
	it("parses a plain message with auth results", async () => {
		const raw = await readFile(join(fixturesDir, "plain.eml"));
		const p = await parseRaw(raw, { threadId: "T-1" });
		expect(p.from).toBe("brian@actualvoice.ai");
		expect(p.subject).toBe("hello");
		expect(p.bodyText.trim()).toBe("this is the body");
		expect(p.dkimResult).toBe("pass");
		expect(p.spfResult).toBe("pass");
		expect(p.gmailMessageId).toBe("<m1@mail.example>");
	});

	it("keeps attachments as metadata only (caller writes them to disk)", async () => {
		const raw = await readFile(join(fixturesDir, "multipart-attach.eml"));
		const p = await parseRaw(raw, { threadId: "T-2" });
		expect(p.attachments).toHaveLength(1);
		expect(p.attachments[0].filename).toBe("note.txt");
		expect(p.bodyText.trim()).toBe("see attached");
	});

	it("strips quoted-history from reply bodies", async () => {
		const raw = await readFile(join(fixturesDir, "quoted-history.eml"));
		const p = await parseRaw(raw, { threadId: "T-3" });
		expect(p.bodyText.trim()).toBe("retake the screenshot please");
		expect(p.bodyText).not.toContain("here's the first screenshot");
	});
});
